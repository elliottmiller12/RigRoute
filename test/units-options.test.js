import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeightToInches, parseWeightToLbs, fmtFeetIn, fmtLbs } from '../public/js/core/units.js';
import { sanitizeOptions, sanitizeProfile, DEFAULT_PROFILE, describeOptions, removeChip, effectiveProfile } from '../public/js/core/options.js';

test('height strings from OSM and drivers', () => {
  assert.equal(parseHeightToInches(`13'6"`), 162);
  assert.equal(parseHeightToInches('13 ft 6 in'), 162);
  assert.equal(Math.round(parseHeightToInches('4.1')), 161); // bare = metres
  assert.equal(Math.round(parseHeightToInches('410 cm')), 161);
  assert.equal(parseHeightToInches('default'), null);
  assert.equal(parseHeightToInches('none'), null);
  assert.equal(fmtFeetIn(162), `13'6"`);
});

test('weight strings', () => {
  assert.equal(Math.round(parseWeightToLbs('20')), 44092); // bare = metric tonnes
  assert.equal(parseWeightToLbs('10 st'), 20000);
  assert.equal(parseWeightToLbs('40000 lbs'), 40000);
  assert.match(fmtLbs(80000), /80,000/);
});

test('sanitizeOptions drops unknown keys, bad types and junk names', () => {
  const o = sanitizeOptions({
    avoidTolls: true, avoidHighways: 'yes', evil: 1, heightIn: 9999, weightLbs: 78000,
    avoidRoads: ['I-95', '<script>', 'I-95', 'x'.repeat(60), 'Storrow Drive'],
    avoidPlaces: ['Downtown Atlanta', 'javascript:alert(1)'],
    __proto__: { polluted: true },
  });
  assert.deepEqual(o, { avoidTolls: true, weightLbs: 78000, avoidRoads: ['I-95', 'Storrow Drive'], avoidPlaces: ['Downtown Atlanta'] });
  assert.equal({}.polluted, undefined);
});

test('sanitizeProfile rejects out-of-range values instead of clamping', () => {
  const p = sanitizeProfile({ heightIn: 30, weightLbs: '80000', axles: 5.4, hazmat: 'true' });
  assert.equal(p.heightIn, DEFAULT_PROFILE.heightIn);
  assert.equal(p.weightLbs, 80000);
  assert.equal(p.axles, 5);
  assert.equal(p.hazmat, false);
});

test('prompt options override the saved profile for one trip', () => {
  const p = effectiveProfile({ heightIn: 150 }, { heightIn: 162, hazmat: true });
  assert.equal(p.heightIn, 162);
  assert.equal(p.hazmat, true);
});

test('chips describe and remove cleanly', () => {
  const o = { avoidTolls: true, avoidRoads: ['I-95', 'I-81'] };
  const chips = describeOptions(o);
  assert.deepEqual(chips.map((c) => c.label), ['No tolls', 'Avoid I-95', 'Avoid I-81']);
  assert.deepEqual(removeChip(o, chips[1]), { avoidTolls: true, avoidRoads: ['I-81'] });
  assert.deepEqual(removeChip({ avoidRoads: ['I-95'] }, { key: 'avoidRoads', value: 'I-95' }), {});
});
