import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, loadConfig } from '../server.js';
import { line, valhallaResponse } from './helpers.js';

// Fake upstreams (Valhalla, Overpass, Nominatim) on localhost record what our server sends.
const seen = [];
let upstream, app, base, appAi, baseAi;
let llmCalls = 0;

function listen(srv) { return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`))); }

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/route')) {
      const j = JSON.parse(body);
      if (j.locations[0].lat === 0) return send(400, { error_code: 442, error: 'No path could be found for input' });
      return send(200, valhallaResponse(line([33.8, -84.53], [33.9, -84.53], 20)));
    }
    if (req.url.startsWith('/height')) return send(200, { range_height: [[0, 100], [100, 101]] });
    if (req.url.startsWith('/api/interpreter')) return send(200, { elements: [{ type: 'node', id: 1, lat: 1, lon: 1 }], remark: 'x' });
    if (req.url.startsWith('/search')) return send(200, [{ display_name: 'Smyrna, GA <b>', lat: '33.88', lon: '-84.51', boundingbox: ['33.8', '33.9', '-84.6', '-84.4'], extra: 'secret' }]);
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: 'http://example.com/' }); return res.end(); }
    send(404, {});
  });
  const up = await listen(upstream);
  const env = { VALHALLA_URL: up, OVERPASS_URL: `${up}/api/interpreter`, NOMINATIM_URL: up, CONTACT: 'ops@example.test' };
  app = createServer(loadConfig(env), { log: () => {} });
  base = await listen(app);
  appAi = createServer({ ...loadConfig(env), anthropicKey: 'test-key' }, {
    log: () => {},
    llmParse: async (text) => {
      llmCalls++;
      if (/boom/.test(text)) throw new Error('model down');
      return { avoidTolls: true, heightIn: 10, avoidRoads: ['I-95', '<img onerror=x>'], evil: 'yes' };
    },
  });
  baseAi = await listen(appAi);
});

after(() => { upstream.close(); app.close(); appAi.close(); });

const post = (b, path, body, headers = {}) => fetch(b + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('static: security headers and CSP', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  assert.match(await r.text(), /RigRoute/);
});

test('static: no path traversal, no dotfiles, no source outside public/', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/js/..%2f..%2fserver.js', '/..%5cserver.js', '/package.json', '/.env', '/js/%00.js', '/node_modules/@anthropic-ai/sdk/package.json']) {
    const r = await fetch(base + p);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await fetch(`${base}/vendor/maplibre-gl-csp.js`)).headers.get('cache-control'), 'public, max-age=604800, immutable');
});

test('wrong methods and content types are refused', async () => {
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/route`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/api/route`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post(base, '/api/route', 'not json')).status, 400);
  assert.equal((await post(base, '/api/parse', { text: 'x'.repeat(20000) })).status, 413);
});

test('cross-site API calls are blocked', async () => {
  const r = await post(base, '/api/parse', { text: 'avoid tolls' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  const ok = await post(base, '/api/parse', { text: 'avoid tolls' }, { Origin: base });
  assert.equal(ok.status, 200);
});

test('route: client cannot change costing or send raw Valhalla JSON', async () => {
  seen.length = 0;
  const r = await post(base, '/api/route', { costing: 'auto', locations: [{ lat: 33.8, lon: -84.5, street: 'x' }, { lat: 33.9, lon: -84.5 }], profile: { heightIn: 162 }, options: { avoidTolls: true }, id: 'zzz' });
  assert.equal(r.status, 200);
  const sent = JSON.parse(seen.find((s) => s.url.startsWith('/route')).body);
  assert.equal(sent.costing, 'truck');
  assert.equal(sent.id, undefined);
  assert.equal(sent.locations[0].street, undefined);
  assert.match(seen[0].headers['user-agent'], /^RigRoute\/0\.1 \(self-hosted; ops@example\.test\)$/);
  assert.equal((await post(base, '/api/route', { locations: [{ lat: 'x', lon: 1 }, { lat: 1, lon: 1 }] })).status, 400);
});

test('route: no-path comes back as 422 with a plain message', async () => {
  const r = await post(base, '/api/route', { locations: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] });
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /No path/);
});

test('overpass: only our two query kinds, built server-side', async () => {
  seen.length = 0;
  assert.equal((await post(base, '/api/overpass', { kind: 'raw', line: [[1, 1], [2, 2]] })).status, 400);
  assert.equal((await post(base, '/api/overpass', { kind: 'pois', line: '[out:json];node(1);out;' })).status, 400);
  assert.equal(seen.length, 0, 'nothing reached upstream');
  const r = await post(base, '/api/overpass', { kind: 'restrictions', line: [[33.8, -84.5], [33.81, -84.5]] });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(await r.json()), ['elements']);
  assert.match(decodeURIComponent(seen[0].body), /maxheight/);
});

test('geocode: validated input, trimmed output, cached', async () => {
  assert.equal((await fetch(`${base}/api/geocode?q=${encodeURIComponent('<script>')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/geocode?q=`)).status, 400);
  seen.length = 0;
  const a = await (await fetch(`${base}/api/geocode?q=Smyrna%20GA`)).json();
  await fetch(`${base}/api/geocode?q=smyrna%20ga`);
  assert.equal(seen.length, 1, 'second lookup served from cache');
  for (const k of ['title', 'sub', 'label', 'lat', 'lon', 'bbox']) assert.ok(k in a[0], `result has ${k}`);
  assert.deepEqual(a[0].bbox, [33.8, -84.6, 33.9, -84.4]);
  assert.match(seen[0].url, /countrycodes=us%2Cca%2Cmx/);
  assert.match(seen[0].url, /addressdetails=1/);
});

test('parse: rules engine without a key', async () => {
  const j = await (await post(base, '/api/parse', { text: 'avoid tolls and I-95' })).json();
  assert.equal(j.engine, 'rules');
  assert.deepEqual(j.options, { avoidTolls: true, avoidRoads: ['I-95'] });
  assert.equal((await post(base, '/api/parse', { text: '   ' })).status, 400);
});

test('parse: AI output is sanitized and falls back to rules on failure', async () => {
  const j = await (await post(baseAi, '/api/parse', { text: 'no tolls please' })).json();
  assert.equal(j.engine, 'ai');
  assert.deepEqual(j.options, { avoidTolls: true, avoidRoads: ['I-95'] });
  const k = await (await post(baseAi, '/api/parse', { text: 'boom avoid tolls' })).json();
  assert.equal(k.engine, 'rules');
  assert.equal(k.options.avoidTolls, true);
  const cfg = await (await fetch(`${baseAi}/api/config`)).json();
  assert.deepEqual(cfg, { mapStyle: 'https://tiles.openfreemap.org/styles/liberty', llm: true, mode: 'proxy' });
  assert.ok(!JSON.stringify(cfg).includes('test-key'));
});

test('rate limiting kicks in', async () => {
  let limited = 0;
  for (let i = 0; i < 20; i++) if ((await post(base, '/api/height', { line: [[33.8, -84.5], [33.81, -84.5]] })).status === 429) limited++;
  assert.ok(limited > 0);
});

test('upstream down -> 504, never a stack trace', async () => {
  const dead = createServer(loadConfig({ VALHALLA_URL: 'http://127.0.0.1:9' }), { log: () => {} });
  const b = await listen(dead);
  const r = await post(b, '/api/route', { locations: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] });
  assert.equal(r.status, 504);
  assert.deepEqual(Object.keys(await r.json()), ['error']);
  dead.close();
});

test('upstream redirects are not followed', async () => {
  const up = `http://127.0.0.1:${upstream.address().port}/redirect`;
  const red = createServer(loadConfig({ VALHALLA_URL: up }), { log: () => {} });
  const b = await listen(red);
  const r = await post(b, '/api/route', { locations: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] });
  assert.ok(r.status >= 500);
  red.close();
});

test('access log has no coordinates or query text', async () => {
  const lines = [];
  const s = createServer(loadConfig({ NOMINATIM_URL: `http://127.0.0.1:${upstream.address().port}` }), { log: (l) => lines.push(l) });
  const b = await listen(s);
  await fetch(`${b}/api/geocode?q=123%20Main%20St%20Smyrna`);
  await new Promise((r) => setTimeout(r, 20));
  s.close();
  assert.ok(lines.length);
  assert.ok(lines.every((l) => !/Main|Smyrna|33\.|84\./.test(l)), lines.join('\n'));
});
