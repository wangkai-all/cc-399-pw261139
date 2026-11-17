import { appendEvent, canonicalJson, nowIso, sha256, shortId, transaction } from './db.js';
import { POLICY, RECORD_STATUS, reasonLabel, ruleSetFingerprint, severityOf } from './catalog.js';
import { splitLegacySegment } from './splitter.js';
import { CONTRACT_V1, CONTRACT_V2, contractDigest, validateV2Bundle } from './contracts.js';

// ---------- settings / consumers / contracts ----------

export function ensureSeed(db) {
  const seeded = db.prepare('SELECT value FROM meta WHERE key = ?').get('seeded');
  if (seeded) return false;

  const consumers = [
    ['geo-router', 'Geo Router（v2 订阅端）', 'subscriber', 'strict-v2', '[2]'],
    ['risk-scoring', 'Risk Scoring（双版本订阅端）', 'subscriber', 'lenient-dual', '[2, 1]'],
    ['legacy-ledger', 'Legacy Ledger（v1 消费端，升级慢）', 'subscriber', 'legacy-v1', '[1]'],
    ['intake-adapter', 'Intake Adapter（接入器发出的自检副本）', 'adapter', 'strict-v2', '[2, 1]'],
  ];
  const insert = db.prepare(
    'INSERT INTO consumers(id, name, kind, policy, supported_versions) VALUES(?, ?, ?, ?, ?)',
  );
  for (const row of consumers) insert.run(...row);

  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('seeded', nowIso());
  appendEvent(db, 'seed', '已初始化消费者目录：一个严格 v2、一个双版本、一个仅 v1。', { actor: 'seed' });
  return true;
}

export function resetAll(db) {
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const table of [
    'events', 'preflights', 'deliveries', 'backfill_runs', 'decisions',
    'records', 'batches', 'consumers', 'contracts', 'meta',
  ]) {
    db.exec(`DELETE FROM ${table};`);
  }
  db.exec('PRAGMA foreign_keys = ON;');
  return ensureSeed(db);
}

export function listConsumers(db) {
  return db
    .prepare('SELECT * FROM consumers ORDER BY CASE id WHEN \'geo-router\' THEN 1 WHEN \'risk-scoring\' THEN 2 WHEN \'legacy-ledger\' THEN 3 ELSE 4 END')
    .all()
    .map((c) => {
      // A switch confirms a specific document, so it stops being a confirmation
      // as soon as that document changes. `contract_sha` is kept (it is the
      // audit record of what was read); the derived flags say whether it still
      // matches what a delivery would carry today.
      const current = c.contract_version == null ? null : contractDigest(c.contract_version).sha256;
      return {
        ...c,
        supported_versions: JSON.parse(c.supported_versions),
        subscribed: c.contract_version != null,
        switch_stale: c.contract_sha != null && current != null && c.contract_sha !== current,
        switch_confirmed: c.contract_version != null && c.contract_sha != null && current != null && c.contract_sha === current,
      };
    });
}

export function publishContract(db, version, { quiet = false, actor = 'catalog' } = {}) {
  const { payload, sha256: digest } = contractDigest(version);
  const existing = db.prepare('SELECT sha256 FROM contracts WHERE version = ?').get(version);
  const changed = existing != null && existing.sha256 !== digest;
  // `published_at` means "when this exact document was first handed out", not
  // "when the process last started". Republishing identical bytes keeps the
  // original timestamp so the audit trail cannot be quietly rewritten by a
  // restart.
  db.prepare(
    `INSERT INTO contracts(version, contract_id, payload, sha256, status, published_at)
     VALUES(?, ?, ?, ?, 'published', ?)
     ON CONFLICT(version) DO UPDATE SET payload = excluded.payload, sha256 = excluded.sha256,
       status = 'published',
       published_at = CASE WHEN contracts.sha256 = excluded.sha256
                           THEN contracts.published_at ELSE excluded.published_at END`,
  ).run(version, `pointwise.segment@${version}`, payload, digest, nowIso());
  // `quiet` suppresses no-ops, not real changes. A boot that republishes an
  // unchanged document should stay out of the event stream; a boot that finds
  // the document changed must not silently swap what consumers will receive.
  if (!quiet || !existing || changed) {
    appendEvent(
      db,
      'contract.published',
      existing
        ? changed
          ? `合同 v${version} 内容变化，已重新发布（sha ${digest.slice(0, 12)}）。`
          : `合同 v${version} 重新发布，内容未变（sha ${digest.slice(0, 12)}）。`
        : `已发布合同 v${version}（sha ${digest.slice(0, 12)}）。`,
      { actor, detail: { version, sha256: digest } },
    );
  }
  return { version, sha256: digest, unchanged: existing?.sha256 === digest };
}

// Boot-time helper: record the contract only when this database has never
// published it. It deliberately does NOT overwrite an existing record. A
// process restart must not be able to change what a consumer already confirmed;
// if the in-code document and the published record disagree, the honest state is
// "drifted", and someone has to publish explicitly.
export function ensureContractPublished(db, version, { actor = 'catalog' } = {}) {
  const existing = db.prepare('SELECT sha256 FROM contracts WHERE version = ?').get(version);
  if (!existing) return { ...publishContract(db, version, { actor }), status: 'published' };
  const current = contractDigest(version).sha256;
  return { version, sha256: existing.sha256, unchanged: existing.sha256 === current, status: existing.sha256 === current ? 'published' : 'drifted' };
}

// ---------- batches / ingestion ----------

export function listBatches(db) {
  const rows = db.prepare('SELECT * FROM batches ORDER BY ingested_at ASC').all();
  return rows.map((batch) => {
    const counts = db
      .prepare(
        `SELECT split_status AS status, COUNT(*) AS n FROM records WHERE batch_id = ? GROUP BY split_status`,
      )
      .all(batch.id);
    const byStatus = { resolved: 0, needs_review: 0, blocked: 0 };
    for (const row of counts) byStatus[row.status] = row.n;
    return { ...batch, byStatus, has_records: batch.record_count > 0 };
  });
}

export function getBatch(db, id) {
  return db.prepare('SELECT * FROM batches WHERE id = ?').get(id) ?? null;
}

export function listRecords(db, batchId) {
  const rows = db.prepare('SELECT * FROM records WHERE batch_id = ? ORDER BY seq').all(batchId);
  return rows.map((row) => ({
    id: row.id,
    batch_id: row.batch_id,
    seq: row.seq,
    legacy_segment: row.legacy_segment,
    ingested_at: row.ingested_at,
    country_code: row.country_code,
    region_code: row.region_code,
    region_presence: row.region_presence,
    region_verified: row.region_verified === 1,
    split_status: row.split_status,
    reason_code: row.reason_code,
    reason_label: row.reason_code ? reasonLabel(row.reason_code) : null,
    provenance: row.provenance,
    rule_id: row.rule_id,
    basis: row.basis,
    projection_hash: row.projection_hash,
    backfilled_at: row.backfilled_at,
    decision: db.prepare('SELECT choice, reason, actor, created_at FROM decisions WHERE record_id = ?').get(row.id) ?? null,
  }));
}

