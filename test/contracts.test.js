import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, initSchema } from '../src/db.js';
import * as svc from '../src/service.js';
import { contractDigest, validateV2Bundle } from '../src/contracts.js';
import { freshDb, cleanup } from './helpers.js';

function boot() {
  const { dir, file } = freshDb();
  const db = openDb(file);
  initSchema(db);
  svc.ensureSeed(db);
  svc.seedDemoData(db);
  svc.publishContract(db, 1, { quiet: true });
  svc.publishContract(db, 2, { quiet: true });
  return { db, dir };
}

const v1sha = () => contractDigest(1).sha256;
const v2sha = () => contractDigest(2).sha256;

// Pinned so any edit to the v1 document fails loudly. v1 is the contract old
// consumers still read; changing it would silently change what they get.
const V1_SHA = 'c8b62556ae75d4adf03a2a5b8cc1c1732fe3a170438cd960b6063a5c06f6742c';
const V2_SHA = 'ef9e47cb27a4f854f4fe05849f633d2ab2d788fee7ce912d651889c2726d29d5';

test('v1 contract document is frozen', () => {
  const d = contractDigest(1);
  assert.equal(d.sha256, V1_SHA);
  assert.equal(d.contract.version, 1);
  assert.ok(d.contract.compatibility.immutable);
  const fields = Object.keys(d.contract.schema.properties);
  assert.deepEqual(fields, ['record_id', 'legacy_segment', 'ingested_at']);
});

test('v2 documents the absent / unknown split and forbids guessing', () => {
  const d = contractDigest(2);
  assert.equal(d.sha256, V2_SHA);
  const presence = d.contract.schema.properties.region_presence;
  assert.deepEqual(presence.enum, ['present', 'absent', 'unknown']);
  assert.ok(d.contract.invariants.some((i) => i.includes('unknown')));
});

test('v2 invariant check rejects null country with resolved status', () => {
  const errors = validateV2Bundle({
    contract_version: 2,
    contract_sha: v2sha(),
    items: [
      {
        record_id: 'r1',
        split_status: 'resolved',
        country_code: null,
        region_code: 'CA',
        region_presence: 'unknown',
        reason_code: '',
        provenance: 'derived',
        basis: '',
        source_hash: 'x',
      },
    ],
  }, { expectedSha: v2sha() });
  assert.ok(errors.length >= 3, errors.join('\n'));
});

test('v2 invariant check accepts a country-only projection', () => {
  const errors = validateV2Bundle({
    contract_version: 2,
    contract_sha: v2sha(),
    items: [
      {
        record_id: 'r1',
        split_status: 'resolved',
        country_code: 'US',
        region_code: null,
        region_presence: 'absent',
        reason_code: 'COUNTRY_ONLY',
        provenance: 'derived',
        basis: '国家码，无下级区划',
        source_hash: 'a'.repeat(64),
      },
    ],
  }, { expectedSha: v2sha() });
  assert.deepEqual(errors, []);
});

test('schema-declared patterns are actually enforced', () => {
  const base = {
    record_id: 'r1',
    split_status: 'resolved',
    country_code: 'US',
    region_code: 'CA',
    region_presence: 'present',
    reason_code: 'DIRECT_PAIR',
    provenance: 'derived',
    basis: 'ok',
    source_hash: 'a'.repeat(64),
  };
  const check = (patch) => validateV2Bundle({ contract_version: 2, items: [{ ...base, ...patch }] }, {});

  assert.deepEqual(check({}), []);
  assert.ok(check({ source_hash: 'not-a-hash' }).some((e) => e.includes('source_hash')));
  assert.ok(check({ source_hash: 'A'.repeat(64) }).some((e) => e.includes('source_hash')));
  assert.ok(check({ region_code: 'california' }).some((e) => e.includes('region_code')));
  assert.ok(check({ country_code: 'USA' }).some((e) => e.includes('country_code')));
});

