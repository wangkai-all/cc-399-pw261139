/* Split-field contract lab — client. No framework, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  data: null,
  tab: 'overview',
  selectedBatch: null,
  selectedRecord: null,
  pending: 0,
  toastTimer: null,
};

/* ---------- formatting ---------- */

const pct = (n, digits = 1) => `${(n * 100).toFixed(digits)}%`;
const num = (n) => new Intl.NumberFormat('zh-CN').format(n);
const shortSha = (sha) => (sha ? sha.slice(0, 12) : '—');
const CHECK_SVG = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M1 6.5 4.4 9.8 11 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const mono = (s) => `<code class="mono">${esc(String(s))}</code>`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function time(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fullTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusChip(status) {
  const map = {
    resolved: ['ok', '已解析'],
    needs_review: ['warn', '待复核'],
    blocked: ['bad', '阻断'],
    delivered: ['ok', '已投递'],
    rejected: ['bad', '已拒收'],
    running: ['warn', '进行中'],
    interrupted: ['bad', '已中断'],
    complete: ['ok', '已完成'],
    pending: ['warn', '待投影'],
    clean: ['ok', '干净'],
    review: ['warn', '需复核'],
    hold: ['bad', '暂缓'],
  };
  const [tone, label] = map[status] ?? ['warn', status];
  return `<span class="chip chip-${tone}"><span class="dot dot-${tone}"></span>${label}</span>`;
}

/* ---------- HTTP ---------- */

async function api(method, path, body) {
  state.pending += 1;
  document.body.toggleAttribute('data-busy', state.pending > 0);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.state) state.data = data.state;
    return data;
  } finally {
    state.pending -= 1;
    document.body.toggleAttribute('data-busy', state.pending > 0);
  }
}

function toast(message, tone = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

async function refresh() {
  const data = await api('GET', '/api/state');
  state.data = data;
  render();
}

/* ---------- shell ---------- */

const TABS = [
  ['overview', '总览'],
  ['preflight', '预检与歧义'],
  ['contracts', '双版合同'],
  ['consumers', '消费端与投递'],
  ['trace', '记录溯源'],
];

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(
    ([id, label]) =>
      `<button class="tab" role="tab" aria-selected="${state.tab === id}" data-tab="${id}">${label}` +
      (id === 'preflight' && state.data?.totals.review ? `<span class="tab-count">${state.data.totals.review}</span>` : '') +
      `</button>`,
  ).join('');
}

function selectedBatch() {
  const batches = state.data?.batches ?? [];
  return batches.find((b) => b.id === state.selectedBatch) ?? batches[0] ?? null;
}

/* ---------- overview ---------- */

function renderOverview() {
  const d = state.data;
  const stats = d.totals;
  const projected = stats.resolved + stats.review + stats.blocked;
  const reviewShare = projected ? stats.review / projected : 0;

  const segments = [
    { key: 'resolved', label: '已解析', value: stats.resolved, tone: 's' },
    { key: 'review', label: '待复核', value: stats.review, tone: 'w' },
    { key: 'blocked', label: '阻断', value: stats.blocked, tone: 'b' },
    { key: 'pending', label: '未投影', value: stats.pending, tone: 'p' },
  ].filter((s) => s.value > 0);

  const bar = segments
    .map(
      (s) =>
        `<span class="seg seg-${s.tone}" style="width:${(s.value / stats.records) * 100}%" title="${s.label} ${s.value} 条" aria-label="${s.label} ${s.value} 条"></span>`,
    )
    .join('');

  $('#view').innerHTML = `
    <section class="hero-row">
      <div class="hero">
        <p class="eyebrow">迁移中的记录</p>
        <p class="hero-figure">${num(stats.records)}</p>
        <p class="hero-sub">5 个来源批次 · ${d.consumers.length} 个消费端 · 1 个旧字段拆成 2 个新字段</p>
      </div>
      <div class="tile-grid">
        ${tile('已解析', num(stats.resolved), `占已投影 ${projected ? pct(stats.resolved / projected) : '—'}`, 'ok')}
        ${tile('待复核', num(stats.review), `占已投影 ${projected ? pct(reviewShare) : '—'}`, stats.review ? 'warn' : 'muted')}
        ${tile('阻断', num(stats.blocked), '无可用 v2 值', stats.blocked ? 'bad' : 'muted')}
        ${tile('未投影', num(stats.pending), '回填未覆盖', stats.pending ? 'warn' : 'muted')}
      </div>
    </section>

    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>记录处置分布</h2>
          <p class="sub">条形宽度按全部 ${num(stats.records)} 条记录计数；“未投影”表示回填尚未覆盖，不是“没有地区”。</p>
        </div>
      </header>
      <div class="segbar">${bar || '<span class="seg seg-p" style="width:100%"></span>'}</div>
      <div class="legend">
        ${segments
          .map((s) => `<span class="legend-item"><span class="swatch seg-${s.tone}"></span>${s.label}<b>${num(s.value)}</b></span>`)
          .join('')}
      </div>
    </section>

    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>批次状态</h2>
          <p class="sub">预检是只读规则诊断；投递闸门看的是当前投影结果（含人工判定）。点击进入批次处理。</p>
        </div>
      </header>
      <div class="batch-list">
        ${d.batches.map(batchCard).join('')}
      </div>
    </section>

    <section class="panel two-col">
      <div>
        <header class="panel-head"><h2>最近事件</h2></header>
        <ol class="event-list">
          ${d.events.slice(0, 12).map(eventRow).join('') || '<li class="empty">尚无事件</li>'}
        </ol>
      </div>
      <div>
        <header class="panel-head"><h2>迁移口径</h2></header>
        <dl class="facts">
          <dt>旧合同</dt><dd>v1 · 单字段 <code>legacy_segment</code> · 冻结 · <code>${shortSha(d.contracts[0].sha256)}</code></dd>
          <dt>新合同</dt><dd>v2 · <code>country_code</code> + <code>region_code</code> + <code>region_presence</code> · <code>${shortSha(d.contracts[1].sha256)}</code></dd>
          <dt>未知值</dt><dd>不写 null 冒充“没有”；进入 <code>needs_review</code> 或 <code>blocked</code></dd>
          <dt>切换确认</dt><dd>消费端显式声明版本 + 回传合同 SHA（至少前 12 位）</dd>
          <dt>投递闸门</dt><dd>歧义比例 &gt; ${pct(d.policy.reviewShareLimit, 0)} 时严格端整批拒收；多值/空段整批不进 v2</dd>
          <dt>迟到确认</dt><dd>投递后超过 ${d.policy.lateAckMinutes} 分钟的确认会被记为 late，但不倒推切换状态</dd>
        </dl>
      </div>
    </section>
  `;

  $$('.batch-list .batch-card').forEach((el) =>
    el.addEventListener('click', () => {
      state.selectedBatch = el.dataset.batch;
      state.tab = 'preflight';
      render();
    }),
  );
}

function tile(label, value, sub, tone) {
  return `<div class="tile tile-${tone}">
    <p class="tile-label">${label}</p>
    <p class="tile-value">${value}</p>
    <p class="tile-sub">${sub}</p>
  </div>`;
}

