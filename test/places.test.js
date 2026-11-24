import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlace, fromPhoton, fromNominatim, rankPlaces, textScore, abbrevStreet, tidyName, regionAbbr, fallbackQuery, fmtDist } from '../public/js/core/places.js';

const WINTER_PARK = { lat: 28.5999, lon: -81.3392 };
const feat = (lon, lat, props) => ({ geometry: { coordinates: [lon, lat] }, properties: { countrycode: 'US', ...props } });

// What Photon returned for "amped fitness cassleberry" in Elliott's screenshot, plus the gym he meant.
const AMPED = { features: [
  feat(-80.25, 26.12, { name: 'Amped Fitness', city: 'Plantation', state: 'Florida', osm_key: 'leisure', osm_value: 'fitness_centre' }),
  feat(-82.50, 28.04, { name: 'amped fitness', street: 'North Dale Mabry Highway', city: 'Northdale', state: 'Florida', osm_key: 'leisure', osm_value: 'fitness_centre' }),
  feat(-72.83, 41.72, { name: 'AMPED Fitness', street: 'Mill Street', city: 'Farmington', state: 'Connecticut', osm_key: 'leisure', osm_value: 'fitness_centre' }),
  feat(-82.79, 27.91, { name: 'Amped Fitness', housenumber: '2480', street: 'East Bay Drive', city: 'Largo', state: 'Florida', osm_key: 'leisure', osm_value: 'fitness_centre' }),
  feat(-81.31, 28.65, { name: 'Amped Fitness', housenumber: '1300', street: 'State Road 436', city: 'Casselberry', state: 'Florida', osm_key: 'leisure', osm_value: 'fitness_centre' }),
] };

test('typo in the town still finds the local place first', () => {
  const r = rankPlaces(fromPhoton(AMPED), 'amped fitness cassleberry', WINTER_PARK);
  assert.equal(r[0].sub, '1300 SR 436, Casselberry, FL');
  assert.ok(r[0].distMi < 10, 'and knows it is close');
  assert.ok(r.findIndex((p) => p.sub.includes('CT')) > 2, 'Connecticut sinks');
});

test('without a location, the exact text match still wins', () => {
  const r = rankPlaces(fromPhoton(AMPED), 'amped fitness casselberry', null);
  assert.match(r[0].sub, /Casselberry/);
  assert.equal(r[0].distMi, null);
});

test('every result reads the same way', () => {
  const r = fromPhoton(AMPED);
  for (const p of r) {
    assert.match(p.title, /^(Amped|AMPED) Fitness$/, `lowercase names tidied, brand caps kept: ${p.title}`);
    assert.match(p.sub, /, (FL|CT)$/, `state abbreviated: ${p.sub}`);
    assert.match(p.label, /^\w+ Fitness, [A-Z][a-z]+, (FL|CT)$/, `box text: ${p.label}`);
  }
  assert.equal(r[1].sub, 'N Dale Mabry Hwy, Northdale, FL');
});

test('street addresses put the address first', () => {
  const p = makePlace({ housenumber: '630', street: 'Lake Sue Avenue', city: 'Winter Park', state: 'Florida', osm_key: 'building', type: 'house' });
  assert.deepEqual([p.title, p.sub, p.label, p.kind], ['630 Lake Sue Ave', 'Winter Park, FL', '630 Lake Sue Ave, Winter Park, FL', 'address']);
});

test('cities read as City, ST', () => {
  const p = makePlace({ name: 'Casselberry', county: 'Seminole County', state: 'Florida', osm_key: 'place', osm_value: 'city', type: 'city' });
  assert.equal(p.label, 'Casselberry, FL');
  assert.equal(p.kind, 'city');
});

test('Nominatim results come out in the same format', () => {
  const r = fromNominatim([{ lat: '28.65', lon: '-81.31', name: 'Amped Fitness', category: 'leisure', type: 'fitness_centre', addresstype: 'leisure',
    address: { house_number: '1300', road: 'State Road 436', city: 'Casselberry', state: 'Florida' }, boundingbox: ['28.6', '28.7', '-81.4', '-81.3'] }]);
  assert.equal(r[0].label, 'Amped Fitness, Casselberry, FL');
  assert.equal(r[0].sub, '1300 SR 436, Casselberry, FL');
  assert.deepEqual(fromNominatim(null), []);
});

test('helpers', () => {
  assert.equal(abbrevStreet('North Federal Highway'), 'N Federal Hwy');
  assert.equal(abbrevStreet('North Street'), 'North St');
  assert.equal(abbrevStreet('Main Street North'), 'Main St N');
  assert.equal(abbrevStreet('State Road 436'), 'SR 436');
  assert.equal(abbrevStreet('U.S. Highway 17'), 'US 17');
  assert.equal(tidyName("McDonald's"), "McDonald's");
  assert.equal(tidyName('LOVES TRAVEL STOP'), 'Loves Travel Stop');
  assert.equal(regionAbbr('Ontario'), 'ON');
  assert.equal(regionAbbr('XX'), 'XX');
  assert.equal(fallbackQuery('amped fitness cassleberry'), 'amped fitness');
  assert.equal(fallbackQuery('casselberry'), null);
  assert.equal(fmtDist(4.24), '4.2 mi');
  assert.equal(fmtDist(null), '');
  assert.ok(textScore('wal mart orlando', { title: 'Walmart Supercenter', sub: 'Orlando, FL' }) > 0.3);
  assert.equal(textScore('zzzz', { title: 'Amped Fitness', sub: 'Largo, FL' }), 0);
});

test('duplicates of the same place collapse', () => {
  const one = { title: 'Pilot', sub: 'Ocala, FL', label: 'Pilot, Ocala, FL', lat: 29.1, lon: -82.1 };
  assert.equal(rankPlaces([one, { ...one, lat: 29.1001 }], 'pilot ocala', null).length, 1);
});
