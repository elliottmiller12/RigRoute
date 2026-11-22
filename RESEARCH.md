# What drivers deal with that normal maps miss

Ranked by how often it came up and how much it costs a driver when it goes wrong. Sources are linked; the same links ship in `public/data/` so the app shows them next to each warning.

1. **Bridge strikes from bad GPS settings or bad data.** The most common horror story: the GPS routes a 13'6" van under a 12'1" bridge. Usually the truck profile was never set or was left on a default. NY-area drivers report posted clearances off by about a foot.
   [TruckersReport: Unsafe GPS truck route](https://www.thetruckersreport.com/truckingindustryforum/threads/unsafe-gps-truck-route-garmin-dezl.2492165/), [NYC DOT: Know your height](https://www.nyc.gov/html/dot/downloads/pdf/know-your-height.pdf), [Wikipedia: bridges known for strikes](https://en.wikipedia.org/wiki/List_of_bridges_known_for_strikes)
   App: profile + clearance buffer, live OSM clearance check, 26 seeded strike bridges, reroute.

2. **Parking.** #1 issue for drivers in ATRI's 2024 survey; about 56 minutes a day spent hunting for a spot.
   [FreightWaves: ATRI survey](https://www.freightwaves.com/news/atri-survey-drivers-and-carriers-see-top-issues-in-trucking-differently)
   App: truck parking, rest areas and truck stops along the route. Not live occupancy (see What's next).

3. **The last mile.** Receivers' street addresses often aren't the truck gate. Drivers scout on satellite/Street View and navigate to a dropped pin.
   [TruckingTruth: Use your satellite view](https://truckingtruth.com/truckers-forum/Topic-32230/Page-1/use-your-satellite-view-before-getting-into-trouble)
   App: "Scout the receiver" opens satellite view at the destination; tip in Driver intel.

4. **Truck-banned roads that look like normal roads.** NY/CT parkways (Merritt, Hutch, Saw Mill…) and Boston's Storrow Drive/river roads, with bridges as low as 9'.
   [CT Mirror: Merritt Parkway is not for trucks](https://ctmirror.org/2022/07/24/the-merritt-parkway-is-not-for-trucks/), [Mass.gov DCR river roads](https://www.mass.gov/info-details/alert-for-fifa-tourists-and-travelers-on-dcr-river-road-height-restrictions), [FreightWaves: Westchester overpass strikes](https://www.freightwaves.com/news/trucks-striking-overpasses-westchester)
   App: named-road rule for NY/CT parkways, Boston corridor points, OSM `hgv=no`.

5. **Stale maps.** New weight-limit and no-truck signs go up before map data updates. One-direction closures show as full closures and cause pointless detours. Hazmat and weight flags in some truck GPS units are reported wrong often enough that drivers distrust them.
   [TruckersReport: Best GPS for truckers?](https://www.thetruckersreport.com/truckingindustryforum/posts/13118839), [TruckersReport: Garmin lets me down again](https://www.thetruckersreport.com/truckingindustryforum/posts/11572772)
   App: live OSM check at plan time (fresher than baked-in maps), sources shown on every warning, tip to check 511.

6. **Mountain grades and runaway risk.** Monteagle (I-24, ~6% for 4+ miles), Cabbage Hill (I-84), Siskiyou (I-5), Vail Pass (I-70), Wolf Creek, Rabbit Ears, Jellico, Donner.
   [Overdrive: White-knuckle roads](https://www.overdriveonline.com/white-knuckle-roads/), [Wikipedia: Monteagle Mountain](https://en.wikipedia.org/wiki/Monteagle_Mountain), [TruckersReport: most dangerous passes](https://www.thetruckersreport.com/truckingindustryforum/threads/what-are-the-most-dangerous-roads-mountain-passes-in-the-lower-48.223266/)
   App: grade detection from elevation, seeded grades, "avoid the mountains".

7. **Weather corridors.** I-80 Wyoming blow-overs for light/empty trailers; I-70 Colorado chain law Sep–May.
   [FreightWaves: Most dangerous roads, part 3](https://www.freightwaves.com/news/americas-most-dangerous-roads-for-truckers-part-3)
   App: seasonal caution alerts.

8. **Hazmat routing.** Tunnels and routes that ban placarded loads, e.g. the Eisenhower Tunnel (use Loveland Pass).
   [CDOT: Eisenhower Tunnel](https://www.codot.gov/travel/ejmt/metering)
   App: hazmat flag in profile/prompt, seeded bans, OSM `hazmat=no`, Valhalla hazmat costing.

9. **Bad routing modes.** "Shortest distance" routing sends trucks down back roads. Experienced drivers cross-check with an atlas.
   [TruckersReport: TruckerPath worth it?](https://www.thetruckersreport.com/truckingindustryforum/posts/13110467)
   App: always fastest truck-legal routing; neighborhood avoidance; atlas tip.

A caveat on the seed data: bridge coordinates come from the Wikipedia list and are marked exact; grade and corridor points are approximate and only produce cautions, never reroutes.
