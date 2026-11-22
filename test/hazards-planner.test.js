import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRestrictions, readPois, buildRestrictionQuery, buildPoiQuery, restrictionChunks } from '../public/js/core/overpass.js';
import { evaluate, MAX_EXCLUDE_PERIMETER_M } from '../public/js/core/hazards.js';
import { readTrip } from '../public/js/core/valhalla.js';
import { makeLineIndex, haversine } from '../public/js/core/geo.js';
import { planRoute, isNoPath } from '../public/js/core/planner.js';
import { sanitizeProfile } from '../public/js/core/options.js';
import { line, valhallaResponse, fakeApi, noPath } from './helpers.js';

const SEEDS = JSON.parse(readFileSync(new URL('../public/data/hazards.json', import.meta.url))).hazards;
const TIPS = JSON.parse(readFileSync(new URL('../public/data/tips.json', import.meta.url))).tips;
const geom = (pts) => pts.map(([lat, lon]) => ({ lat, lon }));

// Route straight north through the Concord Covered Bridge (7'0") seed in Smyrna, GA.
const ROUTE_A = line([33.80, -84.558], [33.90, -84.558], 120);
const ROUTE_B = line([33.80, -84.530], [33.90, -84.530], 120);

test('seed data: every entry has a source URL and sane fields', () => {
  assert.ok(SEEDS.length >= 40);
  for (const h of SEEDS) {
    assert.ok(h.id && h.type && h.advice, h.id);
    assert.ok(h.sources && h.sources.length && h.sources.every((s) => /^https:\/\//.test(s.url)), `${h.id} needs https sources`);
    if (h.type !== 'no_trucks_named') { assert.ok(Math.abs(h.lat) <= 90 && Math.abs(h.lon) <= 180, h.id); }
    if (h.type === 'low_clearance') assert.ok(h.clearanceIn > 60 && h.clearanceIn < 200, h.id);
  }
  assert.equal(new Set(SEEDS.map((h) => h.id)).size, SEEDS.length, 'ids unique');
  for (const t of TIPS) assert.ok(t.sources.every((s) => /^https:\/\//.test(s.url)));
});

test('overpass queries are built only from validated coordinates', () => {
  const q = buildRestrictionQuery(ROUTE_A.slice(0, 10));
  assert.match(q, /maxheight/);
  assert.match(q, /around:30/);
  assert.match(buildPoiQuery(ROUTE_A.slice(0, 10)), /hgv/);
  assert.throws(() => buildRestrictionQuery('[out:json];node(1);out;'));
  assert.throws(() => buildRestrictionQuery([[91, 0], [0, 0]]));
  assert.throws(() => buildRestrictionQuery(Array(500).fill([1, 1])));
  const long = line([30, -90], [40, -90], 2000); // ~1100 km
  const chunks = restrictionChunks(long);
  assert.ok(chunks.length >= 15 && chunks.every((c) => c.length <= 220));
});

test('low clearance on the route is flagged, a road we cross over is not', () => {
  const trip = readTrip(valhallaResponse(ROUTE_A));
  const idx = makeLineIndex(trip.line, trip.cum);
  const json = { elements: [
    { type: 'way', id: 1, tags: { highway: 'primary', maxheight: `12'6"`, name: 'Atlanta Road' }, geometry: geom(line([33.860, -84.558], [33.862, -84.558], 4)) },
    // perpendicular road passing UNDER our route with a 3.0 m limit: not ours
    { type: 'way', id: 2, tags: { highway: 'residential', maxheight: '3.0' }, geometry: geom(line([33.870, -84.562], [33.870, -84.554], 6)) },
    // weight limit way drawn in the opposite direction
    { type: 'way', id: 3, tags: { highway: 'secondary', maxweight: '10' }, geometry: geom(line([33.882, -84.558], [33.880, -84.558], 4)) },
  ] };
  const osm = readRestrictions(json, idx);
  assert.deepEqual(osm.map((f) => f.id).sort(), ['osm:way/1', 'osm:way/3']);
  const ev = evaluate({ trip, idx, profile: sanitizeProfile({}), seeds: [], osm });
  const kinds = ev.alerts.filter((a) => a.severity === 'danger').map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['low_clearance', 'weight_limit']);
  assert.equal(ev.excludeRings.length, 2);
});

test('a truck that fits gets info, not danger; buffer counts', () => {
  const trip = readTrip(valhallaResponse(ROUTE_A));
  const idx = makeLineIndex(trip.line, trip.cum);
  const osm = readRestrictions({ elements: [{ type: 'way', id: 9, tags: { highway: 'primary', maxheight: `13'8"` }, geometry: geom(line([33.86, -84.558], [33.861, -84.558], 3)) }] }, idx);
  const fits = evaluate({ trip, idx, profile: sanitizeProfile({ heightIn: 150, clearanceMarginIn: 0 }), osm }).alerts;
  assert.ok(!fits.some((a) => a.severity === 'danger'));
  const tight = evaluate({ trip, idx, profile: sanitizeProfile({ heightIn: 162, clearanceMarginIn: 0 }), osm }).alerts;
  assert.equal(tight[0].severity, 'caution');
  const buffered = evaluate({ trip, idx, profile: sanitizeProfile({ heightIn: 162, clearanceMarginIn: 3 }), osm }).alerts;
  assert.equal(buffered[0].severity, 'danger');
});

test('hazmat-only restrictions apply only when hauling hazmat', () => {
  const pts = line([39.60, -105.93], [39.75, -105.91], 80);
  const trip = readTrip(valhallaResponse(pts));
  const idx = makeLineIndex(trip.line, trip.cum);
  const seed = SEEDS.filter((h) => h.id === 'eisenhower-hazmat');
  const hm = evaluate({ trip, idx, profile: sanitizeProfile({ hazmat: true }), seeds: seed }).alerts;
  assert.ok(hm.some((a) => a.kind === 'hazmat' || a.severity === 'danger'), JSON.stringify(hm));
  const dry = evaluate({ trip, idx, profile: sanitizeProfile({ hazmat: false }), seeds: seed }).alerts;
  assert.ok(!dry.some((a) => a.severity === 'danger'));
});

test('exclusion rings stay inside the routing engine perimeter budget', () => {
  const trip = readTrip(valhallaResponse(ROUTE_A));
  const idx = makeLineIndex(trip.line, trip.cum);
  const elements = [];
  for (let i = 0; i < 80; i++) { const la = 33.805 + i * 0.001; elements.push({ type: 'node', id: i, lat: la, lon: -84.558, tags: { maxheight: '3.0' } }); }
  const osm = readRestrictions({ elements }, idx);
  const ev = evaluate({ trip, idx, profile: sanitizeProfile({}), osm });
  assert.ok(ev.excludeRings.length * 240 <= MAX_EXCLUDE_PERIMETER_M);
});

test('POIs: parking and weigh stations near the route only', () => {
  const trip = readTrip(valhallaResponse(ROUTE_A));
  const idx = makeLineIndex(trip.line, trip.cum);
  const pois = readPois({ elements: [
    { type: 'node', id: 1, lat: 33.85, lon: -84.557, tags: { amenity: 'parking', hgv: 'designated', name: 'Lot' } },
    { type: 'node', id: 2, lat: 33.86, lon: -84.556, tags: { amenity: 'weighbridge' } },
    { type: 'way', id: 3, center: { lat: 33.85, lon: -84.40 }, tags: { amenity: 'parking', hgv: 'yes' } }, // 15 km away
  ] }, idx);
  assert.deepEqual(pois.map((p) => p.kind), ['parking', 'weigh']);
});

test('planner reroutes around a low bridge it knows about', async () => {
  const api = fakeApi({ route: (args) => valhallaResponse(args.excludePolygons.length ? ROUTE_B : ROUTE_A) });
  const plan = await planRoute({ stops: [{ lat: 33.80, lon: -84.55 }, { lat: 33.90, lon: -84.55 }], profile: {}, options: {}, seeds: SEEDS, api });
  assert.equal(plan.reroutes, 1);
  assert.equal(plan.counts.danger, 0);
  assert.ok(api.calls.route[1].excludePolygons.length >= 1);
  assert.ok(Math.abs(plan.trip.line[0][1] - -84.53) < 1e-6);
});

test('planner keeps the bridge as a must-know alert when no way around exists', async () => {
  const api = fakeApi({ route: () => valhallaResponse(ROUTE_A) });
  const plan = await planRoute({ stops: [{ lat: 33.80, lon: -84.55 }, { lat: 33.90, lon: -84.55 }], profile: {}, options: {}, seeds: SEEDS, api });
  assert.ok(plan.counts.danger >= 1);
  assert.ok(plan.alerts.some((a) => /Low bridge/.test(a.title)));
});

test('avoid tolls: hard ban first, then minimize with a note', async () => {
  const api = fakeApi({ route: (args) => { if (args.hardTolls) throw noPath(); return valhallaResponse(ROUTE_B, { hasToll: true }); } });
  const plan = await planRoute({ stops: [{ lat: 33.8, lon: -84.53 }, { lat: 33.9, lon: -84.53 }], profile: {}, options: { avoidTolls: true }, seeds: [], api });
  assert.equal(api.calls.route[0].hardTolls, true);
  assert.equal(api.calls.route[1].hardTolls, false);
  assert.ok(plan.notes.some((n) => /minimized/.test(n)));
  assert.ok(plan.notes.some((n) => /still uses a toll/.test(n)));
});

test('a routing outage is reported, not papered over by loosening settings', async () => {
  const api = fakeApi({ route: () => { throw Object.assign(new Error('Map service unreachable'), { status: 504 }); } });
  await assert.rejects(planRoute({ stops: [{ lat: 33.8, lon: -84.53 }, { lat: 33.9, lon: -84.53 }], options: { avoidTolls: true }, api }), /unreachable/);
  assert.equal(api.calls.route.length, 1);
  assert.equal(isNoPath(noPath()), true);
});

test('avoid a named road the driver called out', async () => {
  const onI95 = valhallaResponse(ROUTE_A, { maneuvers: [{ streets: ['I 95'], from: 0, to: 119 }] });
  const offI95 = valhallaResponse(ROUTE_B, { maneuvers: [{ streets: ['US 1'], from: 0, to: 119 }] });
  const api = fakeApi({ route: (args) => (args.excludeLocations.length ? offI95 : onI95) });
  const plan = await planRoute({ stops: [{ lat: 33.80, lon: -84.4 }, { lat: 33.90, lon: -84.4 }], options: { avoidRoads: ['I-95'] }, seeds: [], api });
  assert.equal(plan.reroutes, 1);
  assert.ok(!plan.alerts.some((a) => a.kind === 'avoid_road'));
});

test('live OSM failures degrade with a note instead of failing the trip', async () => {
  const api = fakeApi({ route: () => valhallaResponse(ROUTE_B), overpass: () => { throw new Error('busy'); }, height: () => { throw new Error('down'); } });
  const plan = await planRoute({ stops: [{ lat: 33.8, lon: -84.53 }, { lat: 33.9, lon: -84.53 }], seeds: [], api });
  assert.ok(plan.notes.some((n) => /Live map check failed/.test(n)));
  assert.ok(plan.notes.some((n) => /Grade check unavailable/.test(n)));
});

test('grades along a mountain route become alerts', async () => {
  const pts = line([35.0, -85.9], [35.1, -85.9], 100);
  const api = fakeApi({
    route: () => valhallaResponse(pts),
    height: (simple) => {
      // Valhalla resamples the shape (resample_distance); mimic that every 100 m.
      let total = 0; for (let i = 1; i < simple.length; i++) total += haversine(simple[i - 1], simple[i]);
      const rh = [];
      for (let d = 0; d <= total; d += 100) rh.push([d, d < 3000 ? 600 : d < 9500 ? 600 - (d - 3000) * 0.06 : 210]);
      return { range_height: rh };
    },
  });
  const plan = await planRoute({ stops: [{ lat: 35, lon: -85.9 }, { lat: 35.1, lon: -85.9 }], seeds: [], api });
  assert.ok(plan.alerts.some((a) => a.kind === 'grade' && a.severity === 'caution'), JSON.stringify(plan.alerts));
});
