import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseElevation, parseOpenMeteo } from '../src/lib/property/elevation';
import { fromCensusMatch, fromNominatim } from '../src/lib/property/geocode';
import { analyzeFootprint, parseStreetAddress, streetCore, type OverpassResponse } from '../src/lib/property/osm';
import { fromAttom, fromRentcast } from '../src/lib/property/records';
import { lookupProperty } from '../src/lib/property/index';
import { DEFAULT_SETTINGS, loadSettings, recordProviders, saveSettings } from '../src/lib/settings';

describe('geocoder parsing', () => {
  it('parses a Census match', () => {
    const g = fromCensusMatch({
      matchedAddress: '1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500',
      coordinates: { x: -77.03535, y: 38.898754 },
      addressComponents: { state: 'DC' },
      geographies: { Counties: [{ NAME: 'District of Columbia' }] },
    });
    expect(g.line1).toBe('1600 PENNSYLVANIA AVE NW');
    expect(g.line2).toBe('WASHINGTON, DC 20500');
    expect(g.county).toBe('District of Columbia');
    expect(g.lat).toBeCloseTo(38.898754);
    expect(g.lon).toBeCloseTo(-77.03535);
  });

  it('parses a Nominatim result with an OSM building', () => {
    const g = fromNominatim({
      lat: '35.1',
      lon: '-80.8',
      osm_type: 'way',
      osm_id: 12345,
      address: { house_number: '42', road: 'Oak Street', city: 'Charlotte', state: 'North Carolina', postcode: '28202', county: 'Mecklenburg County' },
    });
    expect(g.line1).toBe('42 Oak Street');
    expect(g.line2).toBe('Charlotte, North Carolina 28202');
    expect(g.osm).toEqual({ type: 'way', id: 12345 });
  });
});

describe('street helpers', () => {
  it('normalises street names', () => {
    expect(streetCore('N Main Street')).toBe('main');
    expect(streetCore('Main St.')).toBe('main');
    expect(streetCore('Maple Ridge Lane')).toBe('maple ridge');
  });
  it('splits house number and street', () => {
    expect(parseStreetAddress('1234 Maple Ridge Ln, Springfield, IL')).toEqual({ number: '1234', street: 'Maple Ridge Ln' });
    expect(parseStreetAddress('Springfield')).toEqual({ number: null, street: null });
  });
});

describe('building footprint', () => {
  // Local helper: metres -> lat/lon around a reference point.
  const lat0 = 40;
  const lon0 = -89;
  const m2ll = (x: number, y: number) => ({ lat: lat0 + y / 111195, lon: lon0 + x / (111195 * Math.cos((lat0 * Math.PI) / 180)) });
  const rect = (x0: number, y0: number, x1: number, y1: number) => [m2ll(x0, y0), m2ll(x1, y0), m2ll(x1, y1), m2ll(x0, y1), m2ll(x0, y0)];

  // House: 14 m wide along x (facing a street to the south, y = -20), 10 m deep.
  const data: OverpassResponse = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'house', 'addr:housenumber': '1234', 'addr:street': 'Maple Ridge Lane', 'building:levels': '2', 'roof:shape': 'gabled' }, geometry: rect(-7, -5, 7, 5) },
      { type: 'way', id: 2, tags: { building: 'house', 'addr:housenumber': '1236' }, geometry: rect(12, -5, 24, 5) },
      { type: 'way', id: 3, tags: { building: 'garage' }, geometry: rect(-4, 8, 2, 13) },
      { type: 'way', id: 10, tags: { highway: 'residential', name: 'Maple Ridge Lane' }, geometry: [m2ll(-60, -20), m2ll(60, -20)] },
      { type: 'way', id: 11, tags: { highway: 'residential', name: 'Cross Street' }, geometry: [m2ll(40, -60), m2ll(40, 60)] },
    ],
  };

  it('matches by house number and measures the street-facing side', () => {
    const f = analyzeFootprint(data, { lat: lat0 - 18 / 111195, lon: lon0, houseNumber: '1234', street: 'Maple Ridge Ln', pointOnStreet: true })!;
    expect(f.match).toBe('address');
    expect(f.facadeWidthFt).toBeCloseTo(14 * 3.28084, 0);
    expect(f.depthFt).toBeCloseTo(10 * 3.28084, 0);
    expect(f.levels).toBe(2);
    expect(f.roofShape).toBe('gabled');
    expect(f.street).toBe('Maple Ridge Lane');
    expect(f.url).toBe('https://www.openstreetmap.org/way/1');
  });

  it('picks the facade facing the named street even when the house is deeper than wide', () => {
    const deep: OverpassResponse = {
      elements: [
        { type: 'way', id: 1, tags: { building: 'house' }, geometry: rect(-4, -9, 4, 9) },
        { type: 'way', id: 10, tags: { highway: 'residential', name: 'Oak Ave' }, geometry: [m2ll(-60, -25), m2ll(60, -25)] },
      ],
    };
    const f = analyzeFootprint(deep, { lat: lat0, lon: lon0, houseNumber: null, street: 'Oak Avenue', pointOnStreet: false })!;
    expect(f.match).toBe('contains');
    expect(f.facadeWidthFt).toBeCloseTo(8 * 3.28084, 0);
    expect(f.depthFt).toBeCloseTo(18 * 3.28084, 0);
  });
});

