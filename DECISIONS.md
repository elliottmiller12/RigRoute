# Decisions

- **PWA, no framework, no build.** Plain ES modules load fast on a phone on one bar of LTE and install to the home screen. The same `core/` modules run in the browser, on the server and in tests.
- **MapLibre + OpenFreeMap tiles.** Open source, no API key, no tracking. MapLibre's CSP build is vendored so the page needs no CDN and no `unsafe-eval`.
- **Valhalla truck costing.** The only open routing engine with real truck parameters (height, weight, axle load, hazmat). Its `exclude_polygons` budget is ~10 km of perimeter, so exclusions are small squares around specific spots, and named roads/places use `exclude_locations` instead of big polygons.
- **Live Overpass check after routing.** Valhalla's tiles can lag OSM; querying the actual route corridor at plan time catches newer tags. A bearing check separates roads we drive on from roads we pass over.
- **Avoid tolls = hard ban first, then minimize.** If no toll-free truck route exists, it says so instead of failing.
- **Outages never loosen settings.** Only a real "no path" response relaxes avoidance; a network error is reported as an error.
- **Rule parser first, AI optional.** Works offline and free; the AI result goes through the same whitelist, so a model reply can't set anything the rule parser couldn't.
- **Server rebuilds every upstream request.** No open proxy, nothing for a client to smuggle.
- **Danger vs caution.** Only hard, specific conflicts (clearance, weight, truck ban, hazmat) trigger reroutes. Approximate data (grades, weather) only warns.