test('a needs_review row cannot smuggle a half-guess next to its reason', () => {
  const errors = validateV2Bundle({
    contract_version: 2,
    items: [
      {
        record_id: 'r1',
        split_status: 'needs_review',
        country_code: 'US',
        region_code: null,
        region_presence: 'unknown',
        reason_code: 'BARE_CODE_COLLISION',
        provenance: 'derived',
        basis: '两种解释都成立',
        source_hash: 'a'.repeat(64),
      },
    ],
  }, {});
  assert.ok(errors.some((e) => e.includes('不得携带')), errors.join('\n'));
});

test('a consumer that has not switched receives an explicit rejection, not v2 data', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    const results = svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['geo-router'] });
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].code, 'NOT_SWITCHED');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('declaring a version without the right hash is not a switch', () => {
  const { db, dir } = boot();
  try {
    assert.throws(() => svc.switchConsumer(db, 'geo-router', { version: 2, sha: 'f'.repeat(64) }), /不一致/);
    assert.throws(() => svc.switchConsumer(db, 'legacy-ledger', { version: 2, sha: v2sha() }), /不支持/);
    const geo = svc.listConsumers(db).find((c) => c.id === 'geo-router');
    assert.equal(geo.contract_version, null);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('capability check parses the version array instead of substring-matching it', () => {
  const { db, dir } = boot();
  try {
    // A capability list of [12] does not include v2, but the string "[12]"
    // contains the character "2". Substring matching would wrongly allow this.
    db.prepare("UPDATE consumers SET supported_versions = '[12]' WHERE id = 'geo-router'").run();
    assert.throws(() => svc.switchConsumer(db, 'geo-router', { version: 2, sha: v2sha() }), /不支持/);
    const geo = svc.listConsumers(db).find((c) => c.id === 'geo-router');
    assert.equal(geo.contract_version, null);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('lateness is derived from the stored timestamps', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    svc.switchConsumer(db, 'legacy-ledger', { version: 1, sha: v1sha() });
    svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['legacy-ledger'] });
    const delivery = db.prepare("SELECT * FROM deliveries WHERE consumer_id = 'legacy-ledger'").get();

    // An ack that lands within the window is not late, even if the caller
    // passed a value; the timestamps are the source of truth.
    const onTime = svc.acknowledgeDelivery(db, delivery.id, { simulatedLateMinutes: 5 });
    assert.equal(onTime.late, false);
    assert.equal(onTime.lagMinutes, 5);

    const late = svc.acknowledgeDelivery(db, delivery.id, { simulatedLateMinutes: 300 });
    assert.equal(late.late, true);
    assert.equal(late.lagMinutes, 300);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('v1 consumer keeps receiving the untouched legacy value even when v2 is withheld', () => {
  const { db, dir } = boot();
  try {
    const offline = svc.listBatches(db).find((b) => b.label.startsWith('离线'));
    svc.startBackfill(db, { label: offline.label });
    svc.switchConsumer(db, 'legacy-ledger', { version: 1, sha: v1sha() });
    svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });

    const results = svc.deliverConsumers(db, {
      batchId: offline.id,
      consumerIds: ['legacy-ledger', 'risk-scoring'],
    });
    const v1 = results.find((r) => r.consumer === 'legacy-ledger');
    const v2 = results.find((r) => r.consumer === 'risk-scoring');
    assert.equal(v1.status, 'delivered');
    assert.equal(v1.rowCount, offline.record_count);
    assert.equal(v2.status, 'rejected');
    assert.ok(['BATCH_ON_HOLD', 'BACKFILL_INCOMPLETE', 'LOSSY_VALUES_PRESENT'].includes(v2.code), v2.code);

    const delivery = db
      .prepare("SELECT payload FROM deliveries WHERE batch_id = ? AND contract_version = 1")
      .get(offline.id);
    const payload = JSON.parse(delivery.payload);
    assert.ok(payload.some((row) => row.legacy_segment === 'US-CA;US-NV'));
    assert.ok(payload.some((row) => row.legacy_segment === ''));
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a needs_review record is delivered to a lenient v2 consumer as quarantined, never as null data', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });
    const result = svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['risk-scoring'] })[0];
    assert.equal(result.status, 'delivered');
    assert.ok(result.quarantined >= 1);

    const row = db
      .prepare("SELECT * FROM records WHERE batch_id = ? AND legacy_segment = 'CA'")
      .get(crm.id);
    const delivery = db
      .prepare('SELECT payload FROM deliveries WHERE batch_id = ? AND consumer_id = ?')
      .get(crm.id, 'risk-scoring');
    const item = JSON.parse(delivery.payload).items.find((i) => i.record_id === row.id);
    assert.equal(item.split_status, 'needs_review');
    assert.equal(item.region_presence, 'unknown');
    assert.notEqual(item.country_code, 'CA', 'must not pick one interpretation silently');
    assert.ok(item.basis.length > 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('late acknowledgement never changes subscription state', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    svc.switchConsumer(db, 'legacy-ledger', { version: 1, sha: v1sha() });
    svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['legacy-ledger'] });
    const delivery = db.prepare("SELECT * FROM deliveries WHERE consumer_id = 'legacy-ledger'").get();
    const before = svc.listConsumers(db).find((c) => c.id === 'legacy-ledger');

    const ack = svc.acknowledgeDelivery(db, delivery.id, { simulatedLateMinutes: 300, note: '夜间批处理' });
    assert.equal(ack.late, true);

    const after = svc.listConsumers(db).find((c) => c.id === 'legacy-ledger');
    assert.deepEqual(after, before);
    assert.ok(ack.delivery.acked_at > ack.delivery.delivered_at);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('backfill interruption and resume project every record exactly once', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    const run = svc.startBackfill(db, { label: crm.label, interruptAfter: 7 });
    assert.equal(run.status, 'interrupted');
    assert.equal(run.processed_count, 7);

    const projectedAtBreak = db
      .prepare('SELECT id, projection_rev FROM records WHERE batch_id = ? AND split_status IS NOT NULL ORDER BY seq')
      .all(crm.id);
    assert.equal(projectedAtBreak.length, 7);

    const resumed = svc.resumeBackfill(db, run.id);
    assert.equal(resumed.status, 'complete');
    assert.equal(resumed.processed_count, crm.record_count);
    assert.equal(resumed.remaining, 0);

    const rows = db
      .prepare('SELECT id, projection_rev, projection_hash, split_status FROM records WHERE batch_id = ? ORDER BY seq')
      .all(crm.id);
    assert.equal(rows.length, crm.record_count);
    assert.ok(rows.every((r) => r.split_status !== null));
    assert.ok(rows.every((r) => r.projection_rev === 1), 'no record may be projected twice');
    // The 7 records written before the break must be byte-identical after resume.
    for (const before of projectedAtBreak) {
      const after = rows.find((r) => r.id === before.id);
      assert.equal(after.projection_rev, before.projection_rev);
    }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('an operator decision changes provenance and survives recomputation, and can be withdrawn', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    const record = db.prepare("SELECT * FROM records WHERE batch_id = ? AND legacy_segment = 'CA'").get(crm.id);
    svc.applyDecision(db, record.id, {
      choice: { countryCode: 'US', regionCode: 'CA', regionPresence: 'present' },
      reason: '来源系统字典确认该字段只存 US 州码',
    });
    let updated = svc.getRecord(db, record.id);
    assert.equal(updated.split_status, 'resolved');
    assert.equal(updated.country_code, 'US');
    assert.equal(updated.provenance, 'operator');
    assert.match(updated.basis, /来源系统字典确认/);

    svc.clearDecision(db, record.id);
    updated = svc.getRecord(db, record.id);
    assert.equal(updated.split_status, 'needs_review');
    // Withdrawing a judgement falls back to a rule-derived outcome, never to
    // `legacy` — the row is still projected, so it is still derived.
    assert.equal(updated.provenance, 'derived');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('no v2 payload ever carries provenance=legacy', () => {
  const { db, dir } = boot();
  try {
    for (const batch of svc.listBatches(db)) {
      svc.startBackfill(db, { label: batch.label });
      const bundle = svc.buildV2Bundle(db, batch.id);
      assert.deepEqual(validateV2Bundle(bundle, { expectedSha: bundle.contract_sha }), []);
      for (const item of bundle.items) {
        assert.notEqual(item.provenance, 'legacy', `${item.record_id} leaked unprojected provenance into v2`);
      }
    }
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('redelivering a changed payload clears the stale acknowledgement', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });
    svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['risk-scoring'] });

    const first = db.prepare("SELECT * FROM deliveries WHERE consumer_id = 'risk-scoring'").get();
    svc.acknowledgeDelivery(db, first.id, { note: '已核对' });
    const acked = db.prepare('SELECT acked_at FROM deliveries WHERE id = ?').get(first.id);
    assert.ok(acked.acked_at);

    // An operator resolves one of the ambiguous rows, so the v2 payload changes.
    const record = db.prepare("SELECT * FROM records WHERE batch_id = ? AND legacy_segment = 'CA'").get(crm.id);
    svc.applyDecision(db, record.id, {
      choice: { countryCode: 'US', regionCode: 'CA', regionPresence: 'present' },
      reason: '来源系统字典确认该字段只存 US 州码',
    });
    svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['risk-scoring'] });

    const again = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(first.id);
    assert.notEqual(again.payload_hash, first.payload_hash, 'payload must have changed');
    assert.equal(again.acked_at, null, 'the old ack was for the old bytes');
    assert.equal(again.ack_note, null);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a contradictory operator decision is refused instead of poisoning the bundle', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    const record = db.prepare("SELECT * FROM records WHERE batch_id = ? AND legacy_segment = 'CA'").get(crm.id);
    const reason = '来源系统字典确认';

    // region_code set but presence says "there is no region".
    assert.throws(
      () => svc.applyDecision(db, record.id, {
        choice: { countryCode: 'US', regionCode: 'CA', regionPresence: 'absent' },
        reason,
      }),
      /矛盾/,
    );
    // A human decision must be definite; unknown is what needs_review is for.
    assert.throws(
      () => svc.applyDecision(db, record.id, {
        choice: { countryCode: 'US', regionCode: 'CA', regionPresence: 'unknown' },
        reason,
      }),
      /确定结果/,
    );
    // No region code but presence claims one exists.
    assert.throws(
      () => svc.applyDecision(db, record.id, {
        choice: { countryCode: 'US', regionCode: null, regionPresence: 'present' },
        reason,
      }),
      /absent/,
    );

    // No decision row was written, so the record is still unprojected and the
    // bundle still validates.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE record_id = ?').get(record.id).n, 0);
    assert.equal(svc.getRecord(db, record.id).split_status, null);
    svc.startBackfill(db, { label: crm.label });
    const bundle = svc.buildV2Bundle(db, crm.id);
    assert.deepEqual(validateV2Bundle(bundle, { expectedSha: bundle.contract_sha }), []);

    // Omitting presence is normalised from the region code rather than guessed.
    svc.applyDecision(db, record.id, { choice: { countryCode: 'US', regionCode: 'CA' }, reason });
    const fixed = svc.getRecord(db, record.id);
    assert.equal(fixed.provenance, 'operator');
    assert.equal(fixed.region_presence, 'present');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('batch policy does not overwrite an existing individual decision', () => {
  const { db, dir } = boot();
  try {
    const risk = svc.listBatches(db).find((b) => b.label.startsWith('风险'));
    const first = db.prepare('SELECT * FROM records WHERE batch_id = ? ORDER BY seq LIMIT 1').get(risk.id);
    svc.applyDecision(db, first.id, {
      choice: { countryCode: 'CA', regionCode: null, regionPresence: 'absent' },
      reason: '该行来自加拿大客户的单独表单',
    });
    const { applied, skipped } = svc.applyBatchPolicy(db, risk.id, {
      policyRule: 'bare-as-us-state',
      reason: '该仓库 2019 年起该字段只存美国州码，运维台账可查',
    });
    assert.equal(skipped.length, 1);
    assert.equal(applied.length, risk.record_count - 1);
    const kept = svc.getRecord(db, first.id);
    assert.equal(kept.country_code, 'CA');
    assert.match(kept.decision.reason, /加拿大客户/);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('preflight is read-only and repeatable', () => {
  const { db, dir } = boot();
  try {
    const batch = svc.listBatches(db)[2];
    const before = db.prepare('SELECT id, projection_rev FROM records WHERE batch_id = ? ORDER BY seq').all(batch.id);
    const r1 = svc.runPreflight(db, batch.id);
    const r2 = svc.runPreflight(db, batch.id);
    const after = db.prepare('SELECT id, projection_rev FROM records WHERE batch_id = ? ORDER BY seq').all(batch.id);
    assert.deepEqual(after, before);
    assert.equal(r1.total, r2.total);
    assert.deepEqual(r1.reason_counts, r2.reason_counts);
    assert.ok(r1.items.every((i) => i.basis.length > 0));
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('blocking preserves existing projections and can be undone', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    const resolved = db
      .prepare("SELECT * FROM records WHERE batch_id = ? AND legacy_segment = 'US-CA'")
      .get(crm.id);
    assert.equal(resolved.split_status, 'resolved');

    svc.blockBatch(db, crm.id, { reason: '法务要求暂停该来源' });
    // A resolved row keeps its projection and basis: blocking the batch is a
    // delivery decision, not a licence to erase what the rules established.
    const after = db.prepare('SELECT * FROM records WHERE id = ?').get(resolved.id);
    assert.equal(after.split_status, 'resolved');
    assert.equal(after.country_code, 'US');
    assert.equal(after.basis, resolved.basis);
    // Rows that still needed a decision are marked, so the reason is per-row.
    const review = db
      .prepare("SELECT * FROM records WHERE batch_id = ? AND legacy_segment = 'CA'")
      .get(crm.id);
    assert.equal(review.split_status, 'blocked');
    assert.equal(review.reason_code, 'BATCH_BLOCKED');

    assert.throws(() => svc.blockBatch(db, crm.id, { reason: '再次阻断' }), /已被阻断/);

    svc.unblockBatch(db, crm.id, { reason: '法务已放行' });
    assert.equal(svc.getBatch(db, crm.id).blocked_at, null);
    const restored = db.prepare("SELECT * FROM records WHERE id = ?").get(review.id);
    assert.equal(restored.split_status, 'needs_review', 'the block-marked row returns to its rule result');
    assert.equal(restored.reason_code, 'BARE_CODE_COLLISION');
    assert.equal(restored.provenance, 'derived');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('batch block withholds v2 but leaves v1 deliverable and the legacy column untouched', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    const legacyBefore = db.prepare('SELECT id, legacy_segment FROM records WHERE batch_id = ? ORDER BY seq').all(crm.id);
    svc.blockBatch(db, crm.id, { reason: '法务要求暂停该来源' });
    svc.switchConsumer(db, 'geo-router', { version: 2, sha: v2sha() });
    svc.switchConsumer(db, 'legacy-ledger', { version: 1, sha: v1sha() });
    const results = svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['geo-router', 'legacy-ledger'] });
    assert.equal(results.find((r) => r.consumer === 'geo-router').code, 'BATCH_BLOCKED');
    assert.equal(results.find((r) => r.consumer === 'legacy-ledger').status, 'delivered');
    const legacyAfter = db.prepare('SELECT id, legacy_segment FROM records WHERE batch_id = ? ORDER BY seq').all(crm.id);
    assert.deepEqual(legacyAfter, legacyBefore);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('an empty or failing ingest leaves no half-created batch behind', () => {
  const { db, dir } = boot();
  try {
    const before = svc.listBatches(db).length;
    assert.throws(() => svc.ingestBatch(db, { label: '空批次', origin: 'test', values: [] }), /没有记录/);
    assert.equal(svc.listBatches(db).length, before, 'a refused batch must not be persisted');

    // The successful path still creates the whole batch: rows, preflight, event.
    const id = svc.ingestBatch(db, { label: '正常批次', origin: 'test', values: ['US-CA', 'CA', 'N/A'] });
    const batch = svc.getBatch(db, id);
    assert.equal(batch.record_count, 3);
    assert.ok(svc.getPreflight(db, id), 'ingest preflights before returning');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE detail LIKE ?').get(`%${id}%`).n > 0, true);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a contract whose current digest differs from its published record is reported as drifted', () => {
  const { db, dir } = boot();
  try {
    const published = db.prepare('SELECT sha256, published_at FROM contracts WHERE version = 2').get();
    assert.equal(published.sha256, v2sha(), 'boot publishes the current document');

    // A restart republishes byte-identical content: the record must not be
    // rewritten, so nobody can claim the contract "changed" because a process
    // was restarted.
    const same = svc.ensureContractPublished(db, 2);
    assert.equal(same.status, 'published');
    assert.equal(same.unchanged, true);
    assert.equal(db.prepare('SELECT published_at FROM contracts WHERE version = 2').get().published_at, published.published_at);

    // Simulate a published record that no longer matches the code: the exact
    // situation where a consumer confirmed one document and the service would
    // now send another.
    db.prepare("UPDATE contracts SET sha256 = 'deadbeef' WHERE version = 2").run();
    const row = db.prepare('SELECT sha256 FROM contracts WHERE version = 2').get();
    assert.equal(row.sha256, 'deadbeef');
    assert.notEqual(row.sha256, contractDigest(2).sha256);

    // Boot must NOT quietly repair it: that would turn a pending re-confirmation
    // into a silent contract swap for every already-switched consumer.
    const booted = svc.ensureContractPublished(db, 2);
    assert.equal(booted.status, 'drifted');
    assert.equal(booted.unchanged, false);
    assert.equal(db.prepare('SELECT sha256 FROM contracts WHERE version = 2').get().sha256, 'deadbeef');

    // And a consumer cannot "confirm" a contract whose published record is not
    // the document it would receive.
    assert.throws(() => svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() }), /不一致/);

    // Republishing repairs the record, and is reported as a content change.
    const result = svc.publishContract(db, 2, { quiet: true });
    assert.equal(result.sha256, v2sha());
    assert.equal(result.unchanged, false, 'a drifted record must not be reported as unchanged');
    assert.equal(db.prepare('SELECT sha256 FROM contracts WHERE version = 2').get().sha256, v2sha());
    // Only now is the switch meaningful.
    const switched = svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });
    assert.equal(switched.contract_sha, v2sha());
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a consumer that confirmed an older document is refused instead of silently upgraded', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { label: crm.label });
    svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });
    svc.switchConsumer(db, 'legacy-ledger', { version: 1, sha: v1sha() });

    // The contract a consumer already confirmed is changed after the fact. Its
    // stored contract_sha is now stale even though its version number is not.
    db.prepare("UPDATE consumers SET contract_sha = ? WHERE id IN ('risk-scoring', 'legacy-ledger')").run('a'.repeat(64));
    const results = svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['risk-scoring', 'legacy-ledger'] });
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.code, 'CONTRACT_CHANGED', `${result.consumer} must not receive a contract it never confirmed`);
    }
    // A version number is not evidence of the bytes; no payload was stored.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE batch_id = ? AND status = ?').get(crm.id, 'delivered').n, 0);
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a stored confirmation is reported as stale once its document changes', () => {
  const { db, dir } = boot();
  try {
    svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });
    let consumer = svc.listConsumers(db).find((c) => c.id === 'risk-scoring');
    assert.equal(consumer.switch_confirmed, true);
    assert.equal(consumer.switch_stale, false);

    // The published record changing does not by itself make the confirmation
    // stale: staleness is measured against the document a delivery would carry.
    db.prepare('UPDATE contracts SET sha256 = ? WHERE version = 2').run('c'.repeat(64));
    consumer = svc.listConsumers(db).find((c) => c.id === 'risk-scoring');
    assert.equal(consumer.switch_stale, false, 'staleness is about the delivered document, not the published row');

    // What actually makes it stale is a stored hash that no longer matches the
    // document the service would send under that version number.
    db.prepare('UPDATE consumers SET contract_sha = ? WHERE id = ?').run('d'.repeat(64), 'risk-scoring');
    consumer = svc.listConsumers(db).find((c) => c.id === 'risk-scoring');
    assert.equal(consumer.switch_stale, true);
    assert.equal(consumer.switch_confirmed, false);
    assert.equal(consumer.contract_sha, 'd'.repeat(64), 'the audit value is preserved');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('backfill targets a batch id, not an ambiguous display label', () => {
  const { db, dir } = boot();
  try {
    // Labels are not identifiers: two real imports can share one. A lookup by
    // label would silently backfill the first and leave the second untouched.
    const first = svc.ingestBatch(db, { label: '月度对账', origin: 'crm', values: ['US-CA'] });
    const second = svc.ingestBatch(db, { label: '月度对账', origin: 'crm', values: ['FR', 'JP-13'] });
    assert.throws(() => svc.startBackfill(db, { label: '月度对账' }), /必须指定批次 id/);

    const run = svc.startBackfill(db, { batchId: second });
    assert.equal(run.target_batch, second);
    const projected = (id) => db.prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND split_status IS NOT NULL').get(id).n;
    assert.equal(projected(second), 2);
    assert.equal(projected(first), 0, 'the same-labelled sibling must not be touched');

    // Two runs over one batch would split the progress accounting in two, so a
    // second start is refused while the first is still running/interrupted.
    const third = svc.ingestBatch(db, { label: '月度对账', origin: 'crm', values: ['US-TX', 'US-NY', 'FR'] });
    const interrupted = svc.startBackfill(db, { batchId: third, interruptAfter: 1 });
    assert.equal(interrupted.status, 'interrupted');
    assert.throws(() => svc.startBackfill(db, { batchId: third }), /已有未完成的回填/);
    svc.resumeBackfill(db, interrupted.id);
    assert.equal(svc.summarizeRun(db, db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(interrupted.id)).status, 'complete');
    svc.startBackfill(db, { batchId: first });
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('a v2 hold records its reason and quotes it in the rejection', () => {
  const { db, dir } = boot();
  try {
    const crm = svc.listBatches(db)[0];
    svc.startBackfill(db, { batchId: crm.id });
    svc.switchConsumer(db, 'risk-scoring', { version: 2, sha: v2sha() });
    svc.setBatchHold(db, crm.id, { hold: true, reason: '上游确认该文件是旧版导出，等待重发' });
    assert.equal(svc.getBatch(db, crm.id).hold_reason, '上游确认该文件是旧版导出，等待重发');

    const rejected = svc.deliverConsumers(db, { batchId: crm.id, consumerIds: ['risk-scoring'] })[0];
    assert.equal(rejected.code, 'BATCH_ON_HOLD');
    assert.match(rejected.detail, /等待重发/, 'the consumer sees the actual reason, not a generic hold message');

    svc.setBatchHold(db, crm.id, { hold: false, reason: '新文件已到' });
    assert.equal(svc.getBatch(db, crm.id).hold_reason, null, 'releasing clears the stale reason');
  } finally {
    db.close();
    cleanup(dir);
  }
});

test('pasted blank lines are formatting, but an explicit empty value is a record', () => {
  // A textarea with a trailing newline is the normal way people paste. That
  // must not become a record that blocks the whole batch.
  assert.deepEqual(svc.parseIngestValues({ raw: 'US-CA\nCA\n\n' }), ['US-CA', 'CA']);
  // An explicit array is a list of values; "" there is a real missing value,
  // and the splitter must get the chance to block it.
  assert.deepEqual(svc.parseIngestValues({ values: ['US-CA', ''] }), ['US-CA', '']);
  // A line with only a space is content: the splitter records WHITESPACE_TRIMMED
  // or NO_VALUE for it. Only a genuinely empty line is dropped.
  assert.deepEqual(svc.parseIngestValues({ raw: '\n \n' }), [' ']);
  // Whitespace inside a pasted line is preserved so the source's quirk stays
  // visible in the audit trail.
  assert.deepEqual(svc.parseIngestValues({ raw: ' US-CA ' }), [' US-CA ']);
  assert.throws(() => svc.parseIngestValues({ values: [] }), /没有可接入的值/);
  // limit applies after parsing, so a limit of 2 on two pasted lines is not an
  // accidental extra blank record.
  assert.deepEqual(svc.parseIngestValues({ raw: 'A\nB\nC\n', limit: 2 }), ['A', 'B']);
});