export function getRecord(db, id) {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    region_verified: row.region_verified === 1,
    decision: db.prepare('SELECT * FROM decisions WHERE record_id = ?').get(row.id) ?? null,
  };
}

function insertRecord(db, { id, batchId, seq, raw, ingestedAt }) {
  db.prepare(
    `INSERT INTO records(id, batch_id, seq, legacy_segment, ingested_at, country_code, region_code,
       region_presence, region_verified, split_status, reason_code, provenance, rule_id, basis,
       projection_hash, projection_rev)
     VALUES(?, ?, ?, ?, ?, NULL, NULL, 'unknown', 0, NULL, NULL, 'legacy', 'none', NULL, NULL, 0)`,
  ).run(id, batchId, seq, raw, ingestedAt);
}

// Recompute a record's projection from its legacy value, unless an operator
// decision pins it. This is the function the interrupted backfill resumes.
export function projectRecord(db, record, { operatorChoice = null, operatorReason = null } = {}) {
  const split = operatorChoice
    ? projectOperatorChoice(record.legacy_segment, operatorChoice, operatorReason)
    : splitLegacySegment(record.legacy_segment);
  const projection = {
    country_code: split.countryCode,
    region_code: split.regionCode,
    region_presence: split.regionPresence,
    split_status: split.status,
    reason_code: split.reasonCode,
    provenance: split.provenance,
    rule_id: split.ruleId,
    basis: split.basis,
  };
  return {
    split,
    projection,
    projectionHash: sha256(canonicalJson({ record_id: record.id, legacy: record.legacy_segment, ...projection })),
  };
}

function projectOperatorChoice(legacy, choice, reason) {
  if (choice.countryCode && !choice.regionCode && choice.regionPresence === 'absent') {
    return {
      status: RECORD_STATUS.RESOLVED,
      countryCode: choice.countryCode,
      regionCode: null,
      regionPresence: 'absent',
      regionVerified: 0,
      reasonCode: 'OPERATOR_COUNTRY_ONLY',
      ruleId: 'operator.decision',
      provenance: 'operator',
      basis: `人工将旧值 \`${legacy}\` 判定为仅国家 ${choice.countryCode}，地区原本不存在。理由：${reason}`,
      candidates: [],
    };
  }
  return {
    status: RECORD_STATUS.RESOLVED,
    countryCode: choice.countryCode,
    regionCode: choice.regionCode ?? null,
    regionPresence: choice.regionPresence ?? (choice.regionCode ? 'present' : 'absent'),
    regionVerified: choice.regionCode ? 1 : 0,
    reasonCode: 'OPERATOR_MAPPED',
    ruleId: 'operator.decision',
    provenance: 'operator',
    basis: `人工把旧值 \`${legacy}\` 映射为 country_code=${choice.countryCode}、region_code=${choice.regionCode ?? 'null'}。依据：${reason}`,
    candidates: [],
  };
}

export function applyProjection(db, id, projectResult) {
  const { projection, projectionHash } = projectResult;
  db.prepare(
    `UPDATE records SET country_code=?, region_code=?, region_presence=?, region_verified=?,
       split_status=?, reason_code=?, provenance=?, rule_id=?, basis=?, projection_hash=?,
       projection_rev = projection_rev + 1, backfilled_at=?
     WHERE id=?`,
  ).run(
    projection.country_code,
    projection.region_code,
    projection.region_presence,
    projectResult.split.regionVerified ?? (projection.region_code ? 1 : 0),
    projection.split_status,
    projection.reason_code,
    projection.provenance,
    projection.rule_id,
    projection.basis,
    projectionHash,
    nowIso(),
    id,
  );
}

// Schema check a consumer can run on a single item without knowing its origin.
// Used by the "拒绝不兼容数据" panel to show why v2 refuses lossy shapes.
export function validateSingleItem(item) {
  // No expectedSha here on purpose: this panel answers "is this shape legal
  // under v2", not "did this batch come from the contract I subscribed to".
  // The SHA handshake is enforced at delivery, where the bundle carries one.
  return validateV2Bundle({ contract_version: 2, items: [item] }, {});
}

export function ingestBatch(db, { label, origin, values }) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('批次没有记录，拒绝接入');
  const id = shortId('batch');
  const ingestedAt = nowIso();
  // A batch must exist completely or not at all. Previously the batch row was
  // written first, so an empty or failing batch left a zero-record batch behind
  // that could never be projected, delivered, or cleanly removed.
  transaction(db, () => {
    db.prepare('INSERT INTO batches(id, label, origin, ingested_at, record_count) VALUES(?, ?, ?, ?, ?)').run(
      id,
      label,
      origin,
      ingestedAt,
      values.length,
    );
    values.forEach((raw, index) => {
      const recordId = `${id}-r${String(index + 1).padStart(2, '0')}`;
      insertRecord(db, { id: recordId, batchId: id, seq: index + 1, raw, ingestedAt });
    });
    appendEvent(db, 'batch.ingested', `接入批次「${label}」：${values.length} 条记录，来源 ${origin}。`, {
      actor: 'intake-adapter',
      detail: { batch_id: id, record_count: values.length },
    });
    // The adapter never waits for a human to notice a problem: a freshly ingested
    // batch carrying structurally lossy values is held for v2 by default. v1 is
    // unaffected, and the hold is visible and overridable, not silent.
    const preflight = runPreflight(db, id);
    if (preflight.verdict === 'hold') {
      setBatchHold(db, id, {
        hold: true,
        reason: `接入器自检发现 ${preflight.blocked} 条无法表达为单值的记录，自动暂缓 v2 投递`,
        actor: 'intake-adapter',
      });
    }
  });
  return id;
}

export function seedDemoData(db) {
  ensureSeed(db);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM batches').get().n;
  if (existing > 0) return false;

  const batches = [
    {
      label: 'CRM 全量快照 #2026-11-02',
      origin: 'crm.export',
      values: [
        'US-CA', 'US-NY', 'CA-ON', 'DE-BE', 'GB-ENG', 'FR-IDF', 'CN-BJ', 'JP-13',
        'NL-NH', 'ES-MD', 'US', 'CA', 'DE', 'FR', 'GB',
        'US-OR', 'CA-QC', 'DE-BY', 'CN-SH', 'US-WA',
      ],
    },
    {
      label: '合作伙伴回填 #A17',
      origin: 'partner.feed',
      values: [
        'DE', 'USA', 'GBR', 'FRA', 'NLD', 'CAN', 'CHE', 'SWE', 'NOR', 'DNK',
        'ITA', 'AUS', 'BRA', 'IND', 'MEX',
      ],
    },
    {
      label: '风险模型历史切片 #Q3',
      origin: 'legacy-warehouse',
      values: [
        'CA', 'TX', 'NY', 'FL', 'WA', 'IL', 'MA', 'CO', 'AZ', 'OR',
        'AL', 'MT', 'DE', 'NE', 'LA',
      ],
    },
    {
      label: '离线表单导入 #B03',
      origin: 'offline-forms',
      values: [
        'US-CA ', 'ca-on', 'de-be', 'GB-ENG', 'FR-IDF', 'CN-BJ',
        'US-CA;US-NV', 'US-', '-CA', 'N/A', '', 'ZZ', 'XX',
        'UK', 'EL', 'USA-TX', 'US-CA-9', 'US-CA (HQ)', 'XX-QQ', 'US-NY',
      ],
    },
    {
      label: '欧盟发票归档 #E09',
      origin: 'eu-invoice',
      values: [
        'DE-BE', 'BE-BRU', 'NL-NH', 'FR-IDF', 'ES-MD', 'PT-11', 'IE-D', 'IT-25',
        'DE-HH', 'DK-84',
      ],
    },
  ];
  for (const batch of batches) ingestBatch(db, batch);
  appendEvent(db, 'seed', '已生成 5 个来源不同的演示批次，共 80 条记录。', { actor: 'seed' });
  return true;
}

