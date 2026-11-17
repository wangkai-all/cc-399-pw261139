import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLegacySegment } from '../src/splitter.js';

const cases = [
  // value, status, reason
  ['US-CA', 'resolved', 'DIRECT_PAIR'],
  ['us-ca', 'resolved', 'CASE_NORMALIZED'],
  [' US-CA ', 'resolved', 'WHITESPACE_TRIMMED'],
  ['GB-ENG', 'resolved', 'DIRECT_PAIR'],
  ['JP-13', 'resolved', 'DIRECT_PAIR'],
  ['US', 'resolved', 'COUNTRY_ONLY'],
  ['FR', 'resolved', 'COUNTRY_ONLY'],
  ['USA', 'resolved', 'ISO3_NORMALIZED'],
  ['deu', 'resolved', 'ISO3_NORMALIZED'],
  ['CA', 'needs_review', 'BARE_CODE_COLLISION'],
  ['DE', 'needs_review', 'BARE_CODE_COLLISION'],
  ['TX', 'needs_review', 'BARE_SUBDIVISION'],
  ['ON', 'needs_review', 'BARE_SUBDIVISION'],
  ['UK', 'needs_review', 'COUNTRY_ALIAS'],
  ['EL', 'needs_review', 'COUNTRY_ALIAS'],
  ['US-XX', 'needs_review', 'UNKNOWN_SUBDIVISION'],
  ['PT-11', 'needs_review', 'NUMERIC_SUBDIVISION'],
  ['US-CA-9', 'needs_review', 'EXTRA_SEGMENT'],
  ['USA-TX', 'needs_review', 'EXTRA_SEGMENT'],
  ['US-CA (HQ)', 'needs_review', 'ANNOTATED'],
  ['N/A', 'blocked', 'PLACEHOLDER'],
  ['-', 'blocked', 'PLACEHOLDER'],
  ['', 'blocked', 'NO_VALUE'],
  ['   ', 'blocked', 'NO_VALUE'],
  ['US-CA;US-NV', 'blocked', 'MULTI_VALUED'],
  ['US-CA,NV', 'blocked', 'MULTI_VALUED'],
  ['US-', 'blocked', 'EMPTY_PART'],
  ['-CA', 'blocked', 'EMPTY_PART'],
  ['ZZ', 'blocked', 'RESERVED_CODE'],
  ['ZZ-QQ', 'blocked', 'RESERVED_CODE'],
  ['XX-QQ', 'blocked', 'RESERVED_CODE'],
];

for (const [value, status, reason] of cases) {
  test(`split ${JSON.stringify(value)} → ${status}/${reason}`, () => {
    const result = splitLegacySegment(value);
    assert.equal(result.status, status);
    assert.equal(result.reasonCode, reason);
    assert.ok(result.basis.length > 0, 'every result must carry a basis');
  });
}

test('resolved two-part values are verified and marked present', () => {
  const r = splitLegacySegment('US-CA');
  assert.equal(r.countryCode, 'US');
  assert.equal(r.regionCode, 'CA');
  assert.equal(r.regionPresence, 'present');
  assert.equal(r.regionVerified, 1);
  assert.equal(r.provenance, 'derived');
});

test('country-only values are absent, never "unknown"', () => {
  const r = splitLegacySegment('US');
  assert.equal(r.regionPresence, 'absent');
  assert.equal(r.regionCode, null);
});

test('ambiguous values carry candidate interpretations rather than a guess', () => {
  const r = splitLegacySegment('CA');
  const labels = r.candidates.map((c) => c.label);
  assert.ok(labels.some((l) => l.includes('国家')));
  assert.ok(labels.some((l) => l.includes('US-CA')));
  assert.equal(r.countryCode, null);
  assert.equal(r.regionCode, null);
});

test('the splitter never returns a country for an ambiguous bare code', () => {
  const allBare = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => splitLegacySegment(c));
  for (const r of allBare) {
    assert.ok(['resolved', 'needs_review', 'blocked'].includes(r.status));
    if (r.status === 'needs_review') {
      assert.equal(r.countryCode, null, `ambiguous ${r.reasonCode} must not claim a country`);
    }
  }
});

test('placeholder-ish values are blocked rather than mapped', () => {
  for (const v of ['N/A', 'NA', 'unknown', '?', 'null', 'TBD', '无']) {
    const r = splitLegacySegment(v);
    assert.equal(r.status, 'blocked', `${v} should be blocked`);
  }
});
