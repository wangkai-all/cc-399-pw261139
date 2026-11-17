import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'lab.sqlite');

export function nowIso() {
  return new Date().toISOString();
}

export function openDb(file = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  version INTEGER PRIMARY KEY,
  contract_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS consumers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  policy TEXT NOT NULL,
  supported_versions TEXT NOT NULL,
  contract_version INTEGER,
  contract_sha TEXT,
  switched_at TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  origin TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  blocked_at TEXT,
  block_reason TEXT,
  override_policy INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  legacy_segment TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  country_code TEXT,
  region_code TEXT,
  region_presence TEXT,
  region_verified INTEGER,
  split_status TEXT,
  reason_code TEXT,
  provenance TEXT,
  rule_id TEXT,
  basis TEXT,
  projection_hash TEXT,
  projection_rev INTEGER NOT NULL DEFAULT 0,
  backfilled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_batch_seq ON records(batch_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(split_status);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
  choice TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backfill_runs (
  id TEXT PRIMARY KEY,
  target_batch TEXT NOT NULL REFERENCES batches(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  target_count INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  interrupt_at INTEGER,
  cursor_batch TEXT,
  cursor_seq INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  contract_version INTEGER NOT NULL,
  payload_hash TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  rejection_code TEXT,
  rejection_detail TEXT,
  payload TEXT,
  delivered_at TEXT,
  acked_at TEXT,
  ack_note TEXT,
  UNIQUE(batch_id, consumer_id, contract_version)
);

CREATE TABLE IF NOT EXISTS preflights (
  batch_id TEXT PRIMARY KEY REFERENCES batches(id),
  run_at TEXT NOT NULL,
  report TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
`;

export function initSchema(db) {
  db.exec(SCHEMA);
  migrate(db);
}

// SQLite has no "ADD COLUMN IF NOT EXISTS". Columns added after the first
// release are applied here so an existing data/lab.sqlite keeps working.
const MIGRATIONS = [
  ['batches', 'hold_reason', 'TEXT'],
];

function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  backfillHoldReason(db);
}

// The reason used to live only in the event stream. For batches already on hold
// when this column appears, recover the last recorded reason so the UI and the
// rejection message do not claim "no reason recorded" about a hold that has one.
function backfillHoldReason(db) {
  const held = db.prepare('SELECT id, label FROM batches WHERE override_policy = 1 AND hold_reason IS NULL').all();
  for (const batch of held) {
    const event = db
      .prepare("SELECT summary FROM events WHERE kind = 'batch.hold' AND summary LIKE ? ORDER BY id DESC LIMIT 1")
      .get(`批次 ${batch.id} %`);
    if (!event) continue;
    const reason = event.summary.split('：').slice(1).join('：').trim();
    if (reason) db.prepare('UPDATE batches SET hold_reason = ? WHERE id = ?').run(reason, batch.id);
  }
}

const TABLES = [
  'events',
  'preflights',
  'deliveries',
  'backfill_runs',
  'decisions',
  'records',
  'batches',
  'consumers',
  'contracts',
  'meta',
];

export function resetSchema(db) {
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table};`);
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

// Several operations write more than one row (a batch plus its records plus its
// preflight, or a batch's block flag plus its rows). If a later step refuses —
// an empty batch, a failing invariant — the earlier writes must not survive as
// a half-created batch that no consumer can ever be told about.
// Nested calls use a SAVEPOINT: an inner failure rolls back only the inner work,
// and the outer commit still decides the whole thing.
let savepointSeq = 0;

export function transaction(db, fn) {
  if (db.isTransaction) {
    const name = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function appendEvent(db, kind, summary, { actor = 'system', detail = null } = {}) {
  db.prepare('INSERT INTO events(at, kind, actor, summary, detail) VALUES(?, ?, ?, ?, ?)').run(
    nowIso(),
    kind,
    actor,
    summary,
    detail == null ? null : JSON.stringify(detail),
  );
}

export function listEvents(db, limit = 40) {
  return db
    .prepare('SELECT id, at, kind, actor, summary, detail FROM events ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((row) => ({
      ...row,
      detail: row.detail ? JSON.parse(row.detail) : null,
    }));
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
