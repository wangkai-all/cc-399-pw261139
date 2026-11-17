import { canonicalJson, sha256 } from './db.js';

// Contract v1 is frozen: it is the shape the old consumers already parse. Its
// hash is stored and displayed so "nothing silently changed" is checkable.
export const CONTRACT_V1 = {
  contract_id: 'pointwise.segment@1',
  version: 1,
  title: '旧段值合同',
  summary:
    '单字段 legacy_segment 原样传输。消费端自行解释 "国家-地区" 的含义；合同本身不承诺拆分，也不承诺地区缺失的原因。',
  status_semantics: [
    'legacy_segment 是唯一位置字段，可能包含国家、国家-地区、裸区划码、别名、占位符或多值。',
    '合同不区分 "没有地区" 与 "地区无法解析"：两者都会呈现为同一个字符串。',
    '这是 v1 的已知语义，不是缺陷；它不能被原地修改，否则旧消费端会静默改变含义。',
  ],
  schema: {
    type: 'object',
    required: ['record_id', 'legacy_segment', 'ingested_at'],
    additionalProperties: false,
    properties: {
      record_id: { type: 'string' },
      legacy_segment: { type: ['string', 'null'], description: '原样保留的旧位置字段' },
      ingested_at: { type: 'string', format: 'date-time' },
    },
  },
  compatibility: {
    immutable: true,
    consumers: ['legacy-ledger', 'risk-scoring', 'intake-adapter'],
  },
};