function batchCard(batch) {
  const s = batch.stats;
  const segments = [
    ['resolved', s.resolved, 's'],
    ['review', s.needs_review, 'w'],
    ['blocked', s.blocked, 'b'],
    ['pending', s.pending, 'p'],
  ].filter(([, v]) => v > 0);
  const flags = [];
  if (batch.override_policy) flags.push('<span class="chip chip-bad"><span class="dot dot-bad"></span>按策略暂缓</span>');
  if (batch.blocked_at) flags.push('<span class="chip chip-bad"><span class="dot dot-bad"></span>整批阻断</span>');
  if (batch.preflight?.decisions_since) flags.push(`<span class="chip chip-warn"><span class="dot dot-warn"></span>预检后有 ${batch.preflight.decisions_since} 条人工判定</span>`);

  return `<article class="batch-card" data-batch="${batch.id}" tabindex="0" role="button">
    <div class="batch-main">
      <p class="batch-label">${esc(batch.label)}</p>
      <p class="batch-meta">${esc(batch.origin)} · ${num(batch.record_count)} 条 · 摄入 ${fullTime(batch.ingested_at)}</p>
      <div class="mini-seg" aria-hidden="true">
        ${segments.map(([, v, t]) => `<span class="seg seg-${t}" style="width:${(v / batch.record_count) * 100}%"></span>`).join('')}
      </div>
    </div>
    <div class="batch-side">
      ${batch.preflight ? statusChip(batch.preflight.verdict) : '<span class="chip chip-warn">未预检</span>'}
      <span class="batch-nums">${s.resolved}<span class="sep">/</span>${s.needs_review}<span class="sep">/</span>${s.blocked}<span class="sep">/</span>${s.pending}</span>
      <span class="batch-hint">已解析 / 待复核 / 阻断 / 未投影</span>
      <span class="batch-flags">${flags.join('')}</span>
    </div>
  </article>`;
}

function eventRow(event) {
  return `<li class="event event-${esc(event.kind.split('.')[0])}">
    <span class="event-time">${time(event.at)}</span>
    <span class="event-body"><span class="event-summary">${esc(event.summary)}</span>
    <span class="event-actor">${esc(event.actor)} · ${esc(event.kind)}</span></span>
  </li>`;
}

/* ---------- preflight ---------- */

async function renderPreflight() {
  const batch = selectedBatch();
  if (!batch) {
    $('#view').innerHTML = '<p class="empty">还没有批次，去“预检与歧义”接入一批数据。</p>';
    return;
  }
  state.selectedBatch = batch.id;
  let report;
  let drift = null;
  try {
    ({ report, drift } = await api('GET', `/api/batches/${batch.id}/preflight`));
  } catch {
    report = null;
  }
  const stats = batch.stats;

  $('#view').innerHTML = `
    <section class="panel">
      <header class="panel-head wrap">
        <div>
          <h2>${esc(batch.label)}</h2>
          <p class="sub">${esc(batch.origin)} · ${num(batch.record_count)} 条 · ${report ? `预检于 ${fullTime(report.run_at)}` : '尚未预检'}</p>
        </div>
        <div class="btn-row">
          <label class="field inline"><span>批次</span>
            <select id="preflight-batch">
              ${state.data.batches
                .map((b) => `<option value="${b.id}" ${b.id === batch.id ? 'selected' : ''}>${esc(b.label)}（${b.record_count} 条）</option>`)
                .join('')}
            </select>
          </label>
          <button class="btn" id="run-preflight">重新预检</button>
          <button class="btn btn-ghost" id="backfill-batch">回填本批</button>
          <button class="btn ${batch.blocked_at ? 'btn-ghost' : 'btn-danger'}" id="block-batch">${batch.blocked_at ? '解除阻断' : '整批阻断'}</button>
        </div>
      </header>
      ${renderPreflightStrip(report, stats, batch, drift)}
    </section>

    ${renderBatchControls(batch, report)}

    ${report ? renderPreflightTable(report, batch) : '<section class="panel"><p class="empty">运行预检以查看逐条判定。</p></section>'}

    ${renderIngestForm()}
  `;

  $('#preflight-batch').addEventListener('change', (e) => {
    state.selectedBatch = e.target.value;
    render();
  });
  $('#run-preflight').addEventListener('click', async () => {
    const data = await api('POST', `/api/batches/${batch.id}/preflight`);
    toast(`预检完成：${data.report.review} 条待复核，${data.report.blocked} 条阻断`);
    render();
  });
  $('#backfill-batch').addEventListener('click', async () => {
    await api('POST', '/api/backfills', { batchId: batch.id });
    toast('本批回填完成');
    render();
  });
  $('#block-batch').addEventListener('click', () => {
    if (batch.blocked_at) {
      const why = prompt(`解除阻断的理由（原阻断理由：${batch.block_reason}）：`);
      if (!why) return;
      api('POST', `/api/batches/${batch.id}/unblock`, { reason: why }).then(() => {
        toast('已解除阻断，记录按当前规则/判定重新投影', 'ok');
        render();
      }).catch((e) => toast(e.message, 'bad'));
      return;
    }
    const reason = prompt('阻断整批的理由（会写入事件与每条记录的 basis）：');
    if (!reason) return;
    api('POST', `/api/batches/${batch.id}/block`, { reason }).then(() => {
      toast('整批已阻断：v1 保留，v2 停止投递', 'warn');
      render();
    }).catch((e) => toast(e.message, 'bad'));
  });
  bindBatchControls(batch);
  bindPreflightTable(batch);
  bindIngestForm();
}

function renderPreflightStrip(report, stats, batch, drift = null) {
  const cards = [
    ['预检记录数', num(report?.total ?? stats.total), '条'],
    ['规则可解析', num(report?.resolved ?? 0), '有可信来源'],
    ['规则待复核', num(report?.review ?? 0), '必须人工确认'],
    ['规则阻断', num(report?.blocked ?? 0), '无法表达为 v2'],
    ['当前未投影', num(stats.pending), '回填未覆盖'],
  ];
  const checks = report?.policy_checks ?? [];
  return `
    <div class="strip">
      ${cards.map(([l, v, s]) => `<div class="strip-item"><p class="strip-value">${v}</p><p class="strip-label">${l}</p><p class="strip-sub">${s}</p></div>`).join('')}
    </div>
    <div class="check-row">
      ${checks
        .map(
          (c) => `<div class="check ${c.pass ? 'check-pass' : 'check-fail'}">
            <span class="check-icon" aria-hidden="true">${c.pass ? CHECK_SVG : '!'}</span>
            <span><b>${esc(c.label)}</b><span class="check-actual">${esc(c.actual)}</span><span class="check-note">${esc(c.note)}</span></span>
          </div>`,
        )
        .join('')}
    </div>
    ${report?.notes?.length ? `<p class="footnote">${report.notes.map(esc).join(' ')}</p>` : ''}
    ${driftNote(report, stats, drift)}
  `;
}

// The report describes raw values; the batch now describes decisions. Both are
// shown, never merged — otherwise a resolved record would look like a rule win.
// A changed rule set is called out first: that drift is the service's doing, not
// an operator's, and attributing it to a human would be a false audit trail.
function driftNote(report, stats, drift = null) {
  if (!report) return '';
  const parts = [];
  const pending = stats.pending ?? 0;
  if (drift?.ruleset_changed) {
    parts.push(
      `<b>拆分规则集在预检之后发生过变更</b>（预检指纹 ${esc(drift.reported_ruleset ?? '未知')} → 当前 ${esc(drift.current_ruleset ?? '')}）。报告中“规则判定”一列反映的是当时的规则；以“当前投影”与逐条重新预检为准。`,
    );
  }
  if (pending > 0) {
    parts.push(
      `还有 <b>${pending}</b> 条尚未投影（回填未覆盖），它们按预检的规则值显示，但未计入当前投影统计`,
    );
  }
  if (drift?.decisions_since > 0) {
    parts.push(`预检后有 <b>${drift.decisions_since}</b> 条人工判定改写了投影`);
  }
  // Count comparisons are only attributable to a cause when the batch is fully
  // projected; otherwise the gap is unprojected rows, not a changed conclusion.
  if (pending === 0) {
    if (stats.needs_review !== report.review) {
      parts.push(`当前仍有 <b>${stats.needs_review}</b> 条待复核（预检时 ${report.review} 条）`);
    }
    if (stats.resolved !== report.resolved) {
      parts.push(`当前已解析 <b>${stats.resolved}</b> 条（预检时 ${report.resolved} 条）`);
    }
    if (stats.blocked !== report.blocked) {
      parts.push(`当前阻断 <b>${stats.blocked}</b> 条（预检时 ${report.blocked} 条）`);
    }
  }
  if (parts.length === 0) {
    return '<p class="footnote">预检结论与当前投影一致：规则未变，也尚无人工判定改变过这批值。</p>';
  }
  return `<p class="footnote drift-note">预检（规则视角）与当前投影的差异：${parts.join('；')}。两者都会保留，便于审计是谁、以什么依据改变了结论。</p>`;
}

