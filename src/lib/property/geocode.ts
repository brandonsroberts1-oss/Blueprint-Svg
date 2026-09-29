import { fetchJson, throttle } from './http';

export interface GeoResult {
  lat: number;
  lon: number;
  line1: string;
  line2: string;
  full: string;
  county?: string;
  state?: string;
  /** The OSM object the geocoder matched. */
  osm?: { type: 'way' | 'relation' | 'node'; id: number };
  /** True when that object is a building (not a road or address point). */
  isBuilding?: boolean;
  source: 'US Census geocoder' | 'OpenStreetMap Nominatim';
}

interface CensusResponse {
  result?: {
    addressMatches?: {
      matchedAddress?: string;
      coordinates?: { x: number; y: number };
      addressComponents?: { state?: string };
      geographies?: Record<string, { NAME?: string; BASENAME?: string }[]>;
    }[];
  };
}

/** US Census Bureau one-line address geocoder (free, US addresses only). */
export async function geocodeCensus(address: string): Promise<GeoResult | null> {
  const url =
    'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?' +
    new URLSearchParams({ address, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'Counties', format: 'json' });
  const data = await fetchJson<CensusResponse>(url);
  const m = data.result?.addressMatches?.[0];
  if (!m?.coordinates || !m.matchedAddress) return null;
  return fromCensusMatch(m);
}

export function fromCensusMatch(m: NonNullable<NonNullable<CensusResponse['result']>['addressMatches']>[number]): GeoResult {
  // "1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500"
  const parts = (m.matchedAddress ?? '').split(',').map((s) => s.trim());
  const line1 = parts[0] ?? '';
  const city = parts[1] ?? '';
  const state = parts[2] ?? m.addressComponents?.state ?? '';
  const zip = parts[3] ?? '';
  const line2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const counties = m.geographies?.Counties ?? m.geographies?.['Counties'] ?? [];
  const county = counties[0]?.NAME ?? counties[0]?.BASENAME;
  return {
    lat: m.coordinates!.y,
    lon: m.coordinates!.x,
    line1,
    line2,
    full: [line1, line2].filter(Boolean).join(', '),
    county,
    state: state || undefined,
    source: 'US Census geocoder',
  };
}

interface NominatimResult {
  lat: string;
  lon: string;
  osm_type?: string;
  osm_id?: number;
  category?: string;
  class?: string;
  display_name?: string;
  address?: Record<string, string>;
}

const nominatimQueue = throttle(1100);

/** OpenStreetMap Nominatim (worldwide; please keep volume low per its usage policy). */
export async function geocodeNominatim(address: string, email = ''): Promise<GeoResult | null> {
  const params = new URLSearchParams({ q: address, format: 'jsonv2', addressdetails: '1', limit: '1' });
  if (email.trim()) params.set('email', email.trim());
  const url = 'https://nominatim.openstreetmap.org/search?' + params;
  const data = await nominatimQueue(() => fetchJson<NominatimResult[]>(url));
  const r = data[0];
  if (!r) return null;
  return fromNominatim(r);
}

export function fromNominatim(r: NominatimResult): GeoResult {
  const a = r.address ?? {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb ?? '';
  const stateZip = [a.state, a.postcode].filter(Boolean).join(' ');
  const line1 = street || (r.display_name ?? '').split(',')[0] || '';
  const line2 = [city, stateZip].filter(Boolean).join(', ');
  const osmType = r.osm_type === 'way' || r.osm_type === 'relation' || r.osm_type === 'node' ? r.osm_type : undefined;
  return {
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    line1,
    line2,
    full: [line1, line2].filter(Boolean).join(', ') || r.display_name || '',
    county: a.county,
    state: a.state,
    osm: osmType && r.osm_id ? { type: osmType, id: r.osm_id } : undefined,
    isBuilding: (r.category ?? r.class) === 'building' && osmType !== 'node',
    source: 'OpenStreetMap Nominatim',
  };
}