// ---------- preflight ----------

export function runPreflight(db, batchId, { persist = true } = {}) {
  const records = db.prepare('SELECT * FROM records WHERE batch_id = ? ORDER BY seq').all(batchId);
  if (records.length === 0) throw new Error('批次没有记录，无法预检');

  const items = [];
  const reasonCounts = {};
  const severityCounts = { ok: 0, warn: 0, error: 0 };
  let lossy = 0;

  for (const record of records) {
    // Preflight never writes projections and never honours prior decisions: it
    // answers "what would happen if this batch were projected now".
    const split = splitLegacySegment(record.legacy_segment);
    const severity = severityOf(split.reasonCode);
    severityCounts[severity] += 1;
    reasonCounts[split.reasonCode] = (reasonCounts[split.reasonCode] ?? 0) + 1;
    const candidate = split.candidates?.[0];
    const projected = split.status === 'resolved' || candidate;
    if (!projected) lossy += 1;
    items.push({
      record_id: record.id,
      seq: record.seq,
      legacy_segment: record.legacy_segment,
      predicted_status: split.status,
      predicted_country: split.status === 'resolved' ? split.countryCode : null,
      predicted_region: split.status === 'resolved' ? split.regionCode : null,
      predicted_presence: split.status === 'resolved' ? split.regionPresence : 'unknown',
      reason_code: split.reasonCode,
      reason_label: reasonLabel(split.reasonCode),
      severity,
      basis: split.basis,
      candidate_labels: (split.candidates ?? []).map((c) => c.label),
      candidates: (split.candidates ?? []).map((c) => ({
        label: c.label,
        country_code: c.countryCode,
        region_code: c.regionCode,
        region_presence: c.regionPresence,
        rationale: c.rationale,
      })),
      would_be_lossy: !projected,
    });
  }

  const total = records.length;
  const resolved = items.filter((i) => i.predicted_status === 'resolved').length;
  const review = items.filter((i) => i.predicted_status === 'needs_review').length;
  const blocked = items.filter((i) => i.predicted_status === 'blocked').length;
  const reviewShare = review / total;
  const hardHits = items.filter((i) => POLICY.hardReasons.includes(i.reason_code));

  const policyChecks = [
    {
      id: 'review-share',
      label: `待复核比例不得高于 ${(POLICY.reviewShareLimit * 100).toFixed(0)}%`,
      pass: reviewShare <= POLICY.reviewShareLimit,
      actual: `${(reviewShare * 100).toFixed(1)}%（${review}/${total}）`,
      note: reviewShare <= POLICY.reviewShareLimit
        ? '在阈值内，v2 可按隔离规则投递。'
        : '超过阈值：预检建议暂缓整个批次的 v2 投递，先处理歧义值。',
    },
    {
      id: 'hard-reasons',
      label: '不得含无法表达为单值的值（多值 / 空段）',
      pass: hardHits.length === 0,
      actual: hardHits.length ? `${hardHits.length} 条：${hardHits.map((h) => h.record_id).join(', ')}` : '无',
      note: hardHits.length
        ? '这些值在 v2 中没有正确表示，发布 v2 会迫使消费端猜测。'
        : '没有结构性破损的值。',
    },
    {
      id: 'lossless-hash',
      label: '每条 resolved 记录的投影都可重算（哈希稳定）',
      pass: items.every((i) => i.predicted_status !== 'resolved' || i.predicted_country),
      actual: `${resolved} 条 resolved`,
      note: '预检只读：不写库、不改变旧列，结果可安全重复运行。',
    },
  ];

  const verdict = blocked > 0 || severityCounts.error > 0 ? 'hold' : review > 0 ? 'review' : 'clean';

  const report = {
    batch_id: batchId,
    batch_label: getBatch(db, batchId).label,
    run_at: nowIso(),
    ruleset: ruleSetFingerprint(),
    total,
    resolved,
    review,
    blocked,
    review_share: reviewShare,
    severity_counts: severityCounts,
    reason_counts: reasonCounts,
    lossy,
    verdict,
    policy_checks: policyChecks,
    items,
    notes: [
      '预检是只读快照：不改写任何记录，也不改变 v1 列。',
      `判定：${verdict === 'clean' ? '可投递 v2' : verdict === 'review' ? '存在歧义，按隔离规则投递或暂缓' : '含阻断值，整批不应进入 v2'}`,
    ],
  };

  if (persist) {
    db.prepare(
      'INSERT INTO preflights(batch_id, run_at, report) VALUES(?, ?, ?) ON CONFLICT(batch_id) DO UPDATE SET run_at = excluded.run_at, report = excluded.report',
    ).run(batchId, report.run_at, JSON.stringify(report));
    appendEvent(db, 'preflight.run', `预检「${getBatch(db, batchId).label}」：${total} 条，${review} 条歧义，${blocked} 条阻断，结论 ${verdict}。`, {
      actor: 'preflight',
      detail: { batch_id: batchId, verdict, review, blocked },
    });
  }
  return report;
}

export function getPreflight(db, batchId) {
  const row = db.prepare('SELECT * FROM preflights WHERE batch_id = ?').get(batchId);
  return row ? JSON.parse(row.report) : null;
}

// Preflight is a snapshot of the RAW values, so it never goes "stale" from
// projection: the same bytes always produce the same report. What changes after
// a human acts is the difference between the report and reality, and that must
// be visible rather than silently reconciled.
export function preflightDrift(db, batchId) {
  const row = db.prepare('SELECT run_at, report FROM preflights WHERE batch_id = ?').get(batchId);
  if (!row) return { has_report: false, decisions_since: 0, projections_since: 0, ruleset_changed: false };
  const decisionsSince = db
    .prepare(
      `SELECT COUNT(*) AS n FROM decisions d JOIN records r ON r.id = d.record_id
       WHERE r.batch_id = ? AND d.created_at > ?`,
    )
    .get(batchId, row.run_at).n;
  const projectionsSince = db
    .prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND backfilled_at > ?')
    .get(batchId, row.run_at).n;
  // A stored report is a snapshot of the rules as they were. If the rule set has
  // changed since, the report can contradicted today's projection for the same
  // raw value — the drift must be attributed to the rules, not to a human.
  const reportedRuleset = JSON.parse(row.report)?.ruleset ?? null;
  const currentRuleset = ruleSetFingerprint();
  return {
    has_report: true,
    decisions_since: decisionsSince,
    projections_since: projectionsSince,
    ruleset_changed: reportedRuleset !== currentRuleset,
    reported_ruleset: reportedRuleset,
    current_ruleset: currentRuleset,
    run_at: row.run_at,
  };
}

