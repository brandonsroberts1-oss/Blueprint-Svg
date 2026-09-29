import type { AssessorRecord, PropertyLookup, SourceReport } from '../shared/property';
import { elevationFt, elevationFtOpenMeteo } from './elevation';
import { type GeoResult, geocodeCensus, geocodeNominatim } from './geocode';
import { analyzeFootprint, fetchBuildingsNear, parseStreetAddress } from './osm';
import { attomLookup, rentcastLookup } from './records';

export interface LookupOptions {
  rentcastKey?: string;
  attomKey?: string;
  /** Contact email for Nominatim (optional). */
  email?: string;
}

const cache = new Map<string, { at: number; value: PropertyLookup }>();
const TTL = 24 * 3600 * 1000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Look up public-record facts for an address, calling each public service directly.
 * Every source is optional: failures are reported per source and never throw.
 */
export async function lookupProperty(query: string, opts: LookupOptions = {}): Promise<PropertyLookup> {
  const rentKey = opts.rentcastKey?.trim() ?? '';
  const attomKey = opts.attomKey?.trim() ?? '';
  const key = `${query.trim().toLowerCase().replace(/\s+/g, ' ')}|${rentKey ? 'r' : ''}${attomKey ? 'a' : ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const sources: SourceReport[] = [];
  let census: GeoResult | null = null;
  let nominatim: GeoResult | null = null;
  const [c, n] = await Promise.allSettled([geocodeCensus(query), geocodeNominatim(query, opts.email)]);
  if (c.status === 'fulfilled') {
    census = c.value;
    sources.push({ name: 'US Census geocoder', status: census ? 'ok' : 'empty', message: census ? undefined : 'No US address match' });
  } else sources.push({ name: 'US Census geocoder', status: 'error', message: msg(c.reason) });
  if (n.status === 'fulfilled') {
    nominatim = n.value;
    sources.push({ name: 'OpenStreetMap Nominatim', status: nominatim ? 'ok' : 'empty' });
  } else sources.push({ name: 'OpenStreetMap Nominatim', status: 'error', message: msg(n.reason) });

  const geo = census ?? nominatim;
  const result: PropertyLookup = { query, address: null, location: null, elevationFt: null, building: null, record: null, sources };
  if (!geo) {
    sources.push({ name: 'Building footprint (OpenStreetMap)', status: 'skipped', message: 'Address not found' });
    return result;
  }
  // Prefer the Census address text (official), but Nominatim's point when it sits on the building itself.
  result.address = { line1: geo.line1, line2: geo.line2, full: geo.full, county: census?.county ?? nominatim?.county, state: geo.state };
  const nominatimOnBuilding = !!nominatim?.osm && !!nominatim.isBuilding;
  const agrees = !census || !nominatim || Math.hypot(nominatim.lat - census.lat, (nominatim.lon - census.lon) * Math.cos((census.lat * Math.PI) / 180)) < 0.002;
  const onBuilding = nominatimOnBuilding && agrees;
  const point = onBuilding ? nominatim! : geo;
  result.location = { lat: point.lat, lon: point.lon };
  const { number, street } = parseStreetAddress(query);

  const recordTask = async (): Promise<AssessorRecord | null> => {
    if (rentKey) return rentcastLookup(geo.full || query, rentKey);
    if (attomKey) return attomLookup(geo.line1, geo.line2, attomKey);
    return null;
  };
  const elevationTask = async (): Promise<{ ft: number | null; source: string }> => {
    try {
      const ft = await elevationFt(point.lat, point.lon);
      if (ft !== null) return { ft, source: 'USGS elevation' };
    } catch {
      /* fall through to the worldwide service */
    }
    return { ft: await elevationFtOpenMeteo(point.lat, point.lon), source: 'Elevation (Open-Meteo)' };
  };

  const [elev, osm, rec] = await Promise.allSettled([
    elevationTask(),
    fetchBuildingsNear(point.lat, point.lon, onBuilding ? nominatim!.osm : undefined).then((data) =>
      analyzeFootprint(data, {
        lat: point.lat,
        lon: point.lon,
        osm: onBuilding ? nominatim!.osm : undefined,
        houseNumber: number,
        street,
        pointOnStreet: !onBuilding && !!census,
      }),
    ),
    recordTask(),
  ]);

  if (elev.status === 'fulfilled') {
    result.elevationFt = elev.value.ft;
    sources.push({ name: elev.value.source, status: elev.value.ft !== null ? 'ok' : 'empty' });
  } else sources.push({ name: 'Elevation', status: 'error', message: msg(elev.reason) });

  if (osm.status === 'fulfilled') {
    result.building = osm.value;
    sources.push({ name: 'Building footprint (OpenStreetMap)', status: osm.value ? 'ok' : 'empty', message: osm.value ? undefined : 'No mapped building found here' });
  } else sources.push({ name: 'Building footprint (OpenStreetMap)', status: 'error', message: msg(osm.reason) });

  const provider = rentKey ? 'RentCast' : attomKey ? 'ATTOM' : null;
  if (!provider) {
    sources.push({ name: 'Assessor records', status: 'skipped', message: 'Add a RentCast (free tier) or ATTOM key in Settings for year built, square footage, lot size and more' });
  } else if (rec.status === 'fulfilled') {
    result.record = rec.value;
    sources.push({ name: `Assessor records (${provider})`, status: rec.value ? 'ok' : 'empty' });
  } else {
    sources.push({ name: `Assessor records (${provider})`, status: 'error', message: msg(rec.reason) });
  }

  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value: result });
  return result;
}
