import { minAreaRect, pointInPolygon, pointSegmentDistance, area as polyArea, centroid } from '../../src/lib/geometry/polygon';
import type { Vec } from '../../src/lib/geometry/vec';
import type { BuildingFootprint } from '../../src/lib/shared/property';
import type { GeoResult } from './geocode';
import { fetchJson, throttle } from './http';

interface LatLon {
  lat: number;
  lon: number;
}

export interface OverpassElement {
  type: 'way' | 'relation' | 'node';
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: { type: string; role: string; geometry?: LatLon[] }[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

const FT_PER_M = 3.28084;
const ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'road', 'service']);
const overpassQueue = throttle(1000);

export async function fetchBuildingsNear(lat: number, lon: number, osm?: GeoResult['osm']): Promise<OverpassResponse> {
  const byId = osm && osm.type !== 'node' ? `${osm.type}(${osm.id});` : '';
  const q = `[out:json][timeout:25];(${byId}way["building"](around:70,${lat},${lon});relation["building"](around:70,${lat},${lon});way["highway"](around:160,${lat},${lon}););out tags geom;`;
  return overpassQueue(() =>
    fetchJson<OverpassResponse>('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: q }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs: 30000,
    }),
  );
}

/** Local planar projection in feet around (lat0, lon0). */
function projector(lat0: number, lon0: number) {
  const R = 6371008.8;
  const kx = ((Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180)) * FT_PER_M;
  const ky = (Math.PI / 180) * R * FT_PER_M;
  return (p: LatLon): Vec => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky });
}

const SUFFIX: Record<string, string> = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', boulevard: 'blvd', place: 'pl', terrace: 'ter',
  circle: 'cir', parkway: 'pkwy', highway: 'hwy', trail: 'trl', way: 'way', square: 'sq', crossing: 'xing', point: 'pt', cove: 'cv',
};
const DIRS: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };

/** Core street name without suffix/direction, for loose comparison ("N Main Street" -> "main"). */
export function streetCore(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SUFFIX[w] ?? DIRS[w] ?? w);
  const suffixes = new Set(Object.values(SUFFIX));
  const dirs = new Set(Object.values(DIRS));
  const core = words.filter((w) => !suffixes.has(w) && !dirs.has(w));
  return (core.length ? core : words).join(' ');
}

export function parseStreetAddress(query: string): { number: string | null; street: string | null } {
  const m = query.trim().match(/^(\d+[A-Za-z]?(?:-\d+)?)\s+([^,]+)/);
  return m ? { number: m[1], street: m[2].trim() } : { number: null, street: null };
}

function ringOf(el: OverpassElement): LatLon[] | null {
  if (el.type === 'way' && el.geometry && el.geometry.length >= 4) return el.geometry;
  if (el.type === 'relation' && el.members) {
    const outers = el.members.filter((m) => m.role === 'outer' && m.geometry && m.geometry.length >= 4).map((m) => m.geometry!);
    if (!outers.length) return null;
    return outers.sort((a, b) => b.length - a.length)[0];
  }
  return null;
}

