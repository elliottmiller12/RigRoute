import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePolyline, decodePolyline, haversine, makeLineIndex, cumulative, squareRing } from '../public/js/core/geo.js';
import { buildRouteRequest, readTrip, roadMatcher, findAvoidedRoadUse, sanitizeLocations, heightRequest, analyzeGrades } from '../public/js/core/valhalla.js';
import { line, valhallaResponse } from './helpers.js';

test('polyline6 round trip and truncated input', () => {
  const pts = [[33.849123, -84.558456], [40.7, -74.0], [34.05, -118.25]];
  const enc = encodePolyline(pts, 6);
  const dec = decodePolyline(enc, 6);
  dec.forEach((p, i) => { assert.ok(Math.abs(p[0] - pts[i][0]) < 1e-6); assert.ok(Math.abs(p[1] - pts[i][1]) < 1e-6); });
  assert.doesNotThrow(() => decodePolyline(enc.slice(0, -3), 6));
});

test('line index finds nearest point and distance along', () => {
  const l = line([33.8, -84.558], [33.9, -84.558], 200);
  const idx = makeLineIndex(l, cumulative(l));
  const n = idx.nearest([33.849, -84.5585], 500);
  assert.ok(n.dist < 60, `dist ${n.dist}`);
  assert.ok(Math.abs(n.along - haversine([33.8, -84.558], [33.849, -84.558])) < 100);
  assert.ok(idx.nearest([34.5, -84.558], 500).dist > 500);
});

test('truck request uses height + buffer in metres and metric tonnes', () => {
  const r = buildRouteRequest({ locations: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], profile: { heightIn: 162, clearanceMarginIn: 3, weightLbs: 80000 }, options: { avoidTolls: true }, hardTolls: true });
  const t = r.costing_options.truck;
  assert.equal(r.costing, 'truck');
  assert.ok(Math.abs(t.height - 165 * 0.0254) < 0.01);
  assert.ok(Math.abs(t.weight - 36.29) < 0.05);
  assert.equal(t.use_tolls, 0);
  assert.equal(t.exclude_tolls, true);
});

test('request builder rejects bad stops and caps exclusions', () => {
  assert.throws(() => sanitizeLocations([{ lat: 1, lon: 1 }]));
  assert.throws(() => sanitizeLocations([{ lat: 100, lon: 1 }, { lat: 1, lon: 1 }]));
  assert.throws(() => sanitizeLocations([{ lat: '1', lon: 1 }, { lat: 1, lon: 1 }]));
  const ring = squareRing(33.8, -84.5, 100);
  const huge = [[-100, 30], [-90, 30], [-90, 40], [-100, 30]];
  const r = buildRouteRequest({ locations: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], excludePolygons: [ring, huge, 'x'], excludeLocations: Array(100).fill({ lat: 1, lon: 1 }) });
  assert.equal(r.exclude_polygons.length, 1);
  assert.ok(r.exclude_locations.length <= 40);
});

test('road matcher: I-9 is not I-95, abbreviations match', () => {
  assert.ok(roadMatcher('I-95')('I 95'));
  assert.ok(roadMatcher('I-95')('Interstate 95'));
  assert.ok(!roadMatcher('I-9')('I 95'));
  assert.ok(!roadMatcher('I-4')('I 40'));
  assert.ok(!roadMatcher('US-1')('US 17'));
  assert.ok(roadMatcher('Storrow Drive')('Storrow Dr'));
});

test('readTrip + findAvoidedRoadUse', () => {
  const pts = line([40, -75], [41, -75], 50);
  const trip = readTrip(valhallaResponse(pts, { maneuvers: [{ streets: ['US 1'], from: 0, to: 20 }, { streets: ['I 95'], from: 20, to: 49 }] }));
  assert.equal(trip.line.length, 50);
  const { hits, points } = findAvoidedRoadUse(trip, ['I-95']);
  assert.equal(hits.length, 1);
  assert.ok(points.length >= 1);
  assert.throws(() => readTrip({}));
});

test('height request validation', () => {
  assert.throws(() => heightRequest('nope'));
  assert.throws(() => heightRequest(Array(5000).fill([1, 1])));
  const r = heightRequest(line([40, -75], [40.5, -75], 50));
  assert.equal(r.range, true);
  assert.ok(typeof r.encoded_polyline === 'string');
});

test('grade analysis finds a long 6% downgrade, ignores rolling hills', () => {
  const simple = line([35.0, -85.9], [35.1, -85.9], 100); // ~11 km
  const total = cumulative(simple).at(-1);
  const rh = [];
  for (let d = 0; d <= total; d += 100) {
    // flat 3 km, 6% down for 6.5 km, flat after
    const e = d < 3000 ? 600 : d < 9500 ? 600 - (d - 3000) * 0.06 : 210;
    rh.push([d, e]);
  }
  const g = analyzeGrades(rh, simple);
  assert.equal(g.length, 1, JSON.stringify(g));
  assert.equal(g[0].downhill, true);
  assert.ok(Math.abs(g[0].avgPct) >= 5 && Math.abs(g[0].avgPct) <= 6.5);
  const hills = [];
  for (let d = 0; d <= total; d += 100) hills.push([d, 300 + 20 * Math.sin(d / 400)]);
  assert.equal(analyzeGrades(hills, simple).length, 0);
});