function renderBatchControls(batch, report) {
  const reviewRows = (report?.items ?? []).filter((i) => i.reason_code === 'BARE_CODE_COLLISION');
  const bulkAllowed = reviewRows.length > 0;
  return `<section class="panel">
    <header class="panel-head">
      <div>
        <h2>歧义值处置</h2>
        <p class="sub">批量策略只在来源系统确有约定时使用；每条被影响的记录都会写入 <code>provenance=operator</code> 与引用了策略的 <code>basis</code>，可逐条审计，也可撤回。</p>
      </div>
    </header>
    <div class="control-grid">
      <div class="control">
        <h3>按来源策略批量映射</h3>
        <p class="hint">当前批次有 <b>${reviewRows.length}</b> 条“裸两字母码同时是国家码与 US 州码”。</p>
        <div class="btn-row">
          <button class="btn btn-sm" id="policy-us-state" ${bulkAllowed ? '' : 'disabled'}>视为 US 州码（如 US-CA）</button>
          <button class="btn btn-sm btn-ghost" id="policy-country" ${bulkAllowed ? '' : 'disabled'}>视为国家码（如 CA）</button>
        </div>
        <p class="hint">需要填写来源依据；这会被引用进每条 basis。</p>
      </div>
      <div class="control">
        <h3>整批暂缓 v2</h3>
        <p class="hint">${batch.override_policy ? `当前已暂缓：${esc(batch.hold_reason ?? '未记录理由')}。v1 仍照常投递。` : '仅影响 v2 投递；不改变任何记录值。'}</p>
        <div class="btn-row">
          <button class="btn btn-sm ${batch.override_policy ? 'btn-ghost' : 'btn-danger'}" id="toggle-hold">${batch.override_policy ? '解除暂缓' : '暂缓 v2 投递'}</button>
        </div>
      </div>
    </div>
  </section>`;
}