function parseHeightFt(v: string | undefined): number | null {
  if (!v) return null;
  const ft = v.match(/^\s*(\d+(?:\.\d+)?)\s*(?:'|ft)/i);
  if (ft) return parseFloat(ft[1]);
  const m = v.match(/^\s*(\d+(?:\.\d+)?)\s*(?:m)?\s*$/i);
  return m ? parseFloat(m[1]) * FT_PER_M : null;
}

export interface FootprintInput {
  lat: number;
  lon: number;
  osm?: GeoResult['osm'];
  houseNumber: string | null;
  street: string | null;
  /** True when the point is on the street centreline (Census) rather than on the building. */
  pointOnStreet: boolean;
}

/** Pick the building for the address and measure its street-facing width. */
export function analyzeFootprint(data: OverpassResponse, input: FootprintInput): BuildingFootprint | null {
  const proj = projector(input.lat, input.lon);
  const origin = { x: 0, y: 0 };
  const buildings: { el: OverpassElement; poly: Vec[] }[] = [];
  const roads: { name: string | null; pts: Vec[] }[] = [];
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    if (tags.building) {
      const ring = ringOf(el);
      if (!ring) continue;
      const pts = ring.map(proj);
      if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.5) pts.pop();
      if (pts.length >= 3 && polyArea(pts) > 100) buildings.push({ el, poly: pts });
    } else if (tags.highway && ROAD_TYPES.has(tags.highway) && el.geometry && el.geometry.length >= 2) {
      if (tags.highway === 'service' && tags.service && tags.service !== 'alley') continue;
      roads.push({ name: tags.name ?? null, pts: el.geometry.map(proj) });
    }
  }
  if (!buildings.length) return null;

  const distTo = (poly: Vec[], p: Vec) => {
    if (pointInPolygon(p, poly)) return 0;
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegmentDistance(p, poly[i], poly[(i + 1) % poly.length]));
    return d;
  };

  let chosen: { el: OverpassElement; poly: Vec[] } | undefined;
  let match: BuildingFootprint['match'] = 'nearest';
  if (input.osm) {
    chosen = buildings.find((b) => b.el.type === input.osm!.type && b.el.id === input.osm!.id);
    if (chosen) match = 'geocoder';
  }
  if (!chosen && input.houseNumber) {
    const wantStreet = input.street ? streetCore(input.street) : null;
    const byNumber = buildings.filter((b) => b.el.tags?.['addr:housenumber'] === input.houseNumber);
    const withStreet = byNumber.filter((b) => !wantStreet || !b.el.tags?.['addr:street'] || streetCore(b.el.tags['addr:street']) === wantStreet);
    if (withStreet.length) {
      chosen = withStreet.sort((a, b) => distTo(a.poly, origin) - distTo(b.poly, origin))[0];
      match = 'address';
    }
  }
  if (!chosen) {
    chosen = buildings.find((b) => pointInPolygon(origin, b.poly));
    if (chosen) match = 'contains';
  }
  if (!chosen) {
    const sorted = [...buildings].sort((a, b) => distTo(a.poly, origin) - distTo(b.poly, origin));
    // Skip garages/sheds when a house-sized building is nearly as close.
    const main = sorted.find((b) => polyArea(b.poly) > 500 && distTo(b.poly, origin) < distTo(sorted[0].poly, origin) + 25) ?? sorted[0];
    if (distTo(main.poly, origin) > 150) return null;
    chosen = main;
    match = 'nearest';
  }

  const rect = minAreaRect(chosen.poly);
  if (!rect) return null;
  const c = centroid(chosen.poly);
  const sides = [0, 1, 2, 3].map((i) => {
    const a = rect.corners[i];
    const b = rect.corners[(i + 1) % 4];
    return { a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, len: Math.hypot(b.x - a.x, b.y - a.y) };
  });

  // Which side faces the street?
  let frontIdx = -1;
  let streetName: string | null = null;
  if (roads.length) {
    const want = input.street ? streetCore(input.street) : null;
    const named = want ? roads.filter((r) => r.name && streetCore(r.name) === want) : [];
    const pool = named.length ? named : roads;
    let best = { d: Infinity, p: c as Vec, name: null as string | null };
    for (const r of pool) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i];
        const b = r.pts[i + 1];
        const ab = { x: b.x - a.x, y: b.y - a.y };
        const l2 = ab.x * ab.x + ab.y * ab.y || 1;
        const t = Math.max(0, Math.min(1, ((c.x - a.x) * ab.x + (c.y - a.y) * ab.y) / l2));
        const p = { x: a.x + ab.x * t, y: a.y + ab.y * t };
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < best.d) best = { d, p, name: r.name };
      }
    }
    if (isFinite(best.d)) {
      streetName = best.name;
      frontIdx = sides.reduce((bi, s, i) => (Math.hypot(s.mid.x - best.p.x, s.mid.y - best.p.y) < Math.hypot(sides[bi].mid.x - best.p.x, sides[bi].mid.y - best.p.y) ? i : bi), 0);
    }
  }
  if (frontIdx < 0 && input.pointOnStreet && !pointInPolygon(origin, chosen.poly)) {
    frontIdx = sides.reduce((bi, s, i) => (Math.hypot(s.mid.x, s.mid.y) < Math.hypot(sides[bi].mid.x, sides[bi].mid.y) ? i : bi), 0);
  }
  if (frontIdx < 0) frontIdx = sides[0].len >= sides[1].len ? 0 : 1;

  const facade = sides[frontIdx].len;
  const depth = sides[(frontIdx + 1) % 4].len;
  const tags = chosen.el.tags ?? {};
  const levels = tags['building:levels'] ? parseFloat(tags['building:levels']) : NaN;
  return {
    facadeWidthFt: Math.round(facade * 10) / 10,
    depthFt: Math.round(depth * 10) / 10,
    footprintSqFt: Math.round(polyArea(chosen.poly)),
    levels: isFinite(levels) ? levels : null,
    heightFt: parseHeightFt(tags.height),
    roofShape: tags['roof:shape'] ?? null,
    roofMaterial: tags['roof:material'] ?? null,
    wallMaterial: tags['building:material'] ?? null,
    startDate: tags.start_date ?? null,
    match,
    street: streetName,
    url: `https://www.openstreetmap.org/${chosen.el.type}/${chosen.el.id}`,
  };
}