// The gate is about what the batch actually contains NOW (operator decisions
// included); the preflight report is a rule diagnostic of the raw values and
// deliberately ignores decisions so the operator can see them again.
export function batchProjectionStats(db, batchId) {
  const rows = db
    .prepare('SELECT split_status AS status, COUNT(*) AS n FROM records WHERE batch_id = ? GROUP BY split_status')
    .all(batchId);
  const map = { resolved: 0, needs_review: 0, blocked: 0 };
  for (const row of rows) map[row.status] = row.n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ?').get(batchId).n;
  const pending = total - map.resolved - map.needs_review - map.blocked;
  const lossy = db
    .prepare(
      `SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND reason_code IN ('MULTI_VALUED','EMPTY_PART')`,
    )
    .get(batchId).n;
  return {
    total,
    resolved: map.resolved,
    needs_review: map.needs_review,
    blocked: map.blocked,
    pending,
    lossy,
    review_share: total === 0 ? 0 : map.needs_review / total,
  };
}

// A freshly seeded lab starts mid-migration, not blank: everything preflighted,
// four batches already backfilled, and the fifth deliberately left interrupted
// so "resume from cursor" is a real state rather than a scripted animation.
export function bootstrapDemo(db, { interruptedLabel = '离线表单导入 #B03', interruptAfter = 12 } = {}) {
  const batches = listBatches(db);
  for (const batch of batches) runPreflight(db, batch.id);
  for (const batch of batches) {
    if (batch.label === interruptedLabel) {
      startBackfill(db, { batchId: batch.id, interruptAfter });
    } else {
      startBackfill(db, { batchId: batch.id });
    }
  }
  appendEvent(db, 'seed', '演示初始状态：全部预检完成，四个批次回填完毕，B03 批次停在中途等待恢复。', {
    actor: 'seed',
  });
}

// ---------- decisions ----------

export function applyDecision(db, recordId, { choice, reason, actor = 'operator' }) {
  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  if (!record) throw new Error('记录不存在');
  if (!reason || reason.trim().length < 3) throw new Error('必须填写判定依据（至少 3 个字符）');

  let parsedChoice;
  if (choice === 'block') {
    parsedChoice = null;
  } else {
    parsedChoice = typeof choice === 'string' ? JSON.parse(choice) : choice;
    if (!/^[A-Z]{2}$/.test(parsedChoice.countryCode ?? '')) throw new Error('countryCode 必须是两位大写 ISO 代码');
    if (parsedChoice.regionCode && !/^[A-Z0-9]{1,3}$/.test(parsedChoice.regionCode)) {
      throw new Error('regionCode 格式不合法');
    }
    // Validate the combination, not just each field: a decision like
    // region_code='CA' + presence='absent' would be stored happily and then
    // fail v2's own invariants at delivery, poisoning the whole bundle.
    // Normalise the common cases when presence is omitted.
    if (!parsedChoice.regionPresence) {
      parsedChoice.regionPresence = parsedChoice.regionCode ? 'present' : 'absent';
    }
    if (!['present', 'absent', 'unknown'].includes(parsedChoice.regionPresence)) {
      throw new Error('regionPresence 必须是 present / absent / unknown');
    }
    if (parsedChoice.regionPresence === 'unknown') {
      throw new Error('人工判定必须给出确定结果；无法确定时请选择阻断，而不是把记录留作 unknown');
    }
    if (parsedChoice.regionCode && parsedChoice.regionPresence !== 'present') {
      throw new Error(`regionCode=${parsedChoice.regionCode} 与 regionPresence=${parsedChoice.regionPresence} 矛盾：给了地区码就必须是 present`);
    }
    if (!parsedChoice.regionCode && parsedChoice.regionPresence !== 'absent') {
      throw new Error('没有 regionCode 时 regionPresence 必须是 absent（地区原本不存在）');
    }
  }

  db.prepare(
    'INSERT INTO decisions(id, record_id, choice, reason, actor, created_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET choice = excluded.choice, reason = excluded.reason, actor = excluded.actor, created_at = excluded.created_at',
  ).run(shortId('dec'), recordId, JSON.stringify(choice), reason.trim(), actor, nowIso());

  if (choice === 'block') {
    db.prepare(
      `UPDATE records SET split_status='blocked', country_code=NULL, region_code=NULL,
         region_presence='unknown', region_verified=0, reason_code='OPERATOR_BLOCKED',
         provenance='operator', rule_id='operator.decision', basis=?, projection_hash=NULL,
         projection_rev = projection_rev + 1, backfilled_at=? WHERE id=?`,
    ).run(`人工阻断旧值 \`${record.legacy_segment}\`。理由：${reason.trim()}`, nowIso(), recordId);
  } else {
    const projectResult = projectRecord(db, record, { operatorChoice: parsedChoice, operatorReason: reason.trim() });
    applyProjection(db, recordId, projectResult);
  }

  const updated = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  appendEvent(db, 'record.decided', `记录 ${recordId}（旧值 \`${record.legacy_segment}\`）判定为${choice === 'block' ? '阻断' : '已映射'}。`, {
    actor,
    detail: { record_id: recordId, choice: choice === 'block' ? 'block' : parsedChoice, reason: reason.trim() },
  });
  const batch = getBatch(db, record.batch_id);
  return { record: updated, batch };
}

// ---------- backfill (resumable, interruptible) ----------

// Accepting input is the adapter's job, and the two shapes mean different
// things. An explicit array is a list of values — an empty string there is a
// real "no value" record the splitter must block on. Pasted text is lines, and
// a truly blank line is formatting (a trailing newline, a paragraph gap), not a
// record. Whitespace inside a line is kept: the splitter reports
// WHITESPACE_TRIMMED as evidence about the source, so trimming here would erase
// that finding before it is recorded.
export function parseIngestValues({ values, raw, limit } = {}) {
  const parsed = Array.isArray(values)
    ? values.map((v) => String(v))
    : String(raw ?? '')
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line.length > 0);
  const capped = Number.isFinite(Number(limit)) && Number(limit) > 0 ? parsed.slice(0, Number(limit)) : parsed;
  if (capped.length === 0) throw new Error('没有可接入的值');
  return capped;
}

// Batches are identified by id. Labels are display text and are not unique —
// two imports can legitimately share one — so a label lookup that matches more
// than one batch must refuse rather than silently backfill an arbitrary one.
function resolveBatch(db, { batchId, label }) {
  if (batchId) {
    const batch = getBatch(db, batchId);
    if (!batch) throw new Error('找不到用于回填的批次');
    return batch;
  }
  const matches = db.prepare('SELECT * FROM batches WHERE label = ?').all(label);
  if (matches.length === 0) throw new Error('找不到用于回填的批次');
  if (matches.length > 1) throw new Error(`有 ${matches.length} 个批次都叫「${label}」；回填必须指定批次 id，而不是标签`);
  return matches[0];
}