// Contract v2 is explicit about missingness. A null is never allowed to mean
// "we could not tell" — that case must be quarantined with a reason code.
export const CONTRACT_V2 = {
  contract_id: 'pointwise.segment@2',
  version: 2,
  title: '拆分投影合同',
  summary:
    '把位置拆成 country_code / region_code，并用 region_presence 区分 "本来没有地区" 与 "地区未知"。无法可靠拆分的记录不进入正常结果，而是带 reason_code 进入隔离区。',
  status_semantics: [
    'resolved：两个字段都有可信来源；region_code=null 只在 region_presence=absent 时合法。',
    'needs_review：必须携带 reason_code 与 basis，消费者必须隔离，不得把 null 当作 "没有地区"。',
    'blocked：不投递。无法转换的值不能伪装成完整值。',
    'provenance 区分 derived（规则推导）、operator（人工判定）与 legacy（未投影）。',
  ],
  schema: {
    type: 'object',
    required: [
      'record_id',
      'split_status',
      'country_code',
      'region_code',
      'region_presence',
      'reason_code',
      'provenance',
      'basis',
    ],
    additionalProperties: false,
    properties: {
      record_id: { type: 'string' },
      split_status: { enum: ['resolved', 'needs_review'] },
      country_code: { type: ['string', 'null'], pattern: '^[A-Z]{2}$' },
      region_code: { type: ['string', 'null'], pattern: '^[A-Z0-9]{1,3}$' },
      region_presence: { enum: ['present', 'absent', 'unknown'] },
      reason_code: { type: 'string' },
      provenance: { enum: ['derived', 'operator'] },
      basis: { type: 'string', minLength: 1 },
      source_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  },
  invariants: [
    'split_status=resolved 时 country_code 非空。',
    'split_status=resolved 且 region_code=null 时 region_presence 必须为 absent。',
    'split_status=needs_review 时 region_presence 必须为 unknown，且 reason_code 非空。',
    '任何 null 都不得表示 "转换失败"；失败必须显式出现在 split_status 与 reason_code。',
    '每条记录携带 source_hash，消费者可核对它对应的 v1 原值，但不能回写 v1。',
  ],
  compatibility: {
    requires_explicit_switch: true,
    requires_sha_ack: true,
    unknown_policy: 'quarantine-and-report',
    consumers: ['geo-router', 'risk-scoring', 'intake-adapter'],
  },
};

export const CONTRACTS = { 1: CONTRACT_V1, 2: CONTRACT_V2 };

export function contractHash(contract) {
  return sha256(canonicalJson(contract));
}

export function contractDigest(version) {
  const contract = CONTRACTS[version];
  if (!contract) throw new Error(`unknown contract version ${version}`);
  return { contract, payload: canonicalJson(contract), sha256: contractHash(contract) };
}

// Returns a list of human-readable violations. Empty list = valid bundle.
export function validateV2Bundle(bundle, { expectedSha } = {}) {
  const errors = [];
  if (bundle.contract_version !== 2) errors.push('contract_version 必须为 2');
  if (expectedSha && bundle.contract_sha !== expectedSha) {
    errors.push(`contract_sha 不匹配：收到 ${String(bundle.contract_sha).slice(0, 12)}，期望 ${expectedSha.slice(0, 12)}`);
  }
  if (!Array.isArray(bundle.items)) {
    errors.push('items 必须是数组');
    return errors;
  }
  for (const item of bundle.items) {
    const id = item?.record_id ?? '(no id)';
    if (item?.split_status !== 'resolved' && item?.split_status !== 'needs_review') {
      errors.push(`${id}: split_status 非法`);
      continue;
    }
    if (item.split_status === 'resolved') {
      if (!/^[A-Z]{2}$/.test(item.country_code ?? '')) errors.push(`${id}: resolved 记录 country_code 非法`);
      if (item.region_code == null && item.region_presence !== 'absent') {
        errors.push(`${id}: region_code=null 但 presence 不是 absent`);
      }
      if (item.region_code != null && item.region_presence !== 'present') {
        errors.push(`${id}: region_code 非空但 presence 不是 present`);
      }
      if (item.region_code != null && !/^[A-Z0-9]{1,3}$/.test(item.region_code)) {
        errors.push(`${id}: region_code 不符合 ^[A-Z0-9]{1,3}$`);
      }
    } else {
      if (item.region_presence !== 'unknown') errors.push(`${id}: needs_review 的 presence 必须是 unknown`);
      if (!item.reason_code) errors.push(`${id}: needs_review 缺少 reason_code`);
      if (!item.basis) errors.push(`${id}: needs_review 缺少 basis`);
      // A needs_review row must not smuggle a half-guess out alongside the
      // reason: either field being set would let a consumer use it as a value.
      if (item.country_code != null || item.region_code != null) {
        errors.push(`${id}: needs_review 记录不得携带 country_code / region_code`);
      }
    }
    if (!item.basis) errors.push(`${id}: 缺少 basis`);
    if (!['derived', 'operator'].includes(item.provenance)) {
      errors.push(`${id}: provenance 必须是 derived 或 operator（legacy 表示未投影，不能进入 v2）`);
    }
    if (!/^[a-f0-9]{64}$/.test(item.source_hash ?? '')) {
      errors.push(`${id}: source_hash 必须是 64 位小写十六进制`);
    }
  }
  return errors;
}

export const CONTRACT_DIFF = [
  {
    aspect: '位置信息',
    v1: 'legacy_segment 一个字符串，解释权在消费端',
    v2: 'country_code + region_code 两个字段，来源可核对',
  },
  {
    aspect: '地区缺失',
    v1: '无法区分 "本来没有" 和 "解析失败"',
    v2: 'region_presence=absent 与 unknown 明确分开',
  },
  {
    aspect: '歧义值',
    v1: '照原样传下去，各消费端可能各自猜',
    v2: '不进入正常结果；needs_review + reason_code + basis',
  },
  {
    aspect: '切换方式',
    v1: '已在用，冻结',
    v2: '必须先声明版本并回传 contract_sha 才视为切换完成',
  },
  {
    aspect: '拒绝',
    v1: '无明确拒绝语义',
    v2: 'schema、哈希、批次策略任一不通过即拒收，并记录原因',
  },
];
