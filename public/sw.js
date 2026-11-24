// App-shell cache only. Routes, tiles and API answers are never cached here,
// so nothing about where a driver goes is stored by the service worker.
const VERSION = 'rigroute-v5';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'vendor/maplibre-gl.css', 'vendor/maplibre-gl-csp.js', 'vendor/maplibre-gl-csp-worker.js',
  'js/app.js', 'js/api.js', 'js/voice.js', 'js/night.js', 'js/mode-boot.js',
  'js/core/units.js', 'js/core/places.js', 'js/core/options.js', 'js/core/parser.js', 'js/core/geo.js',
  'js/core/valhalla.js', 'js/core/overpass.js', 'js/core/hazards.js', 'js/core/planner.js',
  'data/hazards.json', 'data/tips.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  // Network first so updates land; cache as offline fallback for the shell.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')) || (p === './' && url.pathname.endsWith('/')))) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request)),
  );
});