export function startBackfill(db, { batchId = null, label = null, interruptAfter = null } = {}) {
  const batch = resolveBatch(db, { batchId, label });
  // Two concurrent runs over the same batch would both claim to be "the"
  // backfill, with separate cursors and separate progress counts. The projection
  // itself is safe (it only picks unprojected rows), but the audit trail would
  // no longer answer "how far along is this batch".
  const active = db.prepare("SELECT id FROM backfill_runs WHERE target_batch = ? AND status IN ('running','interrupted')").get(batch.id);
  if (active) throw new Error(`批次「${batch.label}」已有未完成的回填（${active.id}）；先完成或恢复它`);
  const pending = db
    .prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND split_status IS NULL')
    .get(batch.id).n;
  const id = shortId('backfill');
  db.prepare(
    'INSERT INTO backfill_runs(id, target_batch, started_at, status, target_count, processed_count, interrupt_at) VALUES(?, ?, ?, ?, ?, 0, ?)',
  ).run(id, batch.id, nowIso(), 'running', pending, interruptAfter);
  appendEvent(db, 'backfill.started', `开始回填「${batch.label}」，待投影 ${pending} 条${interruptAfter ? `，将在第 ${interruptAfter} 条后模拟中断` : ''}。`, {
    actor: 'backfill',
    detail: { run_id: id, batch_id: batch.id, interrupt_after: interruptAfter },
  });
  for (let guard = 0; guard < 500; guard += 1) {
    const before = db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(id);
    if (before.status !== 'running') break;
    stepBackfill(db, id);
    const after = db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(id);
    if (after.processed_count === before.processed_count) break;
  }
  return summarizeRun(db, db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(id));
}

// One deterministic step: pick the next unprojected record after the stored
// cursor, project it, persist the cursor. Interruption loses no work and
// re-running never double-projects a record.
export function stepBackfill(db, runId) {
  const run = db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('回填任务不存在');
  if (run.status !== 'running') return summarizeRun(db, run);

  const record = db
    .prepare('SELECT * FROM records WHERE batch_id = ? AND split_status IS NULL AND seq > ? ORDER BY seq LIMIT 1')
    .get(run.target_batch, run.cursor_seq ?? 0);

  if (!record) {
    db.prepare('UPDATE backfill_runs SET status = ?, finished_at = ? WHERE id = ?').run('complete', nowIso(), runId);
    appendEvent(db, 'backfill.complete', `回填任务完成，本次运行处理 ${run.processed_count} 条。`, {
      actor: 'backfill',
      detail: { run_id: runId, processed: run.processed_count },
    });
    return summarizeRun(db, db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId));
  }

  const decision = db.prepare('SELECT choice, reason FROM decisions WHERE record_id = ?').get(record.id);
  const projectResult = projectRecord(db, record, {
    operatorChoice: decision ? JSON.parse(decision.choice) : null,
    operatorReason: decision?.reason ?? null,
  });
  applyProjection(db, record.id, projectResult);

  const processed = run.processed_count + 1;
  const willInterrupt = run.interrupt_at != null && processed >= run.interrupt_at;
  db.prepare(
    'UPDATE backfill_runs SET processed_count = ?, cursor_seq = ?, status = ? WHERE id = ?',
  ).run(processed, record.seq, willInterrupt ? 'interrupted' : 'running', runId);

  appendEvent(
    db,
    willInterrupt ? 'backfill.interrupted' : 'backfill.step',
    willInterrupt
      ? `回填在第 ${processed} 条后中断；游标停在 ${record.batch_id}#${record.seq}，可从此处恢复。`
      : `回填处理 ${record.id} 得到 ${projectResult.projection.split_status}。`,
    { actor: 'backfill', detail: { run_id: runId, record_id: record.id, status: willInterrupt ? 'interrupted' : 'running' } },
  );
  return summarizeRun(db, db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId));
}

export function resumeBackfill(db, runId) {
  const run = db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('回填任务不存在');
  if (run.status !== 'interrupted') throw new Error('只有中断的回填可以恢复');
  db.prepare('UPDATE backfill_runs SET status = ?, interrupt_at = NULL WHERE id = ?').run('running', runId);
  appendEvent(db, 'backfill.resumed', `回填从 ${run.target_batch}#${run.cursor_seq} 恢复；此前已落盘的投影不会重算。`, {
    actor: 'backfill',
    detail: { run_id: runId },
  });
  for (let guard = 0; guard < 500; guard += 1) {
    const before = db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId);
    if (before.status !== 'running') break;
    stepBackfill(db, runId);
    const after = db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId);
    if (after.processed_count === before.processed_count) break;
  }
  return summarizeRun(db, db.prepare('SELECT * FROM backfill_runs WHERE id = ?').get(runId));
}

export function summarizeRun(db, run) {
  const remaining = db
    .prepare('SELECT COUNT(*) AS n FROM records WHERE batch_id = ? AND split_status IS NULL')
    .get(run.target_batch).n;
  return { ...run, remaining };
}

export function listBackfills(db) {
  return db.prepare('SELECT * FROM backfill_runs ORDER BY started_at DESC').all().map((r) => summarizeRun(db, r));
}

// ---------- deliveries ----------

export function buildV2Bundle(db, batchId) {
  const batch = getBatch(db, batchId);
  const records = db.prepare('SELECT * FROM records WHERE batch_id = ? ORDER BY seq').all(batchId);
  const { sha256: contractSha } = contractDigest(2);
  const items = [];
  const exclusions = [];
  for (const record of records) {
    if (record.split_status === 'resolved') {
      items.push(v2Item(record));
    } else if (record.split_status === 'needs_review') {
      items.push(v2Item(record));
    } else {
      exclusions.push({
        record_id: record.id,
        legacy_segment: record.legacy_segment,
        reason_code: record.reason_code ?? 'BACKFILL_INCOMPLETE',
        reason_label: reasonLabel(record.reason_code ?? 'BACKFILL_INCOMPLETE'),
        basis: record.basis ?? '该记录尚未被投影（回填未覆盖）；v2 不接受猜测值。',
      });
    }
  }
  return {
    contract_version: 2,
    contract_id: 'pointwise.segment@2',
    contract_sha: contractSha,
    batch_id: batchId,
    batch_label: batch.label,
    generated_at: nowIso(),
    items,
    exclusions,
  };
}

function v2Item(record) {
  return {
    record_id: record.id,
    split_status: record.split_status,
    country_code: record.country_code,
    region_code: record.region_code,
    region_presence: record.region_presence,
    reason_code: record.reason_code,
    provenance: record.provenance,
    basis: record.basis,
    source_hash: sha256(String(record.legacy_segment)),
  };
}

