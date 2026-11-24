import test from 'node:test';
import assert from 'node:assert/strict';
import { valhallaUrl, readPhoton } from '../public/js/api.js';
import { buildRouteRequest } from '../public/js/core/valhalla.js';
import { DEFAULT_PROFILE } from '../public/js/core/options.js';

test('direct mode sends a normal truck route as a GET ?json= request', () => {
  const body = buildRouteRequest({ locations: [{ lat: 28.5384, lon: -81.3789 }, { lat: 30.3322, lon: -81.6557 }], profile: DEFAULT_PROFILE, options: { avoidTolls: true } });
  const u = valhallaUrl('https://valhalla1.openstreetmap.de', 'route', body);
  assert.ok(u && u.startsWith('https://valhalla1.openstreetmap.de/route?json='));
  const back = JSON.parse(decodeURIComponent(u.split('?json=')[1]));
  assert.equal(back.costing, 'truck');
  assert.ok(Math.abs(back.costing_options.truck.height - 4.19) < 0.02, "13'6\" plus the 3\" buffer, in meters");
  assert.ok(back.costing_options.truck.weight > 36 && back.costing_options.truck.weight < 37, 'weight in tonnes');
});

test('very long bodies fall back to POST', () => {
  const big = { shape: 'x'.repeat(7000) };
  assert.equal(valhallaUrl('https://v', 'height', big), null);
});

test('readPhoton labels places and drops junk and out-of-area results', () => {
  const raw = { features: [
    { geometry: { coordinates: [-81.6557, 30.3322] }, properties: { name: 'Jacksonville', state: 'Florida', countrycode: 'US', extent: [-82.05, 30.59, -81.39, 30.1] } },
    { geometry: { coordinates: [2.35, 48.85] }, properties: { name: 'Paris', countrycode: 'FR' } },
    { geometry: { coordinates: ['x', 1] }, properties: { name: 'Bad', countrycode: 'US' } },
    { geometry: { coordinates: [-84.4, 33.7] }, properties: { name: "Love's Travel Stop", street: 'Main St', housenumber: '12', city: 'Atlanta', state: 'Georgia', countrycode: 'us' } },
  ] };
  const r = readPhoton(raw);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Jacksonville');
  assert.equal(r[0].label, 'Jacksonville, FL');
  assert.deepEqual([r[0].lat, r[0].lon, r[0].bbox], [30.3322, -81.6557, [30.1, -82.05, 30.59, -81.39]]);
  assert.equal(r[1].title, "Love's Travel Stop");
  assert.equal(r[1].sub, '12 Main St, Atlanta, GA');
  assert.equal(r[1].label, "Love's Travel Stop, Atlanta, GA");
  assert.deepEqual(readPhoton(null), []);
});