describe('assessor records', () => {
  it('maps a RentCast record', () => {
    const r = fromRentcast({
      formattedAddress: '5500 Grand Lake Dr, San Antonio, TX 78244',
      propertyType: 'Single Family',
      bedrooms: 3,
      bathrooms: 2,
      squareFootage: 1878,
      lotSize: 8843,
      yearBuilt: 1973,
      assessorID: '05076-103-0500',
      legalDescription: 'CB 5076A BLK 3 LOT 50',
      subdivision: 'CONV A/S CODE',
      county: 'Bexar',
      features: { architectureType: 'Contemporary', exteriorType: 'Wood', floorCount: 1, garageSpaces: 2, garageType: 'Garage', roofType: 'Asphalt', foundationType: 'Slab / Mat / Raft' },
    });
    expect(r).toMatchObject({ yearBuilt: 1973, livingAreaSqFt: 1878, lotSizeSqFt: 8843, stories: 1, parcelId: '05076-103-0500', roofType: 'Asphalt', garageSpaces: 2 });
  });

  it('maps an ATTOM expanded profile', () => {
    const r = fromAttom({
      identifier: { apn: '12-345-678' },
      lot: { lotSize1: 0.25 },
      area: { countrysecsubd: 'Travis County', subdname: 'OAK HILLS' },
      summary: { yearbuilt: 1998, propsubtype: 'SFR', legal1: 'LOT 12 BLK C OAK HILLS' },
      building: {
        size: { livingsize: 2450 },
        rooms: { beds: 4, bathstotal: 2.5 },
        summary: { levels: 2, archStyle: 'Colonial' },
        construction: { wallType: 'Brick', roofcover: 'Composition Shingle' },
        parking: { garagetype: 'Attached', prkgSize: 2 },
      },
    });
    expect(r.yearBuilt).toBe(1998);
    expect(r.livingAreaSqFt).toBe(2450);
    expect(r.lotSizeSqFt).toBeCloseTo(10890);
    expect(r.bathrooms).toBe(2.5);
    expect(r.stories).toBe(2);
    expect(r.exteriorType).toBe('Brick');
    expect(r.county).toBe('Travis County');
  });

  it('parses USGS elevations', () => {
    expect(parseElevation({ value: 812.34 })).toBeCloseTo(812.34);
    expect(parseElevation({ value: '101.5' })).toBeCloseTo(101.5);
    expect(parseElevation({ value: -1000000 })).toBeNull();
    expect(parseOpenMeteo({ elevation: [100] })).toBeCloseTo(328.084);
    expect(parseOpenMeteo({})).toBeNull();
  });
});