export function deliverConsumers(db, options) {
  const { batchId, consumerIds = [], override = false } = options;
  const batch = getBatch(db, batchId);
  if (!batch) throw new Error('批次不存在');
  // Block/hold decisions are about the v2 projection only. v1 consumers keep
  // receiving the untouched legacy value — that is the whole point of keeping
  // both contracts alive.

  const { sha256: v1Sha } = contractDigest(1);
  const { sha256: v2Sha } = contractDigest(2);
  const v2 = buildV2Bundle(db, batchId);
  const v1Items = db.prepare('SELECT * FROM records WHERE batch_id = ? ORDER BY seq').all(batchId).map((r) => ({
    record_id: r.id,
    legacy_segment: r.legacy_segment,
    ingested_at: r.ingested_at,
  }));

  const results = [];
  for (const consumerId of consumerIds) {
    const consumer = db.prepare('SELECT * FROM consumers WHERE id = ?').get(consumerId);
    if (!consumer) throw new Error(`未知消费端 ${consumerId}`);
    const supported = JSON.parse(consumer.supported_versions);
    if (consumer.contract_version == null) {
      results.push(rejectDelivery(db, { batchId, consumer, version: consumer.policy === 'legacy-v1' ? 1 : 2, code: 'NOT_SWITCHED', detail: '消费端尚未声明订阅的合同版本；迟到的确认不能倒推为已切换。' }));
      continue;
    }
    if (consumer.contract_sha == null) {
      results.push(rejectDelivery(db, { batchId, consumer, version: consumer.contract_version, code: 'SHA_UNCONFIRMED', detail: '已声明版本但未回传 contract_sha；无法证明消费端读到的是当前发布的合同。' }));
      continue;
    }
    if (!supported.includes(consumer.contract_version)) {
      results.push(rejectDelivery(db, { batchId, consumer, version: consumer.contract_version, code: 'UNSUPPORTED_VERSION', detail: `消费端声称订阅 v${consumer.contract_version}，但其能力清单为 [${supported}].` }));
      continue;
    }
    // The consumer confirmed a specific document. If the service would now send
    // different bytes under the same version number, that is not a schema
    // problem — it is the old contract changing meaning under a consumer that
    // never agreed to it. v1 is included on purpose: v1 must stay frozen.
    const current = contractDigest(consumer.contract_version).sha256;
    if (consumer.contract_sha !== current) {
      results.push(rejectDelivery(db, {
        batchId, consumer, version: consumer.contract_version, code: 'CONTRACT_CHANGED',
        detail: `消费端确认的是 ${consumer.contract_sha.slice(0, 12)}，当前 v${consumer.contract_version} 文档是 ${current.slice(0, 12)}；拒绝按新语义投递，需重新确认后再切换。`,
      }));
      continue;
    }
    if (consumer.contract_version === 1) {
      results.push(acceptDelivery(db, {
        batchId, consumer, version: 1, hash: v1Sha, rowCount: v1Items.length, excluded: 0,
        quarantined: 0, payload: v1Items,
      }));
      continue;
    }
    if (batch.blocked_at && !override) {
      results.push(rejectDelivery(db, {
        batchId, consumer, version: 2, code: 'BATCH_BLOCKED',
        detail: `批次被人工阻断：${batch.block_reason}。v1 不受影响。`,
      }));
      continue;
    }
    if (batch.override_policy && !override) {
      results.push(rejectDelivery(db, {
        batchId, consumer, version: 2, code: 'BATCH_ON_HOLD',
        detail: `批次暂缓 v2 投递：${batch.hold_reason ?? '(未记录理由)'}。v1 不受影响。需先解除暂缓或显式覆盖。`,
      }));
      continue;
    }
    // v2 consumer.
    const expected = consumer.contract_sha;
    const validation = validateBundleForConsumer(v2, { expectedSha: expected, policy: consumer.policy });
    if (validation.errors.length) {
      results.push(rejectDelivery(db, {
        batchId, consumer, version: 2, code: validation.code,
        detail: validation.errors.slice(0, 4).join('；'),
      }));
      continue;
    }
    const policy = evaluateDeliveryPolicy(db, batchId, consumer, { override });
    if (!policy.pass) {
      results.push(rejectDelivery(db, { batchId, consumer, version: 2, code: policy.code, detail: policy.detail }));
      continue;
    }
    results.push(acceptDelivery(db, {
      batchId, consumer, version: 2, hash: v2Sha, rowCount: v2.items.length,
      excluded: v2.exclusions.length, quarantined: v2.items.filter((i) => i.split_status !== 'resolved').length, payload: v2,
    }));
  }
  return results;
}

// Schema validity and consumer policy are different things and produce
// different rejection codes: a bundle can be perfectly valid and still be
// refused by a consumer that cannot quarantine anything.
function validateBundleForConsumer(bundle, { expectedSha, policy }) {
  const errors = validateV2Bundle(bundle, { expectedSha });
  if (errors.length) return { code: 'V2_BUNDLE_INVALID', errors };
  if (policy === 'strict-v2') {
    const unresolved = bundle.items.filter((i) => i.split_status !== 'resolved');
    if (unresolved.length) {
      return {
        code: 'STRICT_NO_QUARANTINE',
        errors: [
          `严格策略不允许隔离区：本批含 ${unresolved.length} 条 needs_review（${unresolved.slice(0, 3).map((i) => i.record_id).join('、')}）。批次数据本身符合 v2 schema，是该消费端无法接收未知值。`,
        ],
      };
    }
    if (bundle.exclusions.length) {
      return {
        code: 'STRICT_NO_EXCLUSION',
        errors: [`严格策略不接受排除项：本批有 ${bundle.exclusions.length} 条记录完全没有 v2 值，拒绝以“缺口”形式交付。`],
      };
    }
  }
  return { code: null, errors: [] };
}

function evaluateDeliveryPolicy(db, batchId, consumer, { override }) {
  const stats = batchProjectionStats(db, batchId);
  if (stats.pending > 0) {
    return { pass: false, code: 'BACKFILL_INCOMPLETE', detail: `批次仍有 ${stats.pending} 条记录未投影；v2 不接受未处理的值。` };
  }
  if (stats.lossy > 0) {
    return { pass: false, code: 'LOSSY_VALUES_PRESENT', detail: `批次含 ${stats.lossy} 条多值/空段记录；v2 无法无损表达，需要人工阻断或处置。` };
  }
  // Strict consumers refuse a batch they would have to hold in quarantine;
  // lenient consumers accept it and mark the ambiguous rows as quarantined.
  if (stats.review_share > POLICY.reviewShareLimit && consumer.policy === 'strict-v2') {
    return { pass: false, code: 'REVIEW_SHARE_EXCEEDED', detail: `当前仍有 ${(stats.review_share * 100).toFixed(1)}% 记录待复核，超过阈值 ${(POLICY.reviewShareLimit * 100).toFixed(0)}%；严格消费端整批拒收。` };
  }
  return { pass: true };
}

