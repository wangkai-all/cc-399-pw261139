#!/usr/bin/env node
import fs from 'node:fs';
import { openDb, initSchema, DEFAULT_DB_PATH } from './db.js';
import * as svc from './service.js';
import { contractDigest } from './contracts.js';

const [command, ...rest] = process.argv.slice(2);
const dbPath = process.env.LAB_DB ?? DEFAULT_DB_PATH;

function boot() {
  fs.mkdirSync(new URL('../data', import.meta.url), { recursive: true });
  const db = openDb(dbPath);
  initSchema(db);
  svc.ensureSeed(db);
  // Same rule as the server: a boot records a contract once and never rewrites
  // an existing published record. Explicit `npm run demo` steps publish.
  svc.ensureContractPublished(db, 1);
  svc.ensureContractPublished(db, 2);
  return db;
}

function printState(db) {
  const batches = svc.listBatches(db);
  console.log('\n批次');
  for (const b of batches) {
    console.log(
      `  ${b.id}  ${b.label.padEnd(24)} ${String(b.record_count).padStart(3)} 条  ` +
        `resolved=${b.byStatus.resolved} review=${b.byStatus.needs_review} blocked=${b.byStatus.blocked}`,
    );
  }
  console.log('\n消费端');
  for (const c of svc.listConsumers(db)) {
    console.log(
      `  ${c.id.padEnd(15)} 支持=${JSON.stringify(c.supported_versions)}  ` +
        `已声明=v${c.contract_version ?? '—'}  哈希确认=${c.contract_sha ? '是' : '否'}`,
    );
  }
}

function spinUpConsumers(db) {
  const v1 = contractDigest(1).sha256;
  const v2 = contractDigest(2).sha256;
  const switches = [
    ['geo-router', 2, v2],
    ['risk-scoring', 2, v2],
    ['legacy-ledger', 1, v1],
  ];
  for (const [id, version, sha] of switches) {
    const result = svc.switchConsumer(db, id, { version, sha });
    console.log(`   ${id.padEnd(14)} → v${version}  sha 确认 ${sha.slice(0, 12)}…  ${result.switched_at}`);
  }
  // A wrong hash must be refused, not silently accepted; show it so the demo
  // proves the handshake has teeth.
  try {
    svc.switchConsumer(db, 'geo-router', { version: 2, sha: 'f'.repeat(64) });
    console.log('   ✗ 错误：错误的 SHA 竟然被接受');
  } catch (error) {
    console.log(`   拒绝错误哈希：${error.message}`);
  }
}

function demo(db) {
  const batches = svc.listBatches(db);
  console.log('① 预检全部批次');
  for (const b of batches) {
    const report = svc.runPreflight(db, b.id);
    console.log(
      `   ${b.label.padEnd(24)} ${report.total} 条：${report.resolved} resolved / ${report.review} review / ${report.blocked} blocked` +
        `  歧义比例 ${(report.review_share * 100).toFixed(1)}%  结论 ${report.verdict}`,
    );
  }
  const first = batches[0];
  console.log('\n② 回填第 7 条后中断');
  const run = svc.startBackfill(db, { label: first.label, interruptAfter: 7 });
  console.log(`   ${run.status}；已处理 ${run.processed_count}/${run.target_count}，游标 seq=${run.cursor_seq}`);
  console.log('③ 从游标恢复');
  const resumed = svc.resumeBackfill(db, run.id);
  console.log(`   ${resumed.status}；累计处理 ${resumed.processed_count}，剩余未投影 ${resumed.remaining}`);

  console.log('\n④ 消费端显式切换');
  spinUpConsumers(db);

  console.log('\n⑤ 发布 v1 + v2，并向三类消费端投递 CRM 快照');
  svc.publishContract(db, 1);
  svc.publishContract(db, 2);
  const results = svc.deliverConsumers(db, {
    batchId: first.id,
    consumerIds: ['geo-router', 'risk-scoring', 'legacy-ledger'],
  });
  for (const r of results) console.log(`   ${r.consumer.padEnd(14)} ${r.status}`, r.code ?? `v${r.version} ${r.rowCount} 条`);

  console.log('\n⑥ 迟到的确认（模拟网络延迟 5 小时）');
  const delivery = db.prepare("SELECT id FROM deliveries WHERE consumer_id = 'legacy-ledger' AND status = 'delivered'").get();
  if (delivery) {
    const ack = svc.acknowledgeDelivery(db, delivery.id, {
      note: '批处理窗口结束后才回 ACK',
      simulatedLateMinutes: 300,
    });
    console.log(`   late=${ack.late}  acked_at=${ack.delivery.acked_at}`);
  }

  console.log('\n⑦ 有一条记录在各合同中的实际值');
  const record = db.prepare("SELECT * FROM records WHERE legacy_segment = 'CA' LIMIT 1").get();
  if (record) {
    console.log(`   记录 ${record.id} 旧值 "${record.legacy_segment}"`);
    for (const delivery of db
      .prepare("SELECT * FROM deliveries WHERE batch_id = ? AND status = 'delivered' ORDER BY contract_version")
      .all(record.batch_id)) {
      const payload = JSON.parse(delivery.payload);
      const items = Array.isArray(payload) ? payload : payload.items;
      const item = items.find((i) => i.record_id === record.id);
      const exclusion = Array.isArray(payload) ? null : payload.exclusions?.find((e) => e.record_id === record.id);
      const consumer = db.prepare('SELECT name FROM consumers WHERE id = ?').get(delivery.consumer_id);
      const body = item ?? exclusion;
      console.log(`   v${delivery.contract_version} → ${consumer.name}`);
      console.log(`     ${item ? '值' : '排除'} ${JSON.stringify(body)}`);
    }
    console.log(`   v2 缺失依据: ${record.basis}`);
  }
}

try {
  const db = boot();
  if (command === 'seed') {
    const created = svc.seedDemoData(db);
    if (created) svc.bootstrapDemo(db);
    console.log(created ? '已生成演示数据。' : '演示数据已存在（用 npm run reset 重建）。');
    printState(db);
  } else if (command === 'reset') {
    svc.resetAll(db);
    svc.seedDemoData(db);
    svc.bootstrapDemo(db);
    svc.publishContract(db, 1);
    svc.publishContract(db, 2);
    console.log('已重置。');
    printState(db);
  } else if (command === 'demo') {
    svc.resetAll(db);
    svc.seedDemoData(db);
    // The demo narrates the migration itself, so it must start before the
    // projection exists. bootstrapDemo() would pre-backfill everything and
    // leave nothing to interrupt or resume.
    svc.publishContract(db, 1);
    svc.publishContract(db, 2);
    demo(db);
  } else if (command === 'state') {
    printState(db);
  } else {
    console.log('用法: node src/cli.js <seed|reset|demo|state>');
    printState(db);
  }
  db.close();
} catch (error) {
  console.error('失败:', error.message);
  process.exitCode = 1;
}
