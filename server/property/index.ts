import type { AssessorRecord, PropertyLookup, SourceReport } from '../../src/lib/shared/property';
import { elevationFt } from './elevation';
import { type GeoResult, geocodeCensus, geocodeNominatim } from './geocode';
import { analyzeFootprint, fetchBuildingsNear, parseStreetAddress } from './osm';
import { attomLookup, rentcastLookup } from './records';

const cache = new Map<string, { at: number; value: PropertyLookup }>();
const TTL = 24 * 3600 * 1000;

export function recordProviders(): string[] {
  const out: string[] = [];
  if (process.env.RENTCAST_API_KEY) out.push('RentCast');
  if (process.env.ATTOM_API_KEY) out.push('ATTOM');
  return out;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

export async function lookupProperty(query: string): Promise<PropertyLookup> {
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const sources: SourceReport[] = [];
  let census: GeoResult | null = null;
  let nominatim: GeoResult | null = null;
  try {
    census = await geocodeCensus(query);
    sources.push({ name: 'US Census geocoder', status: census ? 'ok' : 'empty', message: census ? undefined : 'No US address match' });
  } catch (e) {
    sources.push({ name: 'US Census geocoder', status: 'error', message: msg(e) });
  }
  try {
    nominatim = await geocodeNominatim(query);
    sources.push({ name: 'OpenStreetMap Nominatim', status: nominatim ? 'ok' : 'empty' });
  } catch (e) {
    sources.push({ name: 'OpenStreetMap Nominatim', status: 'error', message: msg(e) });
  }

  const geo = census ?? nominatim;
  const result: PropertyLookup = { query, address: null, location: null, elevationFt: null, building: null, record: null, sources };
  if (!geo) {
    sources.push({ name: 'Building footprint (OpenStreetMap)', status: 'skipped', message: 'Address not found' });
    return result;
  }
  // Prefer the Census address text (official), but Nominatim's point when it sits on the building itself.
  result.address = { line1: geo.line1, line2: geo.line2, full: geo.full, county: census?.county ?? nominatim?.county, state: geo.state };
  const onBuilding = nominatim?.osm && nominatim.osm.type !== 'node' && census && Math.hypot(nominatim.lat - census.lat, (nominatim.lon - census.lon) * Math.cos((census.lat * Math.PI) / 180)) < 0.002;
  const point = onBuilding ? nominatim! : geo;
  result.location = { lat: point.lat, lon: point.lon };
  const { number, street } = parseStreetAddress(query);

  const recordTask = async (): Promise<AssessorRecord | null> => {
    const rent = process.env.RENTCAST_API_KEY;
    const attom = process.env.ATTOM_API_KEY;
    if (rent) return rentcastLookup(geo.full || query, rent);
    if (attom) return attomLookup(geo.line1, geo.line2, attom);
    return null;
  };

  const [elev, osm, rec] = await Promise.allSettled([
    elevationFt(point.lat, point.lon),
    fetchBuildingsNear(point.lat, point.lon, onBuilding ? nominatim!.osm : undefined).then((data) =>
      analyzeFootprint(data, {
        lat: point.lat,
        lon: point.lon,
        osm: onBuilding ? nominatim!.osm : undefined,
        houseNumber: number,
        street,
        pointOnStreet: !onBuilding,
      }),
    ),
    recordTask(),
  ]);

  if (elev.status === 'fulfilled') {
    result.elevationFt = elev.value;
    sources.push({ name: 'USGS elevation', status: elev.value !== null ? 'ok' : 'empty' });
  } else sources.push({ name: 'USGS elevation', status: 'error', message: msg(elev.reason) });

  if (osm.status === 'fulfilled') {
    result.building = osm.value;
    sources.push({ name: 'Building footprint (OpenStreetMap)', status: osm.value ? 'ok' : 'empty', message: osm.value ? undefined : 'No mapped building found here' });
  } else sources.push({ name: 'Building footprint (OpenStreetMap)', status: 'error', message: msg(osm.reason) });

  const providers = recordProviders();
  if (!providers.length) {
    sources.push({ name: 'Assessor records', status: 'skipped', message: 'Add RENTCAST_API_KEY (free tier) or ATTOM_API_KEY for year built, square footage, lot size and more' });
  } else if (rec.status === 'fulfilled') {
    result.record = rec.value;
    sources.push({ name: `Assessor records (${providers[0]})`, status: rec.value ? 'ok' : 'empty' });
  } else {
    sources.push({ name: `Assessor records (${providers[0]})`, status: 'error', message: msg(rec.reason) });
  }

  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value: result });
  return result;
}