function acceptDelivery(db, { batchId, consumer, version, hash, rowCount, excluded, quarantined = 0, payload }) {
  const id = shortId('dlv');
  const deliveredAt = nowIso();
  const payloadHash = sha256(canonicalJson(payload));
  db.prepare(
    `INSERT INTO deliveries(id, batch_id, consumer_id, contract_version, payload_hash, row_count,
       excluded_count, quarantined_count, status, delivered_at, payload)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?)
     ON CONFLICT(batch_id, consumer_id, contract_version) DO UPDATE SET
       payload_hash = excluded.payload_hash, row_count = excluded.row_count,
       excluded_count = excluded.excluded_count, quarantined_count = excluded.quarantined_count,
       status = 'delivered', delivered_at = excluded.delivered_at, payload = excluded.payload,
       rejection_code = NULL, rejection_detail = NULL,
       -- A re-delivery carries a NEW payload. Any earlier acknowledgement was
       -- for the old bytes, so keeping it would make the row claim the consumer
       -- confirmed data it has never seen.
       acked_at = NULL, ack_note = NULL`,
  ).run(id, batchId, consumer.id, version, payloadHash, rowCount, excluded, quarantined, deliveredAt, JSON.stringify(payload));
  appendEvent(
    db,
    'delivery.accepted',
    `向 ${consumer.name} 投递 v${version}：${rowCount} 条，隔离 ${quarantined} 条，排除 ${excluded} 条。`,
    {
      actor: 'delivery',
      detail: {
        batch_id: batchId,
        consumer: consumer.id,
        version,
        row_count: rowCount,
        quarantined,
        excluded,
        payload_hash: payloadHash,
        contract_hash: hash,
      },
    },
  );
  return { consumer: consumer.id, status: 'delivered', version, rowCount, excluded, quarantined };
}

function rejectDelivery(db, { batchId, consumer, version, code, detail }) {
  db.prepare(
    `INSERT INTO deliveries(id, batch_id, consumer_id, contract_version, status, rejection_code, rejection_detail, delivered_at)
     VALUES(?, ?, ?, ?, 'rejected', ?, ?, ?)
     ON CONFLICT(batch_id, consumer_id, contract_version) DO UPDATE SET
       status = 'rejected', rejection_code = excluded.rejection_code,
       rejection_detail = excluded.rejection_detail, delivered_at = excluded.delivered_at,
       acked_at = NULL`,
  ).run(shortId('dlv'), batchId, consumer.id, version, code, detail, nowIso());
  appendEvent(db, 'delivery.rejected', `拒绝向 ${consumer.name} 投递 v${version}：${code}。`, {
    actor: 'delivery',
    detail: { batch_id: batchId, consumer: consumer.id, version, code, detail },
  });
  return { consumer: consumer.id, status: 'rejected', version, code, detail };
}

export function listDeliveries(db, batchId) {
  return db.prepare(
    `SELECT d.*, c.name AS consumer_name FROM deliveries d JOIN consumers c ON c.id = d.consumer_id
     WHERE d.batch_id = ? ORDER BY d.contract_version, c.id`,
  ).all(batchId);
}

export function acknowledgeDelivery(db, deliveryId, { note = '', simulatedLateMinutes = 0, actor = null } = {}) {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
  if (!delivery) throw new Error('投递不存在');
  if (delivery.status !== 'delivered') throw new Error('只有已投递的批次可以确认');
  const delivered = new Date(delivery.delivered_at).getTime();
  const ackedAt = new Date(delivered + simulatedLateMinutes * 60_000).toISOString();
  db.prepare('UPDATE deliveries SET acked_at = ?, ack_note = ? WHERE id = ?').run(ackedAt, note || null, deliveryId);
  // Derive lateness from the two timestamps, not from the simulation input:
  // a genuinely late real-world ack (simulatedLateMinutes = 0) must still be
  // recorded as late, and the audit trail should reflect the stored times.
  const lagMinutes = Math.round((new Date(ackedAt).getTime() - delivered) / 60_000);
  const late = lagMinutes > POLICY.lateAckMinutes;
  appendEvent(
    db,
    'delivery.acked',
    `投递 ${deliveryId} 被确认${late ? `（迟到 ${lagMinutes} 分钟）` : ''}${note ? `：${note}` : ''}。`,
    { actor: actor ?? delivery.consumer_id, detail: { delivery_id: deliveryId, late, lag_minutes: lagMinutes, note } },
  );
  return { delivery: db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId), late, lagMinutes };
}

// ---------- consumer switch (explicit, hash-bound) ----------

export function switchConsumer(db, consumerId, { version, sha, actor = null }) {
  const consumer = db.prepare('SELECT * FROM consumers WHERE id = ?').get(consumerId);
  if (!consumer) throw new Error('消费端不存在');
  if (![1, 2].includes(version)) throw new Error('版本必须是 1 或 2');
  // supported_versions is a JSON array, not a string. Substring-matching it
  // would let a capability list like [12] satisfy a request for v2.
  const supported = JSON.parse(consumer.supported_versions).map(Number);
  if (!supported.includes(version)) throw new Error(`该消费端不支持 v${version}（能力清单 [${supported.join(', ')}]）`);
  const { sha256: expected } = contractDigest(version);
  // A switch is a statement about the PUBLISHED contract. If the record is
  // missing or disagrees with the document the service would now send, there is
  // nothing honest for the consumer to confirm: publish first.
  const record = db.prepare('SELECT sha256 FROM contracts WHERE version = ?').get(version);
  if (!record) throw new Error(`合同 v${version} 尚未发布；没有可确认的已发布记录`);
  if (record.sha256 !== expected) {
    throw new Error(`合同 v${version} 的已发布记录（${record.sha256.slice(0, 12)}）与现行文档（${expected.slice(0, 12)}）不一致；请先重新发布，再让消费端确认`);
  }
  const normalized = String(sha ?? '').trim().toLowerCase();
  // Accept a hex prefix of at least 12 chars: enough to prove the consumer read
  // the exact document, while not forcing a paste of the whole 64-char digest.
  const valid = /^[a-f0-9]{12,64}$/.test(normalized) && expected.startsWith(normalized);
  if (!valid) throw new Error('contract_sha 与实际发布的合同不一致；确认无效（可粘贴前 12 位以上）');
  db.prepare('UPDATE consumers SET contract_version = ?, contract_sha = ?, switched_at = ? WHERE id = ?').run(
    version, expected, nowIso(), consumerId,
  );
  appendEvent(db, 'consumer.switched', `${consumer.name} 显式切换到 v${version} 并回传合同哈希 ${expected.slice(0, 12)}。`, {
    actor: actor ?? consumerId,
    detail: { consumer_id: consumerId, version, sha256: expected },
  });
  return listConsumers(db).find((c) => c.id === consumerId);
}

