// Catalogs that both the server and the browser use. Everything user-facing is
// Chinese; identifiers stay English so the API and tests stay readable.
import { canonicalJson, sha256 } from './db.js';

export const MIGRATION_ID = 'pointwise.segment';

export const RECORD_STATUS = Object.freeze({
  RESOLVED: 'resolved',
  NEEDS_REVIEW: 'needs_review',
  BLOCKED: 'blocked',
});

export const REGION_PRESENCE = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
});

export const REASONS = Object.freeze({
  // resolved
  DIRECT_PAIR: { zh: '直接拆分', severity: 'ok' },
  COUNTRY_ONLY: { zh: '仅国家，地区缺失', severity: 'ok' },
  ISO3_NORMALIZED: { zh: 'ISO 三字码规范化', severity: 'ok' },
  CASE_NORMALIZED: { zh: '大小写规范化', severity: 'ok' },
  WHITESPACE_TRIMMED: { zh: '首尾空白规范化', severity: 'ok' },
  OPERATOR_MAPPED: { zh: '人工判定映射', severity: 'ok' },
  OPERATOR_COUNTRY_ONLY: { zh: '人工判定为仅国家', severity: 'ok' },
  // needs_review
  BARE_CODE_COLLISION: { zh: '裸代码歧义（国家码与州码重合）', severity: 'warn' },
  BARE_SUBDIVISION: { zh: '裸州/省码，缺国家', severity: 'warn' },
  COUNTRY_ALIAS: { zh: '旧国家别名', severity: 'warn' },
  UNKNOWN_SUBDIVISION: { zh: '未知的下级区划码', severity: 'warn' },
  NUMERIC_SUBDIVISION: { zh: '数字区划码，非 ISO 写法', severity: 'warn' },
  EXTRA_SEGMENT: { zh: '多于两段，拆分有损', severity: 'warn' },
  ANNOTATED: { zh: '旧值带注释', severity: 'warn' },
  // unresolvable
  PLACEHOLDER: { zh: '占位符而非值', severity: 'error' },
  NO_VALUE: { zh: '空值', severity: 'error' },
  MULTI_VALUED: { zh: '多值混装，无法拆成单值', severity: 'error' },
  EMPTY_PART: { zh: '分隔符一侧为空', severity: 'error' },
  UNKNOWN_COUNTRY: { zh: '未知国家代码', severity: 'error' },
  NOT_A_COUNTRY: { zh: '不是国家代码', severity: 'error' },
  RESERVED_CODE: { zh: '保留代码', severity: 'error' },
  // operator / batch
  OPERATOR_BLOCKED: { zh: '人工阻断', severity: 'error' },
  BATCH_BLOCKED: { zh: '整批阻断', severity: 'error' },
  BACKFILL_INCOMPLETE: { zh: '回填未完成', severity: 'error' },
});

export const RULES = Object.freeze({
  DIRECT_PAIR: 'iso3166-2.direct',
  COUNTRY_ONLY: 'iso3166-1.country-only',
  ISO3_TO_ISO2: 'iso3166-1.alpha3->alpha2',
  CASE_NORMALIZED: 'normalize.ascii-case',
  WHITESPACE_TRIMMED: 'normalize.whitespace',
  OPERATOR: 'operator.decision',
  NONE: 'none',
});

// Small but real ISO 3166-2 tables. A value only counts as verified when both
// halves are found here; anything else is handed to a human, never guessed.
export const SUBDIVISIONS = {
  US: new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')),
  CA: new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' ')),
  DE: new Set('BB BE BW BY HB HE HH MV NI NW RP SH SL SN ST TH'.split(' ')),
  GB: new Set('ENG SCT WLS NIR'.split(' ')),
  FR: new Set('IDF OCC NOR ARA BRE BFC CVL COR GES HDF ISL NAQ PDL PAC'.split(' ')),
  CN: new Set('BJ TJ HE SX NM LN JL HL SH JS ZJ AH FJ JX SD HA HB HN GD GX HI CQ SC GZ YN XZ SN GS QH NX XJ TW HK MO'.split(' ')),
  JP: new Set('13 14 27 40 01 23 34 47'.split(' ')),
  NL: new Set('NH ZH UT GE FR DR OV GR LI NB ZE FL'.split(' ')),
  ES: new Set('MD CT AN PV NC IB'.split(' ')),
};

