import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, initSchema, listEvents, DEFAULT_DB_PATH } from './db.js';
import { CONTRACT_DIFF, CONTRACTS, contractDigest } from './contracts.js';
import { POLICY, REASONS, RECORD_STATUS, BARE_COLLISIONS, reasonLabel } from './catalog.js';
import * as svc from './service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 4173);
const DB_PATH = process.env.LAB_DB ?? DEFAULT_DB_PATH;

const db = openDb(DB_PATH);
initSchema(db);
svc.ensureSeed(db);
if (svc.listBatches(db).length === 0) {
  svc.seedDemoData(db);
  svc.bootstrapDemo(db);
}
// The contract record is written once, not on every boot: a restart must not be
// able to redefine what existing consumers already confirmed. A genuine change
// is published explicitly from the contracts view.
svc.ensureContractPublished(db, 1);
svc.ensureContractPublished(db, 2);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function fail(res, error) {
  const status = error.status ?? 400;
  json(res, status, { error: error.message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

const contractMeta = (version) => {
  const digest = contractDigest(version);
  // `sha256` is what a delivery would carry right now, because the payload is
  // built from the code. The `published_*` fields are what the audit trail says
  // was handed to consumers. They should agree — `publishContract` writes this
  // row — and when they do not, the page must say so instead of showing only
  // the current digest and letting a changed contract look unchanged.
  const row = db.prepare('SELECT sha256, status, published_at FROM contracts WHERE version = ?').get(version);
  return {
    version,
    contract_id: digest.contract.contract_id,
    title: digest.contract.title,
    summary: digest.contract.summary,
    sha256: digest.sha256,
    published_sha256: row?.sha256 ?? null,
    published_status: row ? (row.sha256 === digest.sha256 ? 'published' : 'drifted') : 'unpublished',
    published_at: row?.published_at ?? null,
    status_semantics: digest.contract.status_semantics,
    invariants: digest.contract.invariants ?? [],
    compatibility: digest.contract.compatibility,
    schema: digest.contract.schema,
    document: digest.contract,
  };
};

function statePayload() {
  const batches = svc.listBatches(db).map((batch) => {
    const stats = svc.batchProjectionStats(db, batch.id);
    const preflight = svc.getPreflight(db, batch.id);
    return {
      ...batch,
      stats,
      backfillProgress: batch.record_count === 0 ? 0 : (batch.record_count - stats.pending) / batch.record_count,
      preflight: preflight
        ? {
            verdict: preflight.verdict,
            review_share: preflight.review_share,
            review: preflight.review,
            blocked: preflight.blocked,
            resolved: preflight.resolved,
            total: preflight.total,
            run_at: preflight.run_at,
            decisions_since: svc.preflightDrift(db, batch.id).decisions_since,
            projections_since: svc.preflightDrift(db, batch.id).projections_since,
            ruleset_changed: svc.preflightDrift(db, batch.id).ruleset_changed,
          }
        : null,
      deliveries: svc.listDeliveries(db, batch.id),
    };
  });

  const totals = batches.reduce(
    (acc, b) => {
      acc.records += b.record_count;
      acc.resolved += b.byStatus.resolved;
      acc.review += b.byStatus.needs_review;
      acc.blocked += b.byStatus.blocked;
      return acc;
    },
    { records: 0, resolved: 0, review: 0, blocked: 0 },
  );
  const projected = totals.resolved + totals.review + totals.blocked;
  const v2Switched = svc.listConsumers(db).filter((c) => c.contract_version === 2 && c.contract_sha);

  return {
    now: new Date().toISOString(),
    migration_id: 'pointwise.segment',
    policy: POLICY,
    totals: { ...totals, pending: Math.max(0, totals.records - projected) },
    batches,
    consumers: svc.listConsumers(db),
    contracts: [contractMeta(1), contractMeta(2)],
    contract_diff: CONTRACT_DIFF,
    reasons: Object.fromEntries(Object.entries(REASONS).map(([code, v]) => [code, v.zh])),
    events: listEvents(db, 60).filter((e) => e.kind !== 'backfill.step').slice(0, 14),
    backfill_step_count: db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'backfill.step'").get().n,
    backfills: svc.listBackfills(db),
    collision_examples: [...BARE_COLLISIONS].slice(0, 8),
    db_path: DB_PATH,
    v2_ready: v2Switched.map((c) => c.id),
  };
}

const routes = [
  ['GET', /^\/api\/state$/, () => statePayload()],

  ['POST', /^\/api\/reset$/, () => {
    svc.resetAll(db);
    svc.seedDemoData(db);
    svc.publishContract(db, 1, { quiet: true });
    svc.publishContract(db, 2, { quiet: true });
    svc.bootstrapDemo(db);
    return statePayload();
  }],

  ['GET', /^\/api\/contracts$/, () => [contractMeta(1), contractMeta(2)]],

  ['GET', /^\/api\/batches\/([^/]+)\/preflight$/, (_m, batchId) => {
    const report = svc.getPreflight(db, batchId);
    if (!report) throw Object.assign(new Error('该批次尚未预检'), { status: 404 });
    return { report, drift: svc.preflightDrift(db, batchId), stats: svc.batchProjectionStats(db, batchId) };
  }],

  ['POST', /^\/api\/contracts\/(\d+)\/publish$/, (_m, version) => {
    const result = svc.publishContract(db, Number(version));
    return { published: result, state: statePayload() };
  }],

  ['GET', /^\/api\/batches\/([^/]+)\/records$/, (_m, batchId) => {
    const batch = svc.getBatch(db, batchId);
    if (!batch) throw Object.assign(new Error('批次不存在'), { status: 404 });
    return {
      batch,
      records: svc.listRecords(db, batchId),
      deliveries: svc.listDeliveries(db, batchId),
    };
  }],

  ['POST', /^\/api\/batches\/([^/]+)\/preflight$/, (_m, batchId) => {
    const report = svc.runPreflight(db, batchId);
    return { report, state: statePayload() };
  }],

  ['POST', /^\/api\/ingest$/, async (_m, _a, body) => {
    const label = String(body.label ?? '').trim();
    const origin = String(body.origin ?? 'manual.paste').trim();
    if (!label) throw new Error('批次需要标签');
    const values = svc.parseIngestValues({ values: body.values, raw: body.raw, limit: body.limit });
    const id = svc.ingestBatch(db, { label, origin, values });
    return { batch_id: id, report: svc.runPreflight(db, id), state: statePayload() };
  }],

  ['POST', /^\/api\/validate-item$/, (_m, _a, body) => ({
    errors: svc.validateSingleItem(body.item ?? {}),
    contract: contractMeta(2).contract_id,
    contract_sha: contractMeta(2).sha256,
    note: '这是消费端在不了解来源时应执行的校验：字段形状、null 与 presence 的一致性、source_hash 是否都在。',
  })],

  ['POST', /^\/api\/records\/([^/]+)\/decision$/, (_m, recordId, body) => {
    const result = svc.applyDecision(db, recordId, body);
    return { ...result, state: statePayload() };
  }],

  ['POST', /^\/api\/records\/([^/]+)\/decision\/clear$/, (_m, recordId) => {
    svc.clearDecision(db, recordId);
    return { state: statePayload() };
  }],

  ['POST', /^\/api\/batches\/([^/]+)\/policy$/, (_m, batchId, body) => {
    const result = svc.applyBatchPolicy(db, batchId, body);
    return { ...result, state: statePayload() };
  }],

  ['POST', /^\/api\/batches\/([^/]+)\/block$/, (_m, batchId, body) => {
    svc.blockBatch(db, batchId, body);
    return { state: statePayload() };
  }],

  ['POST', /^\/api\/batches\/([^/]+)\/unblock$/, (_m, batchId, body) => {
    svc.unblockBatch(db, batchId, body);
    return { state: statePayload() };
  }],

  ['POST', /^\/api\/batches\/([^/]+)\/hold$/, (_m, batchId, body) => {
    svc.setBatchHold(db, batchId, body);
    return { state: statePayload() };
  }],

  ['POST', /^\/api\/backfills$/, (_m, _a, body) => {
    const run = svc.startBackfill(db, {
      batchId: body.batchId ? String(body.batchId) : null,
      // Fall back to the label only for callers that predate batch ids; the
      // service refuses an ambiguous label rather than picking one silently.
      label: body.batchId ? null : String(body.label ?? ''),
      interruptAfter: body.interruptAfter == null ? null : Number(body.interruptAfter),
    });
    return { run, state: statePayload() };
  }],

  ['POST', /^\/api\/backfills\/([^/]+)\/step$/, (_m, runId) => {
    const run = svc.stepBackfill(db, runId);
    return { run, state: statePayload() };
  }],

  ['POST', /^\/api\/backfills\/([^/]+)\/resume$/, (_m, runId) => {
    const run = svc.resumeBackfill(db, runId);
    return { run, state: statePayload() };
  }],

  ['POST', /^\/api\/consumers\/([^/]+)\/switch$/, (_m, consumerId, body) => {
    const consumer = svc.switchConsumer(db, consumerId, {
      version: Number(body.version),
      sha: String(body.sha ?? ''),
      actor: body.actor,
    });
    return { consumer, state: statePayload() };
  }],

  ['POST', /^\/api\/batches\/([^/]+)\/deliver$/, (_m, batchId, body) => {
    const results = svc.deliverConsumers(db, {
      batchId,
      consumerIds: Array.isArray(body.consumerIds) ? body.consumerIds : [],
      override: Boolean(body.override),
    });
    return { results, state: statePayload() };
  }],

  ['POST', /^\/api\/deliveries\/([^/]+)\/ack$/, (_m, deliveryId, body) => {
    const result = svc.acknowledgeDelivery(db, deliveryId, {
      note: String(body.note ?? ''),
      simulatedLateMinutes: Number(body.simulatedLateMinutes ?? 0),
      actor: body.actor,
    });
    return { ...result, state: statePayload() };
  }],

  ['GET', /^\/api\/deliveries\/([^/]+)$/, (_m, deliveryId) => {
    const row = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
    if (!row) throw Object.assign(new Error('投递不存在'), { status: 404 });
    return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
  }],

  ['GET', /^\/api\/records\/([^/]+)\/trace$/, (_m, recordId) => {
    const record = svc.getRecord(db, recordId);
    if (!record) throw Object.assign(new Error('记录不存在'), { status: 404 });
    const batch = svc.getBatch(db, record.batch_id);
    const deliveries = svc.listDeliveries(db, record.batch_id);
    const v1 = deliveries.find((d) => d.contract_version === 1 && d.status === 'delivered');
    const v2 = deliveries.find((d) => d.contract_version === 2 && d.status === 'delivered');
    const readItem = (delivery) => {
      if (!delivery) return null;
      const payload = delivery.payload ? JSON.parse(delivery.payload) : null;
      if (!payload) return null;
      const items = Array.isArray(payload) ? payload : payload.items;
      return items.find((i) => i.record_id === recordId) ?? null;
    };
    const v2Bundle = svc.buildV2Bundle(db, record.batch_id);
    return {
      record,
      batch,
      v1_item: readItem(v1),
      v2_item: readItem(v2),
      // What each contract would deliver for this record right now. Without it a
      // freshly seeded lab (no deliveries yet) shows nothing, which makes the
      // "actual value in each contract" question unanswerable.
      v1_preview: {
        record_id: record.id,
        legacy_segment: record.legacy_segment,
        ingested_at: record.ingested_at,
      },
      v2_preview: v2Bundle.items.find((i) => i.record_id === recordId) ?? null,
      v2_preview_exclusion: v2Bundle.exclusions.find((e) => e.record_id === recordId) ?? null,
      contract_sha: { 1: contractDigest(1).sha256, 2: contractDigest(2).sha256 },
      v2_exclusion: (() => {
        if (!v2) return null;
        const payload = v2.payload ? JSON.parse(v2.payload) : null;
        return payload?.exclusions?.find((e) => e.record_id === recordId) ?? null;
      })(),
      preflight_item: (() => {
        const pf = svc.getPreflight(db, record.batch_id);
        return pf?.items.find((i) => i.record_id === recordId) ?? null;
      })(),
      deliveries,
    };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const match = pathname.match(pattern);
        if (!match) continue;
        const body = method === 'POST' ? await readBody(req) : {};
        const result = await handler(match, match[1], body);
        return json(res, 200, result);
      }
      return json(res, 404, { error: '未知接口' });
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(fs.readFileSync(file));
  } catch (error) {
    fail(res, error);
  }
});

server.listen(PORT, () => {
  console.log(`split-field contract lab → http://localhost:${PORT}`);
  console.log(`db: ${DB_PATH}`);
});