function bindBatchControls(batch) {
  const policy = async (rule) => {
    const reason = prompt(
      rule === 'bare-as-us-state'
        ? '来源依据（例如：该仓库自 2019 年起该字段只存 US 州码，有运维记录）：'
        : '来源依据（例如：该字段在来源系统中只存国家码，地区字段另有来源）：',
    );
    if (!reason) return;
    try {
      const data = await api('POST', `/api/batches/${batch.id}/policy`, { policyRule: rule, reason });
      toast(
        `已按策略映射 ${data.applied.length} 条；每条都带人工依据` +
          (data.skipped.length ? `。跳过 ${data.skipped.length} 条已有独立判定的记录（未覆盖）` : ''),
        data.skipped.length ? 'warn' : 'ok',
      );
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  $('#policy-us-state')?.addEventListener('click', () => policy('bare-as-us-state'));
  $('#policy-country')?.addEventListener('click', () => policy('bare-as-country'));
  $('#toggle-hold')?.addEventListener('click', async () => {
    try {
      await api('POST', `/api/batches/${batch.id}/hold`, {
        hold: !batch.override_policy,
        reason: batch.override_policy ? '人工解除策略暂缓' : '人工暂缓 v2 投递',
      });
      toast(batch.override_policy ? '已解除暂缓' : '已暂缓 v2 投递');
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

function renderPreflightTable(report, batch) {
  const rows = report.items;
  return `<section class="panel">
    <header class="panel-head wrap">
      <div>
        <h2>逐条预检（${rows.length} 条）</h2>
        <p class="sub">预检只读、可重复运行。点击任意记录查看它在 v1 / v2 中的实际值与缺失依据。</p>
      </div>
      <div class="filter-row">
        <label class="field inline"><span>筛选</span>
          <select id="prefilter">
            <option value="all">全部</option>
            <option value="review">仅待复核</option>
            <option value="blocked">仅阻断</option>
            <option value="resolved">仅已解析</option>
          </select>
        </label>
      </div>
    </header>
    <div class="table-wrap">
      <table class="data-table" id="preflight-table">
        <thead><tr>
          <th>#</th><th>旧值 legacy_segment</th><th>规则判定（预检）</th><th>规则预测的 v2</th><th>依据（节选）</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => preflightRow(row, batch)).join('')}
        </tbody>
      </table>
    </div>
  </section>`;
}

function preflightRow(row, batch) {
  const v2 =
    row.predicted_status === 'resolved'
      ? `${row.predicted_country ?? 'null'} / ${row.predicted_region ?? 'null'} <span class="presence">${row.predicted_presence}</span>`
      : '<span class="muted">不写入 · 待人工</span>';
  return `<tr data-status="${row.predicted_status}" data-record="${row.record_id}">
    <td class="num">${row.seq}</td>
    <td>${mono(row.legacy_segment === '' ? '（空）' : row.legacy_segment)}</td>
    <td>${statusChip(row.predicted_status)}<span class="reason">${esc(row.reason_label)}</span></td>
    <td class="projection">${v2}</td>
    <td class="basis-cell">${esc(row.basis)}</td>
    <td class="action-cell">${
      row.predicted_status === 'needs_review'
        ? `<button class="btn btn-xs" data-resolve="${row.record_id}">处置</button>`
        : ''
    }</td>
  </tr>`;
}

function bindPreflightTable(batch) {
  const filter = $('#prefilter');
  filter?.addEventListener('change', () => {
    const v = filter.value;
    $$('#preflight-table tbody tr').forEach((tr) => {
      tr.hidden = v !== 'all' && tr.dataset.status !== v;
    });
  });
  $$('[data-resolve]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDecision(btn.dataset.resolve, batch);
    }),
  );
  $$('#preflight-table tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => openTrace(tr.dataset.record)),
  );
}

async function openDecision(recordId, batch) {
  const { records } = await api('GET', `/api/batches/${batch.id}/records`);
  const record = records.find((r) => r.id === recordId);
  if (!record) return;
  const { report } = await api('GET', `/api/batches/${batch.id}/preflight`);
  const item = report.items.find((i) => i.record_id === recordId);
  const dialog = $('#dialog');
  dialog.showModal();

  const candidates = candidateList(recordId, item, record);
  $('#dialog-body').innerHTML = `
    <header class="dialog-head">
      <div>
        <p class="eyebrow">人工判定</p>
        <h2>${mono(record.legacy_segment === '' ? '（空）' : record.legacy_segment)}</h2>
        <p class="sub">${esc(item?.reason_label ?? '')} · ${esc(record.id)}</p>
      </div>
      <button class="icon-btn" id="close-dialog" aria-label="关闭">×</button>
    </header>
    <div class="dialog-body">
      <p class="basis-full">${esc(item?.basis ?? '')}</p>
      <h3>可选值</h3>
      <div class="candidate-list">${candidates}</div>
      <label class="field"><span>判定依据（必填，会写入 v2 的 basis）</span>
        <textarea id="decision-reason" rows="3" placeholder="例如：核对来源系统字典后确认该字段只存国家码"></textarea>
      </label>
      <div class="dialog-actions">
        <button class="btn btn-danger" id="decide-block">无法映射，阻断此记录</button>
        <button class="btn" id="decide-apply" disabled>应用所选值</button>
      </div>
    </div>
  `;

  let chosen = null;
  const readChoice = (el) => {
    const base = JSON.parse(el.dataset.choice);
    if (base.manual) {
      const country = (el.querySelector('.manual-country')?.value ?? '').trim().toUpperCase();
      const region = (el.querySelector('.manual-region')?.value ?? '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) return null;
      return { countryCode: country, regionCode: region || null, regionPresence: region ? 'present' : 'absent' };
    }
    return base;
  };
  $$('.candidate').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      $$('.candidate').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      chosen = readChoice(el);
      $('#decide-apply').disabled = !chosen;
    }),
  );
  $$('.candidate-manual input').forEach((input) => {
    input.addEventListener('click', (e) => e.stopPropagation());
  });
  $('#close-dialog').addEventListener('click', () => dialog.close());
  $('#decide-apply').addEventListener('click', async () => {
    const reason = $('#decision-reason').value.trim();
    try {
      await api('POST', `/api/records/${recordId}/decision`, { choice: chosen, reason });
      dialog.close();
      toast('已写入人工判定；投影与哈希已重算');
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
  $('#decide-block').addEventListener('click', async () => {
    const reason = $('#decision-reason').value.trim();
    try {
      await api('POST', `/api/records/${recordId}/decision`, { choice: 'block', reason });
      dialog.close();
      toast('该记录已阻断；v1 值保留');
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

function candidateList(recordId, item, record) {
  // Preflight candidates may carry region_presence='unknown' (e.g. "US-CA" where
  // the region is not in the built-in table). A human decision must be definite:
  // choosing a candidate IS the assertion, so a region code becomes 'present'.
  // The server rejects contradictory combinations; normalise here so a valid
  // candidate is never refused for a presence the operator did not pick.
  const built = (item?.candidates ?? []).map((c) => ({
    label: c.label,
    rationale: c.rationale,
    choice: {
      countryCode: c.country_code,
      regionCode: c.region_code,
      regionPresence: c.region_code ? 'present' : 'absent',
    },
  }));
  if (built.length === 0) {
    built.push({
      label: '预检没有给出候选：手动填写',
      rationale: '请填写 ISO 3166-1 两字母国家码；地区留空表示“本来没有地区”。保存为人工判定并写入依据。',
      manual: true,
    });
  }
  return built
    .map(
      (c) => `<button class="candidate ${c.manual ? 'candidate-manual' : ''}" data-choice='${esc(JSON.stringify(c.choice ?? {}))}'>
        <span class="candidate-title">${esc(c.label)}</span>
        <span class="candidate-why">${esc(c.rationale)}</span>
        ${c.manual ? `<span class="manual-fields">
          <label>国家码 <input class="manual-country" maxlength="2" placeholder="US" /></label>
          <label>地区码 <input class="manual-region" maxlength="3" placeholder="CA（可留空）" /></label>
        </span>` : ''}
      </button>`,
    )
    .join('');
}

/* ---------- ingest ---------- */

function renderIngestForm() {
  return `<section class="panel">
    <header class="panel-head">
      <div>
        <h2>接入新批次（模拟接入器）</h2>
        <p class="sub">每行一个旧值。接入器会立即预检；若含多值或空段，v2 投递会被自动暂缓，v1 不受影响。</p>
      </div>
    </header>
    <form id="ingest-form" class="ingest-form">
      <div class="form-grid">
        <label class="field"><span>批次标签</span><input name="label" required placeholder="例如：CRM 增量 #2026-11-17" /></label>
        <label class="field"><span>来源系统</span><input name="origin" value="crm.export" /></label>
      </div>
      <label class="field"><span>旧值（每行一个）</span>
        <textarea name="raw" rows="5" class="mono" placeholder="US-CA&#10;CA&#10;DE-BE&#10;US-CA;US-NV">US-CA
DE-BE
CA
N/A</textarea>
      </label>
      <div class="btn-row"><button class="btn" type="submit">接入并预检</button></div>
    </form>
  </section>`;
}

function bindIngestForm() {
  $('#ingest-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      const data = await api('POST', '/api/ingest', {
        label: form.get('label'),
        origin: form.get('origin'),
        raw: form.get('raw'),
      });
      state.selectedBatch = data.batch_id;
      toast(`已接入 ${data.report.total} 条；结论 ${data.report.verdict}`);
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

/* ---------- contracts ---------- */

function renderContracts() {
  const [v1, v2] = state.data.contracts;
  $('#view').innerHTML = `
    <section class="panel">
      <header class="panel-head wrap">
        <div>
          <h2>发布状态</h2>
          <p class="sub">两个版本同时对外发布，各自有独立的不可变哈希。已切换的消费端回传的是它实际读到的那个哈希，而不是“最新版”这个说法。</p>
        </div>
        <div class="btn-row">
          <button class="btn" id="publish-both">发布 v1 + v2</button>
        </div>
      </header>
      <div class="publish-strip">
        ${state.data.contracts
          .map((c) => {
            // The digest a delivery would carry comes from the code; the digest
            // in the published record comes from the database. Showing only the
            // first would make "the contract changed but nobody republished it"
            // look like a normal published contract.
            const drift = c.published_status === 'drifted';
            const chip = drift
              ? '<span class="chip chip-warn">现行摘要与已发布记录不一致</span>'
              : c.published_status === 'unpublished'
                ? '<span class="chip chip-warn">尚未发布</span>'
                : `<span class="chip ${c.version === 1 ? 'chip-old' : 'chip-new'}">v${c.version} 已发布</span>`;
            return `<div class="publish-item">
              ${chip}
              <code class="hash mono">${esc(c.sha256)}</code>
              <span class="muted">${esc(c.contract_id)}</span>
              ${
                drift
                  ? `<span class="notice-bad">已发布记录中是 <code class="mono">${esc(c.published_sha256)}</code>；消费端若按启动时读到的合同校验，会拒收而不是按新语义解析。请重新发布并让消费端重新确认。</span>`
                  : ''
              }
            </div>`;
          })
          .join('')}
      </div>
      <p class="footnote">${state.data.contracts
        .map((c) => `v${c.version} 发布于 ${c.published_at ? esc(c.published_at) : '尚未发布'}`)
        .join(' · ')}</p>
    </section>

    <section class="contract-grid">
      ${contractCard(v1, 'old')}
      ${contractCard(v2, 'new')}
    </section>
    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>两个合同到底改了什么</h2>
          <p class="sub">v1 保持原义、冻结且不可变；v2 的每个空值都必须带缺失依据。</p>
        </div>
      </header>
      <div class="table-wrap">
        <table class="data-table diff-table">
          <thead><tr><th>方面</th><th>v1（旧）</th><th>v2（新）</th></tr></thead>
          <tbody>
            ${state.data.contract_diff
              .map((d) => `<tr><td class="diff-aspect">${esc(d.aspect)}</td><td>${esc(d.v1)}</td><td>${esc(d.v2)}</td></tr>`)
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel two-col">
      <div>
        <header class="panel-head"><h2>v2 不变量</h2></header>
        <ul class="rule-list">
          ${v2.invariants.map((i) => `<li>${esc(i)}</li>`).join('')}
        </ul>
      </div>
      <div>
        <header class="panel-head"><h2>消费端如何确认切换</h2></header>
        <ol class="rule-list numbered">
          <li>读取当前发布的合同文档与其 SHA-256。</li>
          <li>显式声明订阅版本（<code>POST /api/consumers/:id/switch</code>）。</li>
          <li>回传合同 SHA 前缀（至少 12 位）；不匹配即拒绝，视为未切换。</li>
          <li>只有“版本 + SHA”都成立才接收 v2；在此之前只收到 v1 或被明确拒收。</li>
          <li>迟到的 ACK 只更新 <code>acked_at</code>，不会把“未切换”变成“已切换”。</li>
        </ol>
        <p class="footnote">拒收原因会落在 deliveries 表里（如 <code>NOT_SWITCHED</code>、<code>SHA_UNCONFIRMED</code>、<code>V2_BUNDLE_INVALID</code>），可逐条向消费端出示。</p>
      </div>
    </section>
    <section class="panel">
      <header class="panel-head"><h2>v2 JSON Schema</h2></header>
      <pre class="code-block">${esc(JSON.stringify(v2.schema, null, 2))}</pre>
    </section>
  `;

  $('#publish-both').addEventListener('click', async () => {
    try {
      const r1 = await api('POST', '/api/contracts/1/publish');
      const r2 = await api('POST', '/api/contracts/2/publish');
      toast(
        `已发布 v1 ${shortSha(r1.published.sha256)}（${r1.published.unchanged ? '内容未变' : '内容变化'}）· v2 ${shortSha(r2.published.sha256)}`,
        'ok',
      );
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

function contractCard(contract, tone) {
  return `<article class="contract contract-${tone}">
    <header>
      <p class="eyebrow">${tone === 'old' ? '冻结 · 不可原地修改' : '需要显式切换'}</p>
      <h2>${esc(contract.title)}</h2>
      <p class="contract-id mono">${esc(contract.contract_id)}</p>
    </header>
    <p class="contract-summary">${esc(contract.summary)}</p>
    <div class="hash-row">
      <span class="hash-label">SHA-256</span>
      <code class="hash mono">${esc(contract.sha256)}</code>
    </div>
    <ul class="sem-list">
      ${contract.status_semantics.map((s) => `<li>${esc(s)}</li>`).join('')}
    </ul>
    <footer class="contract-foot">
      <span>兼容策略：${esc(contract.compatibility.unknown_policy ?? '—')}</span>
    </footer>
  </article>`;
}

/* ---------- consumers ---------- */

function renderConsumers() {
  const d = state.data;
  const batches = d.batches;
  if (!state.selectedBatch) state.selectedBatch = batches[0]?.id ?? null;
  const batch = selectedBatch();

  $('#view').innerHTML = `
    <section class="panel">
      <header class="panel-head wrap">
        <div>
          <h2>消费端订阅状态</h2>
          <p class="sub">“已声明”只是版本号；“已确认”还要求回传的合同 SHA 与当前发布一致。两者都成立才算切换完成。</p>
        </div>
        <button class="btn btn-ghost btn-sm" id="simulate-late">模拟“迟到的旧消费端确认”</button>
      </header>
      <div class="consumer-grid">
        ${d.consumers.map(consumerCard).join('')}
      </div>
    </section>

    <section class="panel">
      <header class="panel-head wrap">
        <div>
          <h2>投递与确认</h2>
          <p class="sub">选择批次后分别向各消费端投递。v1 端永远拿原值；v2 端受 schema、哈希与批次策略三重闸门。</p>
        </div>
        <div class="filter-row">
          <label class="field inline"><span>批次</span>
            <select id="deliver-batch">
              ${batches
                .map((b) => `<option value="${b.id}" ${b.id === batch?.id ? 'selected' : ''}>${esc(b.label)}（${b.record_count} 条）</option>`)
                .join('')}
            </select>
          </label>
          <button class="btn" id="deliver-all">向所有已切换消费端投递</button>
        </div>
      </header>
      ${batch ? renderDeliveryTable(batch) : ''}
    </section>

    <section class="panel">
      <header class="panel-head">
        <div>
          <h2>拒绝不兼容数据（消费端自检）</h2>
          <p class="sub">这条记录来自旧系统、形状可疑。下面的校验与严格的 v2 消费端在收到单条数据时执行的是同一套规则。</p>
        </div>
      </header>
      <div class="validator">
        <label class="field"><span>待校验的 v2 条目（JSON）</span>
          <textarea id="validate-input" rows="9" class="mono">${esc(JSON.stringify({
            record_id: 'demo-1',
            split_status: 'resolved',
            country_code: null,
            region_code: 'CA',
            region_presence: 'unknown',
            reason_code: '',
            provenance: 'derived',
            basis: '',
            source_hash: 'not-a-hash',
          }, null, 2))}</textarea>
        </label>
        <div class="validator-side">
          <button class="btn" id="validate-btn">运行校验</button>
          <div id="validate-out" class="validate-out muted">尚未运行</div>
          <p class="hint">尝试把 <code>split_status</code> 改为 <code>resolved</code> 并让 <code>country_code=null</code>，或把 <code>region_presence</code> 改成 <code>unknown</code>，观察拒收理由。</p>
        </div>
      </div>
    </section>

    ${batch ? renderBackfillPanel(batch) : ''}
  `;

  bindConsumers(batch);
}

function consumerCard(c) {
  const tone = c.contract_version === 2 ? 'new' : c.contract_version === 1 ? 'old' : 'none';
  // A switch is a statement about a specific document. If that document has
  // since changed, the stored confirmation is stale — the chip must not keep
  // saying "confirmed" for bytes the consumer never saw.
  const contract = state.data.contracts.find((x) => x.version === c.contract_version);
  const stale = Boolean(c.switch_stale);
  const status = c.contract_version == null
    ? '<span class="chip chip-warn"><span class="dot dot-warn"></span>未切换</span>'
    : stale
      ? '<span class="chip chip-bad"><span class="dot dot-bad"></span>确认的合同已被改动</span>'
      : c.contract_sha
        ? `<span class="chip chip-ok"><span class="dot dot-ok"></span>已确认 v${c.contract_version}</span>`
        : `<span class="chip chip-warn"><span class="dot dot-warn"></span>已声明 v${c.contract_version} · 未确认哈希</span>`;
  return `<article class="consumer consumer-${tone}">
    <div class="consumer-top">
      <h3>${esc(c.name)}</h3>
      ${status}
    </div>
    <p class="consumer-meta">策略 <code>${esc(c.policy)}</code> · 能力 [${c.supported_versions.join(', ')}]</p>
    <p class="consumer-sha">${c.contract_sha ? `合同 ${mono(shortSha(c.contract_sha))}` : '尚未回传合同哈希'}</p>
    ${stale ? `<p class="notice-bad">当前 v${c.contract_version} 是 ${esc(shortSha(contract.sha256))}。该消费端确认的是旧字节，下次交付会被 CONTRACT_CHANGED 拒收，直到它重新确认。</p>` : ''}
    <p class="consumer-time">${c.switched_at ? `切换于 ${fullTime(c.switched_at)}` : '没有任何切换记录'}</p>
    <div class="btn-row">
      ${c.supported_versions.map((v) => `<button class="btn btn-xs ${c.contract_version === v ? 'btn-ghost' : ''}" data-switch="${c.id}" data-version="${v}">声明 v${v}</button>`).join('')}
    </div>
  </article>`;
}

// Switching is a handshake, not a toggle: the consumer must show that it read
// the exact document. Pasting a wrong hash is a supported (and instructive)
// path — the server rejects it and the UI explains why.
function openSwitch(consumerId, version) {
  const consumer = state.data.consumers.find((c) => c.id === consumerId);
  const contract = state.data.contracts.find((c) => c.version === version);
  const dialog = $('#dialog');
  dialog.showModal();
  $('#dialog-body').innerHTML = `
    <header class="dialog-head">
      <div>
        <p class="eyebrow">订阅握手</p>
        <h2>${esc(consumer?.name ?? consumerId)}</h2>
        <p class="sub">声明订阅 v${version}，并回传你实际读到的合同哈希。</p>
      </div>
      <button class="icon-btn" id="close-dialog" aria-label="关闭">×</button>
    </header>
    <div class="dialog-body">
      <div class="handshake">
        <div class="handshake-step"><span class="step-no">1</span><span>当前发布的 v${version} 合同</span></div>
        <code class="hash mono">${esc(contract.sha256)}</code>
        <div class="handshake-step"><span class="step-no">2</span><span>由消费端回传（粘贴前 12 位以上即可）</span></div>
        <input id="switch-sha" class="mono sha-input" value="${esc(contract.sha256.slice(0, 12))}" spellcheck="false" />
        <p class="hint" id="switch-hint">为了演示：可以故意粘贴一个错误前缀，观察握手被拒绝。</p>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" id="switch-cancel">取消</button>
        <button class="btn" id="switch-confirm">声明并确认 v${version}</button>
      </div>
    </div>`;
  $('#close-dialog').addEventListener('click', () => dialog.close());
  $('#switch-cancel').addEventListener('click', () => dialog.close());
  $('#switch-confirm').addEventListener('click', async () => {
    const sha = $('#switch-sha').value.trim();
    try {
      await api('POST', `/api/consumers/${consumerId}/switch`, { version, sha });
      dialog.close();
      toast(`${consumer?.name ?? consumerId} 已确认订阅 v${version}`);
      render();
    } catch (e) {
      $('#switch-hint').textContent = `被拒绝：${e.message}`;
      $('#switch-hint').classList.add('hint-bad');
    }
  });
}

const REJECT_LABELS = {
  NOT_SWITCHED: '未声明订阅',
  SHA_UNCONFIRMED: '未确认合同哈希',
  UNSUPPORTED_VERSION: '声称的版本超出能力',
  CONTRACT_CHANGED: '已确认的合同已被改动',
  V2_BUNDLE_INVALID: '载荷不符合 v2 schema',
  STRICT_NO_QUARANTINE: '严格端不收隔离项',
  STRICT_NO_EXCLUSION: '严格端不收排除项',
  BACKFILL_INCOMPLETE: '批次未回填完',
  LOSSY_VALUES_PRESENT: '含多值/空段',
  REVIEW_SHARE_EXCEEDED: '待复核比例超阈值',
  BATCH_BLOCKED: '整批已阻断',
  BATCH_ON_HOLD: '整批暂缓 v2',
};

function renderDeliveryTable(batch) {
  const deliveries = batch.deliveries;
  return `<div class="table-wrap">
    <table class="data-table">
      <thead><tr>
        <th>消费端</th><th>版本</th><th>状态</th><th>行数</th><th>隔离 / 排除</th><th>载荷哈希</th><th>投递</th><th>确认</th><th></th>
      </tr></thead>
      <tbody>
        ${deliveries.length === 0 ? '<tr><td colspan="9" class="empty">该批次尚未投递</td></tr>' : ''}
        ${deliveries.map((d) => {
          const late = d.acked_at && new Date(d.acked_at) - new Date(d.delivered_at) > state.data.policy.lateAckMinutes * 60_000;
          const holdNote = d.rejection_code === 'BATCH_ON_HOLD' || d.rejection_code === 'BATCH_BLOCKED';
          return `<tr>
            <td>${esc(d.consumer_name)}</td>
            <td>${d.contract_version ? `v${d.contract_version}` : '—'}</td>
            <td>${statusChip(d.status)}${d.rejection_code ? `<span class="reason">${esc(REJECT_LABELS[d.rejection_code] ?? d.rejection_code)}</span>` : ''}</td>
            <td class="num">${d.row_count ?? '—'}</td>
            <td class="num">${d.quarantined_count ?? 0} / ${d.excluded_count ?? 0}</td>
            <td>${d.payload_hash ? mono(shortSha(d.payload_hash)) : '<span class="muted">—</span>'}</td>
            <td>${d.delivered_at ? time(d.delivered_at) : '—'}</td>
            <td>${d.acked_at ? `${time(d.acked_at)}${late ? ' <span class="chip chip-warn">迟到</span>' : ' <span class="chip chip-ok">准时</span>'}` : '<span class="muted">未确认</span>'}</td>
            <td>${d.status === 'delivered' && !d.acked_at ? `<button class="btn btn-xs" data-ack="${d.id}">确认</button>` : ''}${
              d.rejection_detail ? `<button class="btn btn-xs btn-ghost" data-reject-detail="${esc(d.rejection_detail)}" data-code="${esc(d.rejection_code)}" data-label="${esc(REJECT_LABELS[d.rejection_code] ?? d.rejection_code)}">原因</button>` : ''
            }</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p class="table-note">隔离 = v2 中 <code>needs_review</code> 的条数，消费端必须单独存放；排除 = 完全未进入 v2 的条数。</p>
  </div>`;
}

function renderBackfillPanel(batch) {
  const runs = state.data.backfills;
  return `<section class="panel">
    <header class="panel-head wrap">
      <div>
        <h2>回填：中断与恢复</h2>
        <p class="sub">回填按 (批次, seq) 游标推进，每条投影落盘后才前移游标。中断不会留下半条记录，恢复也不会重算已落盘的投影。</p>
      </div>
      <div class="btn-row">
        <label class="field inline"><span>在第 N 条后中断</span><input id="interrupt-at" type="number" min="1" value="7" class="num-input" /></label>
        <button class="btn" id="start-backfill">开始回填「${esc(batch.label)}」</button>
      </div>
    </header>
    <div class="run-list">
      ${runs.length === 0 ? '<p class="empty">还没有回填任务。</p>' : ''}
      ${runs
        .map((r) => {
          const label = state.data.batches.find((b) => b.id === r.target_batch)?.label ?? r.target_batch;
          return `<article class="run">
            <div class="run-top">
              <span class="run-id mono">${esc(r.id)}</span>
              ${statusChip(r.status)}
            </div>
            <p class="run-meta">${esc(label)} · 已处理 ${r.processed_count} / ${r.target_count} · 剩余 ${r.remaining}</p>
            <div class="meter"><span style="width:${r.target_count ? (r.processed_count / r.target_count) * 100 : 0}%"></span></div>
            <p class="run-cursor">游标：seq ${r.cursor_seq}${r.interrupt_at ? ` · 计划在第 ${r.interrupt_at} 条中断` : ''}</p>
            <div class="btn-row">
              ${r.status === 'interrupted' ? `<button class="btn btn-xs" data-resume="${r.id}">从游标恢复</button>` : ''}
              ${r.status === 'running' ? `<button class="btn btn-xs" data-step="${r.id}">推进一步</button>` : ''}
            </div>
          </article>`;
        })
        .join('')}
    </div>
  </section>`;
}

function bindConsumers(batch) {
  $$('[data-switch]').forEach((btn) =>
    btn.addEventListener('click', () => openSwitch(btn.dataset.switch, Number(btn.dataset.version))),
  );

  $('#deliver-batch')?.addEventListener('change', (e) => {
    state.selectedBatch = e.target.value;
    render();
  });
  $('#deliver-all')?.addEventListener('click', async () => {
    if (!batch) return;
    const ids = state.data.consumers.map((c) => c.id);
    try {
      const data = await api('POST', `/api/batches/${batch.id}/deliver`, { consumerIds: ids });
      const ok = data.results.filter((r) => r.status === 'delivered').length;
      toast(`投递完成：${ok}/${data.results.length} 成功，其余明确拒收`);
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
  $$('[data-ack]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const minutes = Number(prompt('模拟确认延迟（分钟）。超过 60 分钟会标记为迟到。', '2') ?? 0);
      if (Number.isNaN(minutes)) return;
      try {
        const data = await api('POST', `/api/deliveries/${btn.dataset.ack}/ack`, {
          simulatedLateMinutes: minutes,
          note: minutes > 60 ? '批处理窗口结束后才回 ACK' : '正常确认',
        });
        toast(data.late ? '确认已记录，但标记为迟到' : '确认已记录', data.late ? 'warn' : 'ok');
        render();
      } catch (e) {
        toast(e.message, 'bad');
      }
    }),
  );
  $$('[data-reject-detail]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const dialog = $('#dialog');
      dialog.showModal();
      $('#dialog-body').innerHTML = `
        <header class="dialog-head"><div><p class="eyebrow">拒收原因</p><h2>${esc(btn.dataset.label)}</h2><p class="sub mono">${esc(btn.dataset.code)}</p></div>
        <button class="icon-btn" id="close-dialog" aria-label="关闭">×</button></header>
        <div class="dialog-body"><p class="basis-full">${esc(btn.dataset.rejectDetail)}</p>
        <p class="footnote">拒收记录已写入投递表；v1 消费端不受同一决定影响。</p></div>`;
      $('#close-dialog').addEventListener('click', () => dialog.close());
    }),
  );
  // The "slow old consumer" story in one click: it is still on v1, receives v1,
  // and only acknowledges hours later. Its late ACK must not be read as consent
  // to v2, and the v2 consumers' state must be untouched.
  $('#simulate-late')?.addEventListener('click', async () => {
    const target = state.data.consumers.find((c) => c.contract_version === 1) ??
      state.data.consumers.find((c) => c.id === 'legacy-ledger');
    if (!target) return toast('没有可用的旧消费端', 'bad');
    const contractV1 = state.data.contracts.find((c) => c.version === 1);
    const steps = [];
    try {
      if (target.contract_version !== 1) {
        await api('POST', `/api/consumers/${target.id}/switch`, { version: 1, sha: contractV1.sha256 });
        steps.push(`${target.id} 声明并确认 v1`);
      }
      let delivery = state.data.batches
        .flatMap((b) => b.deliveries)
        .find((d) => d.consumer_id === target.id && d.status === 'delivered');
      if (!delivery) {
        const batch = state.data.batches.find((b) => b.stats.resolved > 0) ?? state.data.batches[0];
        const result = await api('POST', `/api/batches/${batch.id}/deliver`, { consumerIds: [target.id] });
        if (result.results[0]?.status !== 'delivered') throw new Error(result.results[0]?.detail ?? '投递失败');
        steps.push(`向其投递 v1（${batch.label}，${result.results[0].rowCount} 条）`);
        await refresh();
        delivery = state.data.batches.flatMap((b) => b.deliveries).find((d) => d.consumer_id === target.id && d.status === 'delivered');
      }
      if (!delivery) throw new Error('没有可确认的 v1 投递');
      const data = await api('POST', `/api/deliveries/${delivery.id}/ack`, {
        simulatedLateMinutes: 300,
        note: '旧消费端在夜间批处理结束后才确认；此确认只针对 v1',
      });
      steps.push(`确认时间 ${fullTime(data.delivery.acked_at)}，标记为迟到`);
      toast(`已模拟：${steps.join('；')}。v2 订阅状态未被改动。`, 'warn');
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  $('#validate-btn')?.addEventListener('click', async () => {
    let item;
    try {
      item = JSON.parse($('#validate-input').value);
    } catch {
      return toast('JSON 解析失败', 'bad');
    }
    const out = await api('POST', '/api/validate-item', { item });
    $('#validate-out').classList.remove('muted');
    $('#validate-out').innerHTML = out.errors.length
      ? `<p class="validate-title bad">拒收 · ${out.errors.length} 项不满足 ${esc(out.contract)}</p><ul class="rule-list compact">${out.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
      : `<p class="validate-title ok">接受 · 满足 v2 不变量</p><p class="hint">${esc(out.note)}</p>`;
  });

  $('#start-backfill')?.addEventListener('click', async () => {
    if (!batch) return;
    const interruptAfter = Number($('#interrupt-at').value) || null;
    try {
      await api('POST', '/api/backfills', { batchId: batch.id, interruptAfter });
      toast(interruptAfter ? `已回填并在第 ${interruptAfter} 条后中断` : '回填完成', 'ok');
      render();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
  $$('[data-resume]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        const data = await api('POST', `/api/backfills/${btn.dataset.resume}/resume`);
        toast(`已从游标恢复并完成：累计 ${data.run.processed_count} 条`);
        render();
      } catch (e) {
        toast(e.message, 'bad');
      }
    }),
  );
  $$('[data-step]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api('POST', `/api/backfills/${btn.dataset.step}/step`);
      render();
    }),
  );
}

/* ---------- trace ---------- */

function renderTrace(recordId = null) {
  const d = state.data;
  $('#view').innerHTML = `
    <section class="panel">
      <header class="panel-head wrap">
        <div>
          <h2>记录溯源</h2>
          <p class="sub">选择一条记录，看它在 v1、v2 投递载荷里的实际值，以及每个空值的依据。没有投递载荷时会明确说明“未投递”，而不是编造值。</p>
        </div>
        <div class="filter-row">
          <label class="field inline"><span>批次</span>
            <select id="trace-batch">
              ${d.batches.map((b) => `<option value="${b.id}" ${b.id === (state.selectedBatch ?? d.batches[0]?.id) ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}
            </select>
          </label>
          <label class="field inline"><span>记录</span>
            <select id="trace-record"><option>载入中…</option></select>
          </label>
        </div>
      </header>
      <div id="trace-out"><p class="empty">选择一条记录。</p></div>
    </section>
  `;
  const batchSel = $('#trace-batch');
  const recordSel = $('#trace-record');

  const loadRecords = async (batchId, keep = null) => {
    const { records } = await api('GET', `/api/batches/${batchId}/records`);
    recordSel.innerHTML = records
      .map((r) => `<option value="${r.id}" ${r.id === (keep ?? recordId) ? 'selected' : ''}>${r.seq}. ${esc(r.legacy_segment === '' ? '（空）' : r.legacy_segment)} · ${esc(r.split_status ?? '未投影')}</option>`)
      .join('');
    renderTraceDetail(recordSel.value);
  };
  batchSel.addEventListener('change', () => {
    state.selectedBatch = batchSel.value;
    loadRecords(batchSel.value);
  });
  recordSel.addEventListener('change', () => renderTraceDetail(recordSel.value));
  loadRecords(batchSel.value, recordId);
}

async function openTrace(recordId) {
  state.tab = 'trace';
  render();
  await new Promise((r) => setTimeout(r, 0));
  renderTrace(recordId);
}

async function renderTraceDetail(recordId) {
  const out = $('#trace-out');
  if (!recordId) {
    out.innerHTML = '<p class="empty">该批次没有记录。</p>';
    return;
  }
  const trace = await api('GET', `/api/records/${recordId}/trace`);
  const r = trace.record;
  const v1 = trace.v1_item;
  const v2 = trace.v2_item;
  const excluded = trace.v2_exclusion;
  const pre = trace.preflight_item;
  // Deliveries are one-off events; a record can legitimately have none yet.
  // Showing the projection under a clearly-marked "current contract shape"
  // label answers "what would each contract carry" without pretending a
  // delivery happened.
  const v1Preview = !v1 && trace.v1_preview;
  const v2Preview = !v2 && !excluded && (trace.v2_preview || trace.v2_preview_exclusion);
  const v2Shown = v2 ?? (v2Preview ? trace.v2_preview : null);
  const exclusionShown = excluded ?? (v2Preview ? trace.v2_preview_exclusion : null);
  const v2PreviewOnly = !v2 && v2Preview;

  out.innerHTML = `
    <div class="trace-head">
      <div>
        <p class="eyebrow">旧值</p>
        <p class="trace-legacy mono">${esc(r.legacy_segment === '' ? '（空字符串）' : r.legacy_segment)}</p>
      </div>
      <div class="trace-meta">
        <span>${mono(r.id)}</span>
        <span>${esc(trace.batch.label)} · 第 ${r.seq} 条</span>
        ${statusChip(r.split_status ?? 'pending')}
      </div>
    </div>

    <div class="contract-compare">
      <article class="compare-card compare-v1">
        <header><span class="chip chip-old">v1 · 旧合同</span><h3>${v1 ? '实际投递值' : '按 v1 合同应有的值'}</h3></header>
        ${v1 || v1Preview
          ? (() => {
              const item = v1 ?? trace.v1_preview;
              return `<dl class="kv">
              <dt>record_id</dt><dd>${mono(item.record_id)}</dd>
              <dt>legacy_segment</dt><dd>${mono(JSON.stringify(item.legacy_segment))}</dd>
              <dt>ingested_at</dt><dd>${esc(item.ingested_at)}</dd>
            </dl>`;
            })()
          : `<p class="compare-note muted">该记录无法读出 v1 载荷。</p>`}
        <p class="compare-note">v1 原样携带旧字符串；它不区分“没有地区”和“解析失败”，这是旧合同的已知语义。${
          v1Preview ? ' 本条尚未投递，显示的是当前将投递的形状。' : ''
        }</p>
        <p class="compare-note muted">contract_sha · ${mono(shortSha(trace.contract_sha?.['1']))}…</p>
      </article>

      <article class="compare-card compare-v2">
        <header><span class="chip chip-new">v2 · 新合同</span><h3>${
          v2 ? '实际投递值' : exclusionShown ? '被排除（不投递）' : v2PreviewOnly ? '按 v2 合同应有的值' : '尚未投递'
        }</h3></header>
        ${v2Shown
          ? `<dl class="kv">
              <dt>split_status</dt><dd>${statusChip(v2Shown.split_status)}</dd>
              <dt>country_code</dt><dd>${v2Shown.country_code ? mono(v2Shown.country_code) : `<span class="null-value">null</span>`}</dd>
              <dt>region_code</dt><dd>${v2Shown.region_code ? mono(v2Shown.region_code) : `<span class="null-value">null</span>`}</dd>
              <dt>region_presence</dt><dd>${mono(v2Shown.region_presence)}</dd>
              <dt>reason_code</dt><dd>${mono(v2Shown.reason_code)} <span class="muted">${esc(state.data.reasons[v2Shown.reason_code] ?? '')}</span></dd>
              <dt>provenance</dt><dd>${mono(v2Shown.provenance)}</dd>
              <dt>source_hash</dt><dd>${mono(shortSha(v2Shown.source_hash))}…</dd>
            </dl>
            <div class="basis-block"><span class="basis-label">为什么是这个值</span><p>${esc(v2Shown.basis)}</p></div>
            ${v2PreviewOnly ? '<p class="compare-note muted">本条尚未投递给 v2 消费端，显示的是当前投影按 v2 合同会生成的载荷。</p>' : ''}
            <p class="compare-note muted">contract_sha · ${mono(shortSha(trace.contract_sha?.['2']))}…</p>`
          : exclusionShown
            ? `<dl class="kv">
                <dt>排除原因</dt><dd>${mono(exclusionShown.reason_code)} <span class="muted">${esc(exclusionShown.reason_label)}</span></dd>
                <dt>basis</dt><dd>${esc(exclusionShown.basis)}</dd>
              </dl>
              <p class="compare-note muted">v2 载荷会带一条显式排除项；消费端能看到它，而不是遇到静默缺口。</p>`
            : `<p class="compare-note muted">该记录尚未投影到 v2，因此没有值可展示。</p>`}
      </article>
    </div>

    ${r.split_status ? `
    <div class="basis-panel">
      <h3>当前投影（数据库中的真值）</h3>
      <dl class="kv wide">
        <dt>split_status</dt><dd>${statusChip(r.split_status)}</dd>
        <dt>country / region</dt><dd>${r.country_code ? mono(r.country_code) : '<span class="null-value">null</span>'} / ${r.region_code ? mono(r.region_code) : '<span class="null-value">null</span>'}</dd>
        <dt>region_presence</dt><dd>${mono(r.region_presence)} <span class="muted">${
          r.split_status === 'blocked'
            ? '（阻断记录不进入 v2，presence 只是占位，不表示“地区未知”）'
            : r.region_presence === 'absent'
              ? '（原本没有地区）'
              : r.region_presence === 'unknown'
                ? '（地区未知，不是没有）'
                : '（地区存在）'
        }</span></dd>
        <dt>reason_code</dt><dd>${mono(r.reason_code)} <span class="muted">${esc(r.reason_label ?? '')}</span></dd>
        <dt>rule</dt><dd>${mono(r.rule_id)}</dd>
        <dt>provenance</dt><dd>${mono(r.provenance)}</dd>
        <dt>projection_rev</dt><dd>${r.projection_rev}</dd>
        <dt>basis</dt><dd>${esc(r.basis ?? '')}</dd>
      </dl>
      ${r.decision ? `<div class="decision-block"><span class="basis-label">人工判定 · ${esc(r.decision.actor)} · ${fullTime(r.decision.created_at)}</span><p>${esc(r.decision.reason)}</p><button class="btn btn-xs btn-ghost" data-clear-decision="${r.id}">撤回判定，按规则重算</button></div>` : ''}
    </div>` : '<p class="footnote">该记录尚未被回填投影；所有空值都是“未处理”，不能解释成“没有地区”。</p>'}

    ${pre ? `<details class="pre-details"><summary>预检时的规则判定</summary><p>${esc(pre.basis)}</p></details>` : ''}

    <div class="next-steps">
      <span class="next-label">这条记录接下来</span>
      <div class="next-items">
        ${nextStepsFor(trace)}
      </div>
    </div>
  `;

  $('[data-clear-decision]')?.addEventListener('click', async () => {
    try {
      await api('POST', `/api/records/${recordId}/decision/clear`);
      toast('已撤回人工判定并重算');
      renderTraceDetail(recordId);
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

// What a consumer/operator must do next, derived from this record's actual
// state — not from the batch's headline verdict.
function nextStepsFor(trace) {
  const r = trace.record;
  const v1 = trace.v1_item;
  const v2 = trace.v2_item;
  const excluded = trace.v2_exclusion;
  const items = [];

  if (!v1) {
    items.push({ tone: 'warn', text: '尚未向任何 v1 消费端投递。旧值仍原样保存在库中，v1 随时可补投。' });
  } else {
    items.push({ tone: 'ok', text: `v1 消费者看到的是原字符串 ${JSON.stringify(v1.legacy_segment)}，不会因为拆分而改变。` });
  }

  if (r.split_status === 'needs_review') {
    items.push({
      tone: 'warn',
      text: 'v2 不会为这条记录写任何值。消费端必须把它放进隔离区，并保留原因码，不能把 null 当作“没有地区”。',
    });
  } else if (r.split_status === 'blocked') {
    items.push({
      tone: 'bad',
      text: 'v2 完全不投递这条记录。若批次其余记录投递，消费端会看到一条显式排除项而不是静默缺口。',
    });
  } else if (r.split_status === 'resolved') {
    if (v2) {
      items.push({
        tone: 'ok',
        text: `v2 消费者可直接使用 country_code=${v2.country_code ?? 'null'}、region_code=${v2.region_code ?? 'null'}、presence=${v2.region_presence}；basis 可供审计。`,
      });
    } else if (excluded) {
      items.push({ tone: 'bad', text: `v2 投递时被排除：${excluded.reason_label}。` });
    } else {
      items.push({ tone: 'muted', text: 'v2 值已就绪，但尚未向 v2 消费端投递。' });
    }
  } else {
    items.push({ tone: 'warn', text: '尚未投影（回填未覆盖）。此刻的 null 表示“未处理”，不能当作“没有地区”。' });
  }

  if (r.decision) {
    items.push({
      tone: 'ok',
      text: `当前结论来自人工判定（${r.decision.actor}），basis 引用了该判定及其理由；撤回后会自动按规则重算。`,
    });
  }

  return items
    .map((i) => `<span class="next-item next-${i.tone}"><span class="next-dot"></span>${esc(i.text)}</span>`)
    .join('');
}

/* ---------- app ---------- */

function render() {
  renderTabs();
  const fn = {
    overview: renderOverview,
    preflight: renderPreflight,
    contracts: renderContracts,
    consumers: renderConsumers,
    trace: () => renderTrace(),
  }[state.tab];
  fn();
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

$('#refresh').addEventListener('click', () => refresh().then(() => toast('已刷新')));
$('#reset').addEventListener('click', async () => {
  if (!confirm('重置所有批次、判定、投递与回填记录？')) return;
  await api('POST', '/api/reset');
  toast('已重置为初始演示数据');
  render();
});

refresh().catch((e) => toast(`加载失败：${e.message}`, 'bad'));
