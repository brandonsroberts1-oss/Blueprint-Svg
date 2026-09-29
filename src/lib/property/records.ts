import type { AssessorRecord } from '../shared/property';
import { fetchJson } from './http';

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && isFinite(Number(v))) return Number(v);
  return null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const get = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Json)[k] : undefined), o);
const first = <T>(...vals: (T | null | undefined)[]): T | null => vals.find((v) => v !== null && v !== undefined) ?? null;

// ---------------------------------------------------------------------------
// RentCast — https://developers.rentcast.io/reference/property-records
// ---------------------------------------------------------------------------

export async function rentcastLookup(address: string, apiKey: string): Promise<AssessorRecord | null> {
  const url = 'https://api.rentcast.io/v1/properties?' + new URLSearchParams({ address });
  const data = await fetchJson<unknown>(url, { headers: { 'X-Api-Key': apiKey } });
  const rec = Array.isArray(data) ? data[0] : data;
  return rec && typeof rec === 'object' ? fromRentcast(rec as Json) : null;
}

export function fromRentcast(r: Json): AssessorRecord {
  const f = (k: string) => get(r, `features.${k}`);
  return {
    provider: 'RentCast',
    yearBuilt: num(r.yearBuilt),
    livingAreaSqFt: num(r.squareFootage),
    lotSizeSqFt: num(r.lotSize),
    bedrooms: num(r.bedrooms),
    bathrooms: num(r.bathrooms),
    stories: num(f('floorCount')),
    propertyType: str(r.propertyType),
    parcelId: str(r.assessorID),
    subdivision: str(r.subdivision),
    legalDescription: str(r.legalDescription),
    county: str(r.county),
    architectureType: str(f('architectureType')),
    exteriorType: str(f('exteriorType')),
    roofType: str(f('roofType')),
    garageType: str(f('garageType')),
    garageSpaces: num(f('garageSpaces')),
    foundationType: str(f('foundationType')),
    zoning: str(r.zoning),
  };
}

// ---------------------------------------------------------------------------
// ATTOM — https://api.developer.attomdata.com/docs (property/expandedprofile)
// ---------------------------------------------------------------------------

export async function attomLookup(line1: string, line2: string, apiKey: string): Promise<AssessorRecord | null> {
  const url =
    'https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/expandedprofile?' + new URLSearchParams({ address1: line1, address2: line2 });
  const data = await fetchJson<Json>(url, { headers: { apikey: apiKey } });
  const prop = (data.property as Json[] | undefined)?.[0];
  return prop ? fromAttom(prop) : null;
}

export function fromAttom(p: Json): AssessorRecord {
  const lotAcres = num(get(p, 'lot.lotSize1'));
  const lotSqFt = first(num(get(p, 'lot.lotSize2')), lotAcres !== null ? lotAcres * 43560 : null);
  return {
    provider: 'ATTOM',
    yearBuilt: first(num(get(p, 'summary.yearBuilt')), num(get(p, 'summary.yearbuilt'))),
    livingAreaSqFt: first(num(get(p, 'building.size.livingSize')), num(get(p, 'building.size.livingsize')), num(get(p, 'building.size.universalsize')), num(get(p, 'building.size.bldgsize'))),
    lotSizeSqFt: lotSqFt,
    bedrooms: num(get(p, 'building.rooms.beds')),
    bathrooms: first(num(get(p, 'building.rooms.bathsTotal')), num(get(p, 'building.rooms.bathstotal'))),
    stories: num(get(p, 'building.summary.levels')),
    propertyType: first(str(get(p, 'summary.propSubType')), str(get(p, 'summary.propsubtype')), str(get(p, 'summary.propType')), str(get(p, 'summary.proptype'))),
    parcelId: str(get(p, 'identifier.apn')),
    subdivision: first(str(get(p, 'area.subdName')), str(get(p, 'area.subdname'))),
    legalDescription: str(get(p, 'summary.legal1')),
    county: first(str(get(p, 'area.countrySecSubd')), str(get(p, 'area.countrysecsubd'))),
    architectureType: first(str(get(p, 'building.summary.archStyle')), str(get(p, 'building.summary.archstyle'))),
    exteriorType: first(str(get(p, 'building.construction.wallType')), str(get(p, 'building.construction.walltype'))),
    roofType: first(str(get(p, 'building.construction.roofCover')), str(get(p, 'building.construction.roofcover'))),
    garageType: first(str(get(p, 'building.parking.garageType')), str(get(p, 'building.parking.garagetype'))),
    garageSpaces: first(num(get(p, 'building.parking.prkgSpaces')), num(get(p, 'building.parking.prkgSize'))),
    foundationType: first(str(get(p, 'building.construction.foundationType')), str(get(p, 'building.construction.foundationtype'))),
    zoning: null,
  };
}
