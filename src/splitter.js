import {
  BARE_COLLISIONS,
  COUNTRY_ALIASES,
  ISO3,
  ISO_COUNTRIES,
  PLACEHOLDERS,
  RESERVED_CODES,
  SUBDIVISIONS,
  reasonLabel,
} from './catalog.js';

// The splitter is deliberately conservative: it resolves only what the value
// itself proves. Everything else is handed to a human as `needs_review`, and
// unparseable input is `blocked`. It never invents a country or a region.

const SEPARATORS = /[;,|]/;
const ANNOTATION = /[()[\]{}*#]/;

function ownersOfSubdivision(code) {
  const owners = [];
  for (const [country, regions] of Object.entries(SUBDIVISIONS)) {
    if (regions.has(code)) owners.push(country);
  }
  return owners;
}

function normalizeNotes(raw) {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  const notes = [];
  if (trimmed !== raw) notes.push('TRIM');
  if (trimmed !== trimmed.toUpperCase() && upper !== trimmed) notes.push('CASE');
  return { trimmed, upper, notes };
}

function countryToken(token) {
  if (!token) return { kind: 'empty' };
  if (ISO_COUNTRIES.has(token)) return { kind: 'iso2', code: token };
  if (ISO3[token]) return { kind: 'iso3', code: ISO3[token], from: token };
  if (COUNTRY_ALIASES[token]) return { kind: 'alias', code: COUNTRY_ALIASES[token], from: token };
  if (RESERVED_CODES.has(token)) return { kind: 'reserved', code: token };
  return { kind: 'unknown', code: token };
}

function resolvedReason(base, country, notes) {
  if (country.kind === 'iso3') return 'ISO3_NORMALIZED';
  if (notes.includes('CASE')) return 'CASE_NORMALIZED';
  if (notes.includes('TRIM')) return 'WHITESPACE_TRIMMED';
  return base;
}

function noteText(notes) {
  const parts = [];
  if (notes.includes('TRIM')) parts.push('去除了首尾空白');
  if (notes.includes('CASE')) parts.push('统一为大写');
  return parts.length ? `（同时${parts.join('、')}）` : '';
}

function result(fields) {
  return {
    status: 'blocked',
    countryCode: null,
    regionCode: null,
    regionPresence: 'unknown',
    regionVerified: 0,
    reasonCode: 'NO_VALUE',
    ruleId: 'none',
    basis: '',
    // Every value that passes through the splitter was derived by a rule,
    // including `needs_review` (the rule derived "there is no single answer").
    // `legacy` is reserved for rows that have not been projected at all and
    // therefore never reach this function.
    provenance: 'derived',
    candidates: [],
    ...fields,
  };
}

function stripAnnotation(text) {
  return text
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[*#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitLegacySegment(raw) {
  if (raw == null || String(raw).trim() === '') {
    return result({
      reasonCode: 'NO_VALUE',
      basis: '源值为空或只有空白，没有可供拆分的内容；v2 不会生成任何国家或地区值。',
    });
  }

  const text = String(raw);
  const { trimmed, upper, notes } = normalizeNotes(text);

  if (PLACEHOLDERS.has(upper) || PLACEHOLDERS.has(trimmed)) {
    return result({
      reasonCode: 'PLACEHOLDER',
      basis: `源值 \`${text}\` 是占位符，不是国家或地区；按 v2 合同不能写成任何合法代码。`,
    });
  }

  if (SEPARATORS.test(trimmed)) {
    return result({
      reasonCode: 'MULTI_VALUED',
      basis: `源值 \`${text}\` 含多个以分隔符隔开的值。v2 的 country_code / region_code 是单值字段，拆开会丢失其余值，因此整条阻断。`,
    });
  }

  if (ANNOTATION.test(trimmed) || /\s{1,}/.test(trimmed) && !/-/.test(trimmed)) {
    const base = stripAnnotation(trimmed);
    const baseParse = base && base !== trimmed && !ANNOTATION.test(base) ? splitLegacySegment(base) : null;
    // Candidates are only useful when stripping the annotation leaves a value
    // the rules can actually parse; otherwise the human must type it.
    const candidates =
      baseParse && baseParse.status === 'resolved'
        ? [
            {
              label: baseParse.countryCode + (baseParse.regionCode ? `-${baseParse.regionCode}` : '（仅国家）'),
              countryCode: baseParse.countryCode,
              regionCode: baseParse.regionCode,
              regionPresence: baseParse.regionPresence,
              rationale: `去掉注释/自由文本后剩下 \`${base}\`，可被规则解析；但“注释里的内容是否应忽略”只有人知道。`,
            },
          ]
        : (baseParse?.candidates ?? []);
    return result({
      reasonCode: 'ANNOTATED',
      status: 'needs_review',
      basis: `源值 \`${text}\` 带注释或自由文本。注释不属于区划代码，标注意义只有人知道；${
        base && base !== trimmed ? `去掉注释后是 \`${base}\`，可作为候选，但未经确认不写入 v2。` : '无法安全剥离注释。'
      }`,
      candidates,
    });
  }

  const tokens = upper.split('-');
  const country = countryToken(tokens[0]);

  if (tokens.length > 2) {
    if (country.kind === 'reserved' || country.kind === 'unknown') {
      return result({
        status: 'blocked',
        reasonCode: country.kind === 'reserved' ? 'RESERVED_CODE' : 'NOT_A_COUNTRY',
        basis: `源值 \`${text}\` 的第一段 \`${tokens[0]}\` 不是可用的国家代码，整条无法映射到 v2。`,
      });
    }
    if (country.kind === 'alias') {
      return result({
        status: 'needs_review',
        reasonCode: 'COUNTRY_ALIAS',
        basis: `源值 \`${text}\` 含旧国家别名 \`${tokens[0]}\`（可能指 ${country.code}），且多于两段；别名与多余段都需要人工确认。`,
        candidates: [
          {
            label: `${country.code}（别名 ${country.from}）· 地区未定`,
            countryCode: country.code,
            regionCode: null,
            regionPresence: 'unknown',
            rationale: `别名 ${country.from} 映射为 ${country.code}，但第三段 \`${tokens.slice(2).join('-')}\` 无对应区划层级。`,
          },
        ],
      });
    }
    return result({
      status: 'needs_review',
      reasonCode: 'EXTRA_SEGMENT',
      basis: `源值 \`${text}\` 有 ${tokens.length} 段，v2 只容纳国家和一级区划两段。前两段可读作 ${country.code} / ${tokens[1]}，多出的 \`${tokens.slice(2).join('-')}\` 会丢失，需人工决定是否允许丢弃。`,
      candidates: [
        {
          label: `${country.code}-${tokens[1]}（丢弃第 3 段）`,
          countryCode: country.code,
          regionCode: tokens[1],
          regionPresence: 'present',
          rationale: `保留前两段；第三段 \`${tokens.slice(2).join('-')}\` 无 v2 字段承载。`,
        },
      ],
    });
  }

  if (tokens.length === 2) {
    const [, region] = tokens;
    if (country.kind === 'iso3') {
      return result({
        status: 'needs_review',
        reasonCode: 'EXTRA_SEGMENT',
        basis: `源值 \`${text}\` 的第一段 \`${tokens[0]}\` 是三字母国家码（${country.code}），第二段 \`${region}\` 又像区划码。旧合同从未规定三字母码后还能带地区，两种拆法（国家 ${country.code} + 丢弃地区，或把第二段当地区）都改变了原义，需人工确认。`,
        candidates: [
          {
            label: `${country.code}-${region}`,
            countryCode: country.code,
            regionCode: region,
            regionPresence: SUBDIVISIONS[country.code]?.has(region) ? 'present' : 'unknown',
            rationale: `国家段 ${tokens[0]} 按 alpha-3 转 ${country.code}；地区段 ${
              SUBDIVISIONS[country.code]?.has(region) ? '可在 ISO 3166-2 中查到' : '不在内置 ISO 3166-2 表中'
            }。`,
          },
          {
            label: `${country.code}（仅国家，忽略地区段）`,
            countryCode: country.code,
            regionCode: null,
            regionPresence: 'absent',
            rationale: `只采用三字母国家码，忽略 \`${region}\`。`,
          },
        ],
      });
    }
    if (!tokens[0] || !region) {
      return result({
        reasonCode: 'EMPTY_PART',
        basis: `源值 \`${text}\` 分隔符一侧为空，v2 无法得到完整的两段值。`,
      });
    }
    if (country.kind === 'reserved') {
      return result({
        reasonCode: 'RESERVED_CODE',
        basis: `源值 \`${text}\` 的国家段 \`${tokens[0]}\` 是 ISO 保留代码，不对应任何国家，不能写入 v2。`,
      });
    }
    if (country.kind === 'unknown') {
      return result({
        reasonCode: 'NOT_A_COUNTRY',
        basis: `源值 \`${text}\` 的国家段 \`${tokens[0]}\` 不在 ISO 3166-1 列表中；即使地区段看起来合法，国家也无法确认。`,
      });
    }

    const table = SUBDIVISIONS[country.code];
    if (country.kind === 'alias') {
      return result({
        status: 'needs_review',
        reasonCode: 'COUNTRY_ALIAS',
        basis: `源值 \`${text}\` 使用旧国家别名 \`${country.from}\`（映射为 ${country.code}）。别名映射属于合同策略决策，需人工签认后写入 v2。`,
        candidates: [
          {
            label: `${country.code}-${region}`,
            countryCode: country.code,
            regionCode: table?.has(region) ? region : null,
            regionPresence: table?.has(region) ? 'present' : 'unknown',
            rationale: `别名 ${country.from} 映射为 ${country.code}；${table?.has(region) ? `区划 ${region} 可在 ISO 3166-2:${country.code} 中查到。` : `区划 ${region} 未在内置 ISO 3166-2:${country.code} 表中查到。`}`,
          },
        ],
      });
    }
    if (table?.has(region)) {
      return result({
        status: 'resolved',
        reasonCode: resolvedReason('DIRECT_PAIR', country, notes),
        ruleId: country.kind === 'iso3' ? 'iso3166-1.alpha3->alpha2' : 'iso3166-2.direct',
        countryCode: country.code,
        regionCode: region,
        regionPresence: 'present',
        regionVerified: 1,
        provenance: 'derived',
        basis: `旧值 \`${text}\` 可无损拆为 country_code=${country.code}、region_code=${region}${noteText(notes)}。两段均在 ISO 3166 表中查得（来源：内置 ISO 3166-1 / ISO 3166-2 表），v2 值来自转换而非猜测。`,
        candidates: [
          {
            label: `${country.code}-${region}`,
            countryCode: country.code,
            regionCode: region,
            regionPresence: 'present',
            rationale: '两段均直接命中 ISO 表。',
          },
        ],
      });
    }
    if (/^\d+$/.test(region)) {
      return result({
        status: 'needs_review',
        reasonCode: 'NUMERIC_SUBDIVISION',
        basis: `国家 ${country.code} 可确认，但地区段 \`${region}\` 是数字码，不是 ISO 3166-2 的字母写法，内置表无法证明它对应哪个一级区划。v2 不能把原始数字直接填入 region_code。`,
        candidates: [
          {
            label: `${country.code} · 地区未定`,
            countryCode: country.code,
            regionCode: null,
            regionPresence: 'unknown',
            rationale: `数字码 ${region} 需要对照该国标准或源系统字典，当前无依据。`,
          },
        ],
      });
    }
    return result({
      status: 'needs_review',
      reasonCode: 'UNKNOWN_SUBDIVISION',
      basis: `国家 ${country.code} 可确认，但地区段 \`${region}\` 不在内置 ISO 3166-2:${country.code} 表中。可能是拼写错误、非 ISO 区划或内置表未收录；不能直接当作 v2 值。`,
      candidates: [
        {
          label: `${country.code} · 地区未定`,
          countryCode: country.code,
          regionCode: null,
          regionPresence: 'unknown',
          rationale: `region_code=${region} 未通过 ISO 表校验；若保留需人工签认 ${country.code}-${region}。`,
        },
      ],
    });
  }

  // One token.
  if (country.kind === 'reserved') {
    return result({
      reasonCode: 'RESERVED_CODE',
      basis: `源值 \`${text}\` 是 ISO 保留代码（如 ZZ / XX），不对应真实国家，v2 不能使用。`,
    });
  }
  if (country.kind === 'alias') {
    return result({
      status: 'needs_review',
      reasonCode: 'COUNTRY_ALIAS',
      basis: `源值 \`${text}\` 是旧国家别名，可能指 ${country.code}。别名不在 ISO 3166-1 的现行代码集中，映射需要人工签认。`,
      candidates: [
        {
          label: `${country.code}（仅国家）`,
          countryCode: country.code,
          regionCode: null,
          regionPresence: 'absent',
          rationale: `旧别名 ${country.from} 对应 ISO ${country.code}；原值不含地区。`,
        },
      ],
    });
  }
  if (country.kind === 'iso2') {
    if (BARE_COLLISIONS.has(upper)) {
      return result({
        status: 'needs_review',
        reasonCode: 'BARE_CODE_COLLISION',
        basis: `源值 \`${text}\` 是裸代码，同时是 ISO 3166-1 国家码（${upper}）和 US 州码。旧合同只有一段，没有国家上下文，两种解释都成立；v2 不允许用其中之一冒充原值。`,
        candidates: [
          {
            label: `${upper}（国家）`,
            countryCode: upper,
            regionCode: null,
            regionPresence: 'absent',
            rationale: `按 ISO 3166-1，${upper} 是一个国家；原值没有下级地区。`,
          },
          {
            label: `US-${upper}（美国州）`,
            countryCode: 'US',
            regionCode: upper,
            regionPresence: 'present',
            rationale: `按 ISO 3166-2:US，${upper} 是美国的一级区划。`,
          },
        ],
      });
    }
    return result({
      status: 'resolved',
      reasonCode: resolvedReason('COUNTRY_ONLY', country, notes),
      ruleId: 'iso3166-1.country-only',
      countryCode: upper,
      regionCode: null,
      regionPresence: 'absent',
      regionVerified: 0,
      provenance: 'derived',
      basis: `旧值 \`${text}\` 是国家码，不含下级区划${noteText(notes)}。v2 将 country_code=${upper}、region_code=null、region_presence=absent：地区从未存在，不是转换失败。`,
      candidates: [
        {
          label: `${upper}（仅国家）`,
          countryCode: upper,
          regionCode: null,
          regionPresence: 'absent',
          rationale: 'ISO 3166-1 国家码，原值没有地区段。',
        },
      ],
    });
  }
  if (country.kind === 'iso3') {
    return result({
      status: 'resolved',
      reasonCode: 'ISO3_NORMALIZED',
      ruleId: 'iso3166-1.alpha3->alpha2',
      countryCode: country.code,
      regionCode: null,
      regionPresence: 'absent',
      regionVerified: 0,
      provenance: 'derived',
      basis: `旧值 \`${text}\` 是 ISO 3166-1 三字母码 ${country.from}，可无损规范化成两字母 ${country.code}；原值不含地区，v2 的 region_code=null 且 region_presence=absent。`,
      candidates: [
        {
          label: `${country.code}（仅国家，来自 ${country.from}）`,
          countryCode: country.code,
          regionCode: null,
          regionPresence: 'absent',
          rationale: 'ISO 3166-1 alpha-3 转 alpha-2。',
        },
      ],
    });
  }

  const owners = ownersOfSubdivision(upper);
  if (owners.length > 0) {
    return result({
      status: 'needs_review',
      reasonCode: /^\d+$/.test(upper) ? 'NUMERIC_SUBDIVISION' : 'BARE_SUBDIVISION',
      basis: `源值 \`${text}\` 是裸区划代码，只在 ISO 3166-2 表${owners.map((o) => `:${o}`).join('、')}中命中；旧合同没有国家段，把它补成国家属于推断，v2 不自动填。`,
      candidates: owners.map((owner) => ({
        label: `${owner}-${upper}`,
        countryCode: owner,
        regionCode: upper,
        regionPresence: 'present',
        rationale: `仅在 ISO 3166-2:${owner} 中命中该区划码。`,
      })),
    });
  }

  return result({
    status: 'blocked',
    reasonCode: 'UNKNOWN_COUNTRY',
    basis: `源值 \`${text}\` 既不是 ISO 3166-1 国家码，也不在任何内置 ISO 3166-2 区划表中；无法得到任何可信的 v2 值。`,
  });
}

export function summarizeSplit(split) {
  return {
    status: split.status,
    reason: split.reasonCode,
    label: reasonLabel(split.reasonCode),
  };
}

export function candidateProjection(candidate) {
  return {
    country_code: candidate.countryCode,
    region_code: candidate.regionCode,
    region_presence: candidate.regionPresence,
  };
}
