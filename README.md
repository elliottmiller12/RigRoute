# RigRoute

A lightweight truck map. It routes with your rig's real height, weight, length and hazmat status, checks the route against low bridges, weight limits, truck bans and steep grades, reroutes around what you can't clear, and shows truck parking along the way. You can tell it how to run the trip by voice or text ("avoid tolls, stay off I-95, I'm 13'6 grossing 78k") and it bakes that into the route.

## Run it

Needs Node 20 or newer. No build step.

```
npm install        # optional: only pulls the Anthropic SDK for AI prompt parsing
npm start          # http://127.0.0.1:8080
npm test           # 65 tests: parser, routing logic, hazards, server security
```

Open it on a phone over HTTPS (behind any reverse proxy) to get the mic and "use my location". Browsers only allow those on HTTPS or localhost.

## On your phone (GitHub Pages)

Every push to `main` runs the tests and publishes `public/` to GitHub Pages (see `.github/workflows/pages.yml`). Pages has no server, so the app runs in direct mode: it calls the free public services straight from your phone (Valhalla truck routing, Photon search, Overpass for restrictions and parking, OpenFreeMap tiles). No keys, no accounts. AI prompt parsing needs the server, so on Pages the built-in rule parser handles voice and typed prompts.

The free public services are shared demo servers with fair-use limits. Fine for one driver; if it ever gets real traffic, run your own Valhalla.

## What it does

- **Truck profile:** height, weight, length, width, axles, hazmat, and a clearance buffer. Stored only in the browser.
- **Truck routing:** Valhalla's `truck` costing (height + buffer, weight, axle load, hazmat, tolls, ferries, truck-route preference, no living streets).
- **Live restriction check:** after routing, it asks OpenStreetMap (Overpass) for `maxheight`, `maxweight`, `hgv=no` and `hazmat=no` on the roads the route actually uses. Roads you only cross over are ignored (bearing check), so an underpass below a bridge you drive over doesn't trigger a false alarm.
- **Driver intel:** 46 seeded hazards, each with a source link: 26 known strike bridges, Boston's river roads, the NY/CT parkways, the Eisenhower Tunnel hazmat ban, I-70 chain law, 8 notorious grades (Monteagle, Cabbage Hill, Siskiyou, Vail…), I-80 Wyoming wind. Plus 10 forum-sourced tips. See RESEARCH.md.
- **Reroute loop:** anything you can't legally or physically clear gets excluded and the route is rebuilt (up to 4 times). If there's truly no way around, it keeps the route and shows the spot as a must-know alert instead of hiding it.
- **Grades:** estimates sustained grades from elevation data; "avoid the mountains" tries a flatter route.
- **Parking:** OSM truck parking, rest areas, truck stops and weigh stations within ~1.5 km of the route, with miles-in and distance off route.
- **Voice/typed prompt:** the built-in rule parser understands tolls, highways, ferries, dirt roads, tunnels, truck routes, neighborhoods, mountains, named roads (I-95, US-1, Storrow Drive), places ("downtown Atlanta"), height ("13 6 tall", 13'6"), weight ("78k", "eighty thousand"), length ("53 foot trailer"), hazmat, buffer. Every setting it picked up shows as a chip you can tap off. Spoken readback confirms what it heard.
- **Scout the receiver:** opens satellite view at the destination, which is what drivers on every forum say to do.

## Optional AI parsing

Set `ANTHROPIC_API_KEY` on the server and the prompt also goes through Claude (structured JSON output, merged over the rule parser and run through the same whitelist). The key stays on the server; the browser never sees it. Without a key, or if the call fails, the rule parser handles it.

## Settings (environment variables)

| Variable | Default | What it's for |
|---|---|---|
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where it listens. Set `HOST=0.0.0.0` behind a proxy. |
| `VALHALLA_URL` | public FOSSGIS demo | Routing + elevation |
| `OVERPASS_URL` | overpass-api.de | Live OSM restriction and parking lookups |
| `NOMINATIM_URL` | nominatim.openstreetmap.org | Address search |
| `MAP_STYLE_URL` | OpenFreeMap "liberty" | Map tiles (no key) |
| `CONTACT` | none | Contact email added to the User-Agent (Nominatim's usage policy asks for one) |
| `ANTHROPIC_API_KEY` | none | Turns on AI prompt parsing |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for prompt parsing |
| `TRUST_PROXY=1` | off | Use `X-Forwarded-For` for rate limits (only behind your own proxy) |
| `HSTS=1` | off | Send HSTS (only when served over HTTPS) |

## What you'd need to set up for real use

1. **Your own routing and map services.** The public Valhalla, Overpass and Nominatim servers are free but fair-use only and rate limited; they're fine for you and a few friends, not for an app store launch. Self-host Valhalla + Overpass (Docker images exist, US extract ~10 GB) or pay a provider. Then point the env vars at them.
2. **HTTPS hosting.** Any small VPS or a container host. Put it behind Caddy or nginx with a certificate.
3. **Optionally an Anthropic API key** if you want AI parsing. You add it to the server's environment yourself.

## Security and privacy

- Strict CSP (`script-src 'self'`, no inline script, no eval, `frame-ancestors 'none'`), nosniff, no referrer, COOP/CORP, tight Permissions-Policy.
- The server is not an open proxy: it never forwards what the browser sends. It validates inputs and rebuilds every Valhalla, Overpass and Nominatim request itself, so a client can't change the costing model or run its own Overpass query.
- Cross-site API calls blocked (Origin check), per-IP rate limits, body size limits, JSON-only, upstream timeouts and size caps, redirects not followed.
- Path traversal, dotfiles and anything outside `public/` are refused.
- No accounts, no analytics, no third-party scripts. The access log has method, path, status and time only: no coordinates, no addresses.
- Map vendor code (MapLibre 5.24.1, CSP build) is vendored, not loaded from a CDN.
- Voice: speech recognition is the browser's. In Chrome that means audio goes to Google's speech service; typed prompts never leave your server.
- All data from the network is rendered with `textContent`; only `http(s)` links are clickable.

## Layout

```
server.js              static files + narrow API proxy (zero dependencies)
src/llm.js             optional Claude prompt parsing
src/limits.js          rate limiter + LRU cache
public/index.html      the app
public/js/app.js       UI and map
public/js/api.js       proxy mode, or direct-to-public-services mode with no server
public/js/voice.js     speech in/out
public/js/core/        shared by browser, server and tests
  parser.js            voice/typed prompt -> route options
  planner.js           route -> check -> exclude -> reroute loop
  hazards.js           turns intel + live OSM + grades into alerts
  valhalla.js          truck request builder, response reader, grades
  overpass.js          restriction/parking queries and on-route matching
public/data/           seeded hazards and tips, every entry sourced
test/                  node:test suites
```

Not a substitute for posted signs, your atlas, or your own judgment.
