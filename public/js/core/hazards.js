// Turns seed intel + live OSM restrictions + elevation grades into driver alerts,
// and decides what to exclude on a reroute.

import { squareRing, haversine } from './geo.js';
import { fmtFeetIn, fmtLbs, fmtMiles } from './units.js';

export const MAX_EXCLUDE_PERIMETER_M = 9000; // Valhalla default service limit is 10 km total

const sev = { danger: 0, caution: 1, info: 2 };

function inSeason(h, month) {
  return !Array.isArray(h.season) || h.season.includes(month);
}

function nearText(dist) {
  return dist < 60 ? 'on your route' : `about ${Math.round(dist * 3.28084 / 10) * 10} ft from your route`;
}

/**
 * @param {object} ctx { trip, idx (makeLineIndex), profile (effective), seeds, osm, grades, avoidRoadHits, month }
 * @returns {{alerts: object[], excludeRings: number[][][], excludeLocations: {lat,lon}[]}}
 */
export function evaluate(ctx) {
  const { trip, idx, profile, seeds = [], osm = [], grades = [], avoidRoadHits = [], month = new Date().getMonth() + 1 } = ctx;
  const need = profile.heightIn + (profile.clearanceMarginIn || 0);
  const alerts = [];
  const rings = []; // {ring, perim, prio}
  const exLocs = [];
  const total = trip.lengthM || (trip.cum && trip.cum[trip.cum.length - 1]) || 0;

  // --- seed intel -----------------------------------------------------------
  for (const h of seeds) {
    if (h.type === 'no_trucks_named') {
      const re = new RegExp(h.roadPattern, 'i');
      const [s, w, n, e] = h.bbox;
      for (const m of trip.maneuvers) {
        const p = trip.line[Math.min(m.begin, trip.line.length - 1)];
        if (!p || p[0] < s || p[0] > n || p[1] < w || p[1] > e) continue;
        const hit = m.streets.find((st) => re.test(st));
        if (!hit) continue;
        alerts.push({ id: `${h.id}:${m.begin}`, severity: 'danger', kind: 'no_trucks', source: 'seed', title: `No trucks: ${hit}`, detail: h.advice, lat: p[0], lon: p[1], alongM: m.alongM, sources: h.sources });
        const span = Math.max(1, m.end - m.begin);
        for (const f of [0.3, 0.7]) {
          const q = trip.line[Math.min(trip.line.length - 1, m.begin + Math.max(1, Math.round(span * f)))];
          exLocs.push({ lat: q[0], lon: q[1] });
        }
      }
      continue;
    }
    if (!Number.isFinite(h.lat)) continue;
    const near = idx.nearest([h.lat, h.lon], Math.min(h.radiusM || 250, 3000));
    if (near.dist > (h.radiusM || 250)) continue;
    const base = { id: h.id, source: 'seed', lat: h.lat, lon: h.lon, alongM: near.along, sources: h.sources, place: h.place };
    switch (h.type) {
      case 'low_clearance': {
        if (h.clearanceIn < need) {
          alerts.push({ ...base, severity: 'danger', kind: 'low_clearance', title: `Low bridge ${fmtFeetIn(h.clearanceIn)} ${nearText(near.dist)}: you need ${fmtFeetIn(need)}`, detail: `${h.name} (${h.place}). ${h.advice}` });
          if (h.exact) rings.push({ ring: squareRing(h.lat, h.lon, 120), perim: 960, prio: 0 });
        } else {
          alerts.push({ ...base, severity: 'info', kind: 'low_clearance', title: `Known strike bridge ${fmtFeetIn(h.clearanceIn)} (you fit)`, detail: `${h.name} (${h.place}). ${h.advice}` });
        }
        break;
      }
      case 'no_trucks':
        alerts.push({ ...base, severity: 'danger', kind: 'no_trucks', title: `No trucks: ${h.name}`, detail: h.advice });
        break;
      case 'hazmat_restricted':
        if (profile.hazmat) {
          alerts.push({ ...base, severity: 'danger', kind: 'hazmat', title: `Hazmat banned: ${h.name}`, detail: h.advice });
          if (h.exact) rings.push({ ring: squareRing(h.lat, h.lon, 150), perim: 1200, prio: 0 });
        }
        break;
      case 'chain_law':
      case 'high_wind':
        if (inSeason(h, month)) alerts.push({ ...base, severity: 'caution', kind: h.type, title: h.name, detail: h.advice });
        break;
      case 'steep_grade':
      case 'caution':
        alerts.push({ ...base, severity: 'caution', kind: h.type, title: h.name, detail: h.advice });
        break;
      default: break;
    }
  }

  // --- live OSM restrictions on the route -----------------------------------
  for (const f of osm) {
    const nearEnds = f.alongM < 2000 || total - f.alongM < 2000;
    const where = f.name ? ` on ${f.name}` : '';
    const base = { id: f.id, source: 'osm', lat: f.lat, lon: f.lon, alongM: f.alongM };
    let danger = false;
    if (Number.isFinite(f.heightIn)) {
      if (f.heightIn < need) { danger = true; alerts.push({ ...base, severity: 'danger', kind: 'low_clearance', title: `Clearance ${fmtFeetIn(f.heightIn)}${where}: you need ${fmtFeetIn(need)}`, detail: `OpenStreetMap height limit ${f.heightRaw}.` }); }
      else if (f.heightIn < need + 6) alerts.push({ ...base, severity: 'caution', kind: 'low_clearance', title: `Tight clearance ${fmtFeetIn(f.heightIn)}${where}`, detail: `Under 6" to spare over ${fmtFeetIn(need)}. Posted signs can be off; slow down and look.` });
    } else if (f.heightRaw != null && f.heightRaw !== 'none') {
      alerts.push({ ...base, severity: 'caution', kind: 'low_clearance', title: `Posted low clearance${where}`, detail: `Map data marks a height limit ("${String(f.heightRaw).slice(0, 20)}") but no number. Check the sign.` });
    }
    if (Number.isFinite(f.weightLbs) && f.weightLbs < profile.weightLbs) {
      danger = true;
      alerts.push({ ...base, severity: 'danger', kind: 'weight_limit', title: `Weight limit ${fmtLbs(f.weightLbs)}${where}: you're ${fmtLbs(profile.weightLbs)}`, detail: `OpenStreetMap weight limit ${f.weightRaw}.` });
    }
    if (f.hgvNo) {
      if (nearEnds) alerts.push({ ...base, severity: 'caution', kind: 'no_trucks', title: `No-truck road near your stop${where}`, detail: 'Often signed "local delivery only". Check the sign and your receiver\'s directions.' });
      else { danger = true; alerts.push({ ...base, severity: 'danger', kind: 'no_trucks', title: `No trucks${where}`, detail: 'Truck access is prohibited on this stretch per OpenStreetMap.' }); }
    }
    if (f.hazmatNo && profile.hazmat) {
      danger = true;
      alerts.push({ ...base, severity: 'danger', kind: 'hazmat', title: `No hazmat${where}`, detail: 'Hazmat prohibited on this stretch per OpenStreetMap.' });
    }
    if (danger) rings.push({ ring: squareRing(f.lat, f.lon, 30), perim: 240, prio: 1 });
  }

  // --- elevation grades ------------------------------------------------------
  for (const g of grades) {
    const pct = Math.abs(g.avgPct);
    alerts.push({
      id: `grade:${Math.round(g.alongM)}`, source: 'grade', lat: g.at[0], lon: g.at[1], alongM: g.alongM,
      severity: g.downhill ? 'caution' : 'info', kind: 'grade',
      title: `${g.downhill ? 'Steep downgrade' : 'Long climb'} ~${pct}% for ${fmtMiles(g.lengthM)}`,
      detail: g.downhill ? 'Estimated from elevation data. Pick your gear before the crest and keep your speed down.' : 'Estimated from elevation data. Expect to lose speed; watch your temps.',
    });
  }

  // --- roads the driver asked to avoid that we couldn't route around --------
  for (const h of avoidRoadHits) {
    alerts.push({ id: `avoid:${h.road}:${Math.round(h.alongM)}`, source: 'prompt', severity: 'caution', kind: 'avoid_road', alongM: h.alongM, lat: null, lon: null,
      title: `Still on ${h.road} for ${fmtMiles(h.lengthM)}`, detail: 'No truck-legal way around it was found for this stretch.' });
  }

  // Dedupe: same kind within 120 m keeps the most severe.
  alerts.sort((a, b) => sev[a.severity] - sev[b.severity] || a.alongM - b.alongM);
  const kept = [];
  for (const a of alerts) {
    if (a.lat != null && kept.some((k) => k.kind === a.kind && k.lat != null && haversine([k.lat, k.lon], [a.lat, a.lon]) < 120)) continue;
    kept.push(a);
  }
  kept.sort((a, b) => a.alongM - b.alongM || sev[a.severity] - sev[b.severity]);

  // Exclusion budget.
  rings.sort((a, b) => a.prio - b.prio);
  const excludeRings = [];
  let used = 0;
  for (const r of rings) { if (used + r.perim > MAX_EXCLUDE_PERIMETER_M) break; used += r.perim; excludeRings.push(r.ring); }

  return { alerts: kept, excludeRings, excludeLocations: exLocs.slice(0, 30) };
}

export function countBySeverity(alerts) {
  const c = { danger: 0, caution: 0, info: 0 };
  for (const a of alerts) c[a.severity]++;
  return c;
}