// A batch-level policy decision, not a per-record guess: the operator asserts a
// property of the SOURCE SYSTEM ("this feed's bare two-letter codes are US
// states"), and every affected record gets an explicit operator provenance plus
// a basis quoting that policy. It never runs implicitly.
export function applyBatchPolicy(db, batchId, { policyRule, reason, actor = 'operator', overrideDecisions = false }) {
  if (!reason || reason.trim().length < 8) throw new Error('批量策略必须写明来源依据（至少 8 个字符）');
  const records = db.prepare('SELECT * FROM records WHERE batch_id = ? ORDER BY seq').all(batchId);
  const applied = [];
  // A batch policy is a default for undecided rows. Silently overwriting an
  // individual judgement — which may have a better basis — would destroy the
  // audit trail, so existing decisions are skipped unless explicitly overridden.
  const skipped = [];
  for (const record of records) {
    const split = splitLegacySegment(record.legacy_segment);
    if (split.status !== 'needs_review') continue;
    const existing = db.prepare('SELECT created_at, actor FROM decisions WHERE record_id = ?').get(record.id);
    if (existing && !overrideDecisions) {
      skipped.push({ record_id: record.id, legacy_segment: record.legacy_segment, decided_at: existing.created_at, actor: existing.actor });
      continue;
    }
    let choice = null;
    if (policyRule === 'bare-as-us-state' && ['BARE_CODE_COLLISION', 'BARE_SUBDIVISION'].includes(split.reasonCode)) {
      const candidate = split.candidates.find((c) => c.countryCode === 'US' && c.regionCode);
      if (candidate) {
        choice = { countryCode: 'US', regionCode: candidate.regionCode, regionPresence: 'present' };
      }
    } else if (policyRule === 'bare-as-country' && split.reasonCode === 'BARE_CODE_COLLISION') {
      const code = split.candidates.find((c) => c.regionCode === null)?.countryCode;
      if (code) choice = { countryCode: code, regionCode: null, regionPresence: 'absent' };
    }
    if (!choice) continue;
    const scenario = policyRule === 'bare-as-us-state' ? `按 ${record.batch_id} 来源系统的既有约定，裸两字母码表示美国州码` : '按来源系统约定，裸两字母码表示国家码';
    const fullReason = `${scenario}。操作依据：${reason.trim()}`;
    db.prepare(
      'INSERT INTO decisions(id, record_id, choice, reason, actor, created_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(record_id) DO UPDATE SET choice = excluded.choice, reason = excluded.reason, actor = excluded.actor, created_at = excluded.created_at',
    ).run(shortId('dec'), record.id, JSON.stringify(choice), fullReason, actor, nowIso());
    const projectResult = projectRecord(db, record, { operatorChoice: choice, operatorReason: reason.trim() });
    applyProjection(db, record.id, projectResult);
    applied.push({ record_id: record.id, legacy_segment: record.legacy_segment, countryCode: choice.countryCode, regionCode: choice.regionCode });
  }
  appendEvent(
    db,
    'batch.policy',
    `批次 ${batchId} 应用来源策略「${policyRule}」：影响 ${applied.length} 条` +
      (skipped.length ? `，跳过 ${skipped.length} 条已有独立判定的记录` : '') +
      `，依据：${reason.trim()}`,
    { actor, detail: { batch_id: batchId, policy_rule: policyRule, affected: applied.length, skipped: skipped.length } },
  );
  return { applied, skipped };
}

export function clearDecision(db, recordId, { actor = 'operator' } = {}) {
  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  if (!record) throw new Error('记录不存在');
  db.prepare('DELETE FROM decisions WHERE record_id = ?').run(recordId);
  const projectResult = projectRecord(db, record);
  applyProjection(db, recordId, projectResult);
  appendEvent(db, 'record.decision.cleared', `撤回记录 ${recordId} 的人工判定，重新按规则投影。`, {
    actor,
    detail: { record_id: recordId },
  });
  return getRecord(db, recordId);
}

export function blockBatch(db, batchId, { reason, actor = 'operator' }) {
  if (!reason || reason.trim().length < 3) throw new Error('阻断必须附理由');
  const batch = getBatch(db, batchId);
  if (!batch) throw new Error('批次不存在');
  if (batch.blocked_at) throw new Error('该批次已被阻断');
  db.prepare('UPDATE batches SET blocked_at = ?, block_reason = ? WHERE id = ?').run(nowIso(), reason.trim(), batchId);
  // Only rows that still need a decision are marked blocked. Overwriting rows
  // that already have a projection would erase the audit basis of a rule result
  // or a human judgement, and — because it cannot be undone — leave a batch
  // permanently unusable. The batch-level block is what withholds v2; the
  // per-row status records where each row stood when that happened.
  const touched = db
    .prepare(
      `UPDATE records SET split_status='blocked', reason_code='BATCH_BLOCKED', basis=?, projection_hash=NULL,
        projection_rev = projection_rev + 1
       WHERE batch_id = ? AND (split_status IS NULL OR split_status = 'needs_review')`,
    )
    .run(`批次被人工阻断：${reason.trim()}。v1 列保留，v2 不投递该批次。`, batchId).changes;
  appendEvent(db, 'batch.blocked', `批次 ${batchId} 被阻断：${reason.trim()}（${touched} 条尚未处理的记录改为阻断）`, {
    actor,
    detail: { batch_id: batchId, records_marked: touched },
  });
}

export function unblockBatch(db, batchId, { reason, actor = 'operator' } = {}) {
  if (!reason || reason.trim().length < 3) throw new Error('解除阻断必须附理由');
  const batch = getBatch(db, batchId);
  if (!batch) throw new Error('批次不存在');
  if (!batch.blocked_at) throw new Error('该批次没有被阻断');
  const previous = batch.block_reason;
  db.prepare('UPDATE batches SET blocked_at = NULL, block_reason = NULL WHERE id = ?').run(batchId);
  // Rows this block marked are recomputed (and thus re-audited); rows with their
  // own prior projection were never touched and are left exactly as they were.
  const rows = db
    .prepare("SELECT * FROM records WHERE batch_id = ? AND split_status = 'blocked' AND reason_code = 'BATCH_BLOCKED'")
    .all(batchId);
  for (const record of rows) {
    const decision = db.prepare('SELECT choice, reason FROM decisions WHERE record_id = ?').get(record.id);
    applyProjection(
      db,
      record.id,
      projectRecord(db, record, {
        operatorChoice: decision ? JSON.parse(decision.choice) : null,
        operatorReason: decision?.reason ?? null,
      }),
    );
  }
  appendEvent(db, 'batch.unblocked', `批次 ${batchId} 解除阻断：${reason.trim()}（原阻断理由：${previous}）`, {
    actor,
    detail: { batch_id: batchId, previous_reason: previous, records_reprojected: rows.length },
  });
  return getBatch(db, batchId);
}

export function setBatchHold(db, batchId, { hold, reason = '预检策略', actor = 'operator' }) {
  // The reason is stored with the hold, not only written to the event stream:
  // a consumer asking "why is this batch withheld" must be able to read the
  // answer from the batch itself, not from an archaeology exercise in events.
  db.prepare('UPDATE batches SET override_policy = ?, hold_reason = ? WHERE id = ?').run(
    hold ? 1 : 0,
    hold ? reason : null,
    batchId,
  );
  appendEvent(db, hold ? 'batch.hold' : 'batch.release', `批次 ${batchId} ${hold ? '按策略暂缓' : '解除暂缓'}：${reason}`, {
    actor, detail: { batch_id: batchId },
  });
}

