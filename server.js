// RigRoute server: static files with strict security headers + a narrow API proxy.
// Zero required dependencies. The proxy never forwards raw client queries upstream:
// it validates inputs and rebuilds every Valhalla/Overpass/Nominatim request itself.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRouteRequest, heightRequest } from './public/js/core/valhalla.js';
import { buildRestrictionQuery, buildPoiQuery } from './public/js/core/overpass.js';
import { parsePrompt } from './public/js/core/parser.js';
import { sanitizeOptions } from './public/js/core/options.js';
import { fromNominatim, rankPlaces } from './public/js/core/places.js';
import { llmParse } from './src/llm.js';
import { RateLimiter, LRU } from './src/limits.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export function loadConfig(env = process.env) {
  return {
    port: +(env.PORT || 8080),
    host: env.HOST || '127.0.0.1',
    valhalla: (env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de').replace(/\/+$/, ''),
    overpass: env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
    nominatim: (env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, ''),
    // Nominatim's usage policy asks for an identifying User-Agent with a contact.
    userAgent: `RigRoute/0.1 (self-hosted${env.CONTACT ? `; ${env.CONTACT}` : ''})`,
    mapStyle: env.MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty',
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',
    trustProxy: env.TRUST_PROXY === '1',
    hsts: env.HSTS === '1',
    upstreamTimeoutMs: +(env.UPSTREAM_TIMEOUT_MS || 25000),
  };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(cfg) {
  const tileOrigin = new URL(cfg.mapStyle).origin;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: blob: ${tileOrigin}`,
    `connect-src 'self' ${tileOrigin}`,
    "worker-src 'self'",
    "child-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
  const h = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'microphone=(self), geolocation=(self), camera=(), payment=(), usb=(), interest-cohort=()',
  };
  if (cfg.hsts) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function readJson(req, limit = 64 * 1024) {
  const ct = req.headers['content-type'] || '';
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'JSON only');
  const len = +(req.headers['content-length'] || 0);
  if (len > limit) throw new HttpError(413, 'Too large');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }
}

async function upstream(cfg, url, init = {}, maxBytes = 12 * 1024 * 1024) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(cfg.upstreamTimeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new HttpError(504, 'Map service unreachable');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new HttpError(502, 'Map service response too large');
  let body = null;
  try { body = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  if (!res.ok) {
    if (res.status === 429) throw new HttpError(503, 'Map service is rate limiting; try again in a minute');
    // Valhalla puts "No path could be found" etc. in error; pass a short, plain message only.
    const msg = body && typeof body.error === 'string' ? body.error.slice(0, 120) : `Map service error ${res.status}`;
    throw new HttpError(res.status === 400 ? 422 : 502, msg);
  }
  if (!body) throw new HttpError(502, 'Bad map service response');
  return body;
}

const GEOCODE_RE = /^[\p{L}\p{N} .,'#&\-/]{2,120}$/u;

export function createServer(cfg = loadConfig(), deps = {}) {
  const headers = securityHeaders(cfg);
  const limiters = {
    route: new RateLimiter({ perMinute: 20, burst: 10 }),
    overpass: new RateLimiter({ perMinute: 90, burst: 40 }),
    height: new RateLimiter({ perMinute: 20, burst: 6 }),
    geocode: new RateLimiter({ perMinute: 30, burst: 10 }),
    parse: new RateLimiter({ perMinute: 20, burst: 8 }),
  };
  const geoCache = new LRU(1000, 24 * 3600 * 1000);
  const llm = deps.llmParse || llmParse;
  const log = deps.log || ((line) => console.log(line));

  const clientIp = (req) => {
    if (cfg.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  };

  const send = (res, status, body, extra = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const payload = isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      ...headers,
      'Content-Type': isBuf || typeof body === 'string' ? extra['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(res.req.method === 'HEAD' ? undefined : payload);
  };

  const api = {
    'GET /api/config': async () => ({ mapStyle: cfg.mapStyle, llm: !!cfg.anthropicKey, mode: 'proxy' }),

    'GET /api/geocode': async (req, url) => {
      const q = (url.searchParams.get('q') || '').trim();
      if (!GEOCODE_RE.test(q)) throw new HttpError(400, 'Bad search');
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      const near = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
      const key = `${q.toLowerCase()}|${near ? `${lat.toFixed(1)},${lon.toFixed(1)}` : ''}`;
      const hit = geoCache.get(key);
      if (hit) return hit;
      const u = new URL(`${cfg.nominatim}/search`);
      const params = { q, format: 'jsonv2', limit: '8', countrycodes: 'us,ca,mx,pr', addressdetails: '1' };
      if (near) Object.assign(params, { viewbox: `${lon - 1},${lat + 1},${lon + 1},${lat - 1}`, bounded: '0' });
      u.search = new URLSearchParams(params).toString();
      const out = rankPlaces(fromNominatim(await upstream(cfg, u)), q, near);
      geoCache.set(key, out);
      return out;
    },

    'POST /api/route': async (req) => {
      const body = await readJson(req, 96 * 1024);
      let vreq;
      try { vreq = buildRouteRequest(body || {}); } catch (e) { throw new HttpError(400, e.message); }
      return upstream(cfg, `${cfg.valhalla}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vreq) });
    },

    'POST /api/height': async (req) => {
      const body = await readJson(req, 96 * 1024);
      let hreq;
      try { hreq = heightRequest(body && body.line); } catch (e) { throw new HttpError(400, e.message); }
      return upstream(cfg, `${cfg.valhalla}/height`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hreq) });
    },

    'POST /api/overpass': async (req) => {
      const body = await readJson(req, 64 * 1024);
      const build = body && body.kind === 'pois' ? buildPoiQuery : body && body.kind === 'restrictions' ? buildRestrictionQuery : null;
      if (!build) throw new HttpError(400, 'Bad kind');
      let q;
      try { q = build(body.line); } catch (e) { throw new HttpError(400, e.message); }
      const data = await upstream(cfg, cfg.overpass, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: q }).toString(),
      }, 24 * 1024 * 1024);
      return { elements: Array.isArray(data.elements) ? data.elements : [] };
    },

    'POST /api/parse': async (req) => {
      const body = await readJson(req, 8 * 1024);
      const text = typeof body?.text === 'string' ? body.text.slice(0, 500) : '';
      if (!text.trim()) throw new HttpError(400, 'Say something first');
      const rules = parsePrompt(text);
      if (cfg.anthropicKey) {
        try {
          const ai = await llm(text, { apiKey: cfg.anthropicKey, model: cfg.model });
          if (ai) return { options: sanitizeOptions({ ...rules.options, ...ai }), notes: rules.notes, engine: 'ai' };
        } catch { /* fall through to rules */ }
      }
      return { ...rules, engine: 'rules' };
    },
  };

  async function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad path'); }
    if (rel.includes('\0')) return send(res, 400, 'Bad path');
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
    if (path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
    let st;
    try { st = await stat(file); } catch { return send(res, 404, 'Not found'); }
    if (!st.isFile()) return send(res, 404, 'Not found');
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) return send(res, 404, 'Not found');
    const data = await readFile(file);
    const cache = /\/vendor\//.test(rel) ? 'public, max-age=604800, immutable' : rel === '/sw.js' ? 'no-cache' : 'public, max-age=300';
    send(res, 200, data, { 'Content-Type': type, 'Cache-Control': cache });
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    res.req = req;
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
    res.on('finish', () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`));
    try {
      if (url.pathname.startsWith('/api/')) {
        const handler = api[`${req.method} ${url.pathname}`];
        if (!handler) return send(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'Not found' });
        // Block cross-site API calls: browsers always send Origin on cross-origin POST.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, 'Cross-site request blocked');
        const bucket = url.pathname.split('/')[2];
        if (limiters[bucket] && !limiters[bucket].take(clientIp(req))) throw new HttpError(429, 'Slow down a little');
        return send(res, 200, await handler(req, url));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return await serveStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`error ${url.pathname}: ${err && err.message}`);
      return send(res, status, { error: status === 500 ? 'Something broke on our side' : err.message });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  createServer(cfg).listen(cfg.port, cfg.host, () => {
    console.log(`RigRoute on http://${cfg.host}:${cfg.port}  (AI parsing: ${cfg.anthropicKey ? 'on' : 'off, using rules'})`);
  });
}