describe('lookupProperty orchestration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('combines geocoder, elevation, footprint and records, reporting failures per source', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('geocoding.geo.census.gov'))
        return json({
          result: {
            addressMatches: [
              { matchedAddress: '1234 MAPLE RIDGE LN, SPRINGFIELD, IL, 62704', coordinates: { x: -89.65, y: 39.78 }, geographies: { Counties: [{ NAME: 'Sangamon County' }] } },
            ],
          },
        });
      if (u.includes('nominatim')) return new Response('busy', { status: 503 });
      if (u.includes('epqs.nationalmap.gov')) return json({ value: 598.2 });
      if (u.includes('overpass-api.de')) return json({ elements: [] });
      if (u.includes('api.rentcast.io')) return json([{ yearBuilt: 2004, squareFootage: 2640, features: { floorCount: 2 } }]);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await lookupProperty('1234 Maple Ridge Ln, Springfield, IL 62704', { rentcastKey: 'test-key', email: 'me@example.com' });
    expect(r.address?.line1).toBe('1234 MAPLE RIDGE LN');
    expect(r.address?.county).toBe('Sangamon County');
    expect(r.elevationFt).toBeCloseTo(598.2);
    expect(r.building).toBeNull();
    expect(r.record?.yearBuilt).toBe(2004);
    const status = Object.fromEntries(r.sources.map((s) => [s.name, s.status]));
    expect(status['US Census geocoder']).toBe('ok');
    expect(status['OpenStreetMap Nominatim']).toBe('error');
    expect(status['Building footprint (OpenStreetMap)']).toBe('empty');
    expect(status['Assessor records (RentCast)']).toBe('ok');
    const rentcastCall = fetchMock.mock.calls.find(([u]) => String(u).includes('rentcast'));
    expect(rentcastCall).toBeDefined();
    expect((rentcastCall![1]?.headers as Record<string, string>)['X-Api-Key']).toBe('test-key');
    const nominatimCall = fetchMock.mock.calls.find(([u]) => String(u).includes('nominatim'));
    expect(String(nominatimCall![0])).toContain('email=me%40example.com');
  });

  it('falls back to Open-Meteo elevation and reports blocked services without throwing', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('geocoding.geo.census.gov')) throw new TypeError('Failed to fetch');
        if (u.includes('nominatim'))
          return json([{ lat: '39.78', lon: '-89.65', osm_type: 'way', osm_id: 7, category: 'highway', address: { house_number: '9', road: 'Elm Street', city: 'Springfield', state: 'Illinois', postcode: '62704' } }]);
        if (u.includes('epqs.nationalmap.gov')) throw new TypeError('Failed to fetch');
        if (u.includes('open-meteo')) return json({ elevation: [180] });
        if (u.includes('overpass-api.de')) return json({ elements: [] });
        return new Response('nope', { status: 404 });
      }),
    );
    const r = await lookupProperty('9 Elm Street, Springfield, IL');
    expect(r.address?.line1).toBe('9 Elm Street');
    expect(r.elevationFt).toBeCloseTo(590.55, 1);
    const status = Object.fromEntries(r.sources.map((s) => [s.name, s]));
    expect(status['US Census geocoder'].status).toBe('error');
    expect(status['US Census geocoder'].message).toMatch(/blocked or offline/);
    expect(status['Elevation (Open-Meteo)'].status).toBe('ok');
    expect(status['Assessor records'].status).toBe('skipped');
  });
});


describe('settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  }

  it('remembers keys in localStorage or only for the session', () => {
    const local = fakeStorage();
    const session = fakeStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    saveSettings({ ...DEFAULT_SETTINGS, anthropicKey: 'sk-1', rentcastKey: 'rc', remember: true });
    expect(local.m.size).toBe(1);
    expect(loadSettings().anthropicKey).toBe('sk-1');
    saveSettings({ ...DEFAULT_SETTINGS, anthropicKey: 'sk-2', remember: false });
    expect(local.m.size).toBe(0);
    expect(session.m.size).toBe(1);
    expect(loadSettings()).toMatchObject({ anthropicKey: 'sk-2', model: 'claude-opus-5' });
    expect(recordProviders({ rentcastKey: ' ', attomKey: 'a' })).toEqual(['ATTOM']);
  });
});