export const ISO_COUNTRIES = new Set([
  'US', 'CA', 'DE', 'GB', 'FR', 'CN', 'JP', 'NL', 'ES', 'IT', 'AU', 'BR', 'IN',
  'ID', 'IL', 'IE', 'MX', 'NZ', 'SE', 'NO', 'DK', 'FI', 'PL', 'PT', 'CH', 'AT',
  'BE', 'SG', 'KR', 'ZA', 'AR', 'CO', 'AL', 'MT', 'MA', 'TN', 'SD', 'VA', 'MD',
  'MO', 'PA', 'SC', 'NE', 'LA', 'GA', 'KY', 'MS', 'CY', 'LU', 'EE', 'LV', 'LT',
  'SI', 'SK', 'CZ', 'HU', 'RO', 'BG', 'HR', 'RS', 'UA', 'TR', 'AE', 'SA', 'EG',
]);

// Codes ISO calls "user-assigned" / reserved: syntactically plausible, never a
// real country. They must not silently become a v2 country value.
export const RESERVED_CODES = new Set(['ZZ', 'XX', 'XA', 'XB', 'XK', 'EU', 'UN', 'AA', 'QM', 'QN', 'QO', 'QP']);

// Legacy spellings that the old consumer may emit. Mapping them is a policy
// decision (a human signs off), not a conversion the splitter may invent.
export const COUNTRY_ALIASES = {
  UK: 'GB',
  EL: 'GR',
  'U.K.': 'GB',
};

export const ISO3 = {
  USA: 'US', GBR: 'GB', DEU: 'DE', FRA: 'FR', CAN: 'CA', CHN: 'CN', JPN: 'JP',
  NLD: 'NL', ESP: 'ES', AUS: 'AU', ITA: 'IT', BRA: 'BR', IND: 'IN', CHE: 'CH',
  SWE: 'SE', NOR: 'NO', DNK: 'DK', POL: 'PL', PRT: 'PT', MEX: 'MX', KOR: 'KR',
  SGP: 'SG', ZAF: 'ZA', ARG: 'AR', AUT: 'AT', BEL: 'BE', IRL: 'IE', NZL: 'NZ',
};

export const PLACEHOLDERS = new Set([
  'N/A', 'NA', 'N.A.', 'UNKNOWN', 'UNK', '?', '??', '-', '--', 'NONE', 'NULL',
  'TBD', 'EMPTY', '无', '未知', '/', '.',
]);

// Batch policy used by preflight and by the v2 delivery gate.
export const POLICY = Object.freeze({
  // Above this share of needs_review records the batch is withheld from v2.
  reviewShareLimit: 0.05,
  // Any of these makes the batch unshippable on v2 without an operator override.
  hardReasons: ['MULTI_VALUED', 'EMPTY_PART'],
  // Acknowledging more than this many minutes after delivery is a "late ack".
  lateAckMinutes: 60,
});

// Intersection of ISO countries and US state postal codes: the exact class of
// legacy value that cannot be split without a human decision.
export const BARE_COLLISIONS = new Set(
  [...ISO_COUNTRIES].filter((code) => SUBDIVISIONS.US.has(code)),
);

export function reasonLabel(code) {
  return REASONS[code]?.zh ?? code;
}

export function severityOf(code) {
  return REASONS[code]?.severity ?? 'warn';
}

// A fingerprint of the rule tables the splitter consults. Preflight reports are
// persisted snapshots; if the rule set changes, an old report can disagree with
// what the projection would produce today. Storing this with each report makes
// that a visible, auditable fact instead of a silent contradiction.
export function ruleSetFingerprint() {
  const stable = {
    subdivisions: Object.fromEntries(
      Object.entries(SUBDIVISIONS).map(([country, set]) => [country, [...set].sort()]),
    ),
    countries: [...ISO_COUNTRIES].sort(),
    reserved: [...RESERVED_CODES].sort(),
    aliases: COUNTRY_ALIASES,
    iso3: ISO3,
    placeholders: [...PLACEHOLDERS].sort(),
    collisions: [...BARE_COLLISIONS].sort(),
    policy: POLICY,
  };
  return sha256(canonicalJson(stable)).slice(0, 16);
}
