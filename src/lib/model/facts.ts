import type { PropertyLookup } from '../shared/property';
import type { FactKey, PropertyInfo, RoofMaterial, WallMaterial } from './types';

export const FACT_LABELS: Record<FactKey, string> = {
  yearBuilt: 'Year built',
  livingArea: 'Living area',
  bedsBaths: 'Beds / baths',
  lotSize: 'Lot size',
  stories: 'Stories',
  style: 'Architectural style',
  parcel: 'Parcel number',
  subdivision: 'Subdivision',
  county: 'County',
  coordinates: 'Coordinates',
  elevation: 'Elevation',
  footprint: 'Footprint',
};

const DEFAULT_SHOWN: FactKey[] = ['yearBuilt', 'livingArea', 'bedsBaths', 'lotSize', 'coordinates'];

const n = (v: number) => Math.round(v).toLocaleString('en-US');

export function formatLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
}

function formatLot(sqft: number): string {
  const ac = sqft / 43560;
  return ac >= 0.1 ? `Lot ${ac.toFixed(2)} ac` : `Lot ${n(sqft)} sq ft`;
}

const fmtBaths = (b: number) => (Number.isInteger(b) ? String(b) : b.toFixed(1).replace(/\.0$/, ''));

/** Merge a public-record lookup into the project's property info (keeps user-shown choices). */
export function applyLookup(prev: PropertyInfo, r: PropertyLookup): PropertyInfo {
  const facts: PropertyInfo['facts'] = { ...prev.facts };
  const rec = r.record;
  const b = r.building;
  const set = (k: FactKey, v: string | null | undefined) => {
    if (v) facts[k] = v;
  };
  const year = rec?.yearBuilt ?? (b?.startDate && /^\d{4}/.test(b.startDate) ? parseInt(b.startDate, 10) : null);
  set('yearBuilt', year ? `Built ${year}` : null);
  set('livingArea', rec?.livingAreaSqFt ? `${n(rec.livingAreaSqFt)} sq ft` : null);
  if (rec?.bedrooms || rec?.bathrooms) {
    set('bedsBaths', [rec.bedrooms ? `${rec.bedrooms} bed` : '', rec.bathrooms ? `${fmtBaths(rec.bathrooms)} bath` : ''].filter(Boolean).join(' / '));
  }
  set('lotSize', rec?.lotSizeSqFt ? formatLot(rec.lotSizeSqFt) : null);
  const stories = rec?.stories ?? b?.levels ?? null;
  set('stories', stories ? `${stories} story` : null);
  set('style', rec?.architectureType ?? null);
  set('parcel', rec?.parcelId ? `Parcel ${rec.parcelId}` : null);
  set('subdivision', rec?.subdivision ?? null);
  const county = r.address?.county ?? rec?.county ?? null;
  set('county', county ? (/county|parish|borough/i.test(county) ? county : `${county} County`) : null);
  set('coordinates', r.location ? formatLatLon(r.location.lat, r.location.lon) : null);
  set('elevation', r.elevationFt !== null ? `Elev. ${n(r.elevationFt)} ft` : null);
  set('footprint', b ? `Footprint ${Math.round(b.facadeWidthFt)}' x ${Math.round(b.depthFt)}'` : null);

  const show = { ...prev.show };
  for (const k of DEFAULT_SHOWN) if (show[k] === undefined && facts[k]) show[k] = true;

  return {
    ...prev,
    address: r.query,
    line1: r.address?.line1 ?? prev.line1,
    line2: r.address?.line2 ?? prev.line2,
    lat: r.location?.lat ?? prev.lat,
    lon: r.location?.lon ?? prev.lon,
    facts,
    show,
    footprintFacadeFt: b?.facadeWidthFt ?? prev.footprintFacadeFt,
    stories: stories ?? prev.stories,
    hints: {
      roof: rec?.roofType ?? b?.roofMaterial ?? prev.hints.roof,
      exterior: rec?.exteriorType ?? b?.wallMaterial ?? prev.hints.exterior,
      style: rec?.architectureType ?? prev.hints.style,
    },
    sources: r.sources.filter((s) => s.status === 'ok').map((s) => s.name),
  };
}

export function wallMaterialHint(text?: string): WallMaterial | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes('brick')) return 'brick';
  if (t.includes('stone') || t.includes('rock')) return 'stone';
  if (t.includes('stucco') || t.includes('eifs') || t.includes('plaster')) return 'stucco';
  if (t.includes('shake') || t.includes('shingle')) return 'shake';
  if (t.includes('board') && t.includes('batten')) return 'board-batten';
  if (/(vinyl|wood|siding|fiber|cement|hardboard|aluminum|clapboard|lap|frame|masonite)/.test(t)) return 'lap';
  return undefined;
}

export function roofMaterialHint(text?: string): RoofMaterial | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes('metal') || t.includes('steel') || t.includes('tin')) return 'metal';
  if (t.includes('tile') || t.includes('clay') || t.includes('spanish')) return 'tile';
  if (t.includes('slate')) return 'slate';
  if (t.includes('shake') || t.includes('wood')) return 'shake';
  if (/(built-up|membrane|rubber|tar|gravel|flat|epdm|tpo)/.test(t)) return 'flat';
  if (/(asphalt|composition|shingle|comp)/.test(t)) return 'shingle';
  return undefined;
}
