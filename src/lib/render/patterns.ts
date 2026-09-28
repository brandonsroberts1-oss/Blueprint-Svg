import { type Region, clipPolyline, hatchLines } from '../geometry/clip';
import { pointInPolygon } from '../geometry/polygon';
import { type Polyline, type Vec, circlePoly } from '../geometry/vec';
import type { Detail, RoofMaterial, WallMaterial, ChimneyMaterial } from '../model/types';

export const IN = 1 / 12;

export interface PatternCtx {
  /** Output scale, used to keep hatch lines engraveable. */
  mmPerFt: number;
  minHatchMm: number;
  detail: Detail;
  rng: () => number;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Multiplier (integer >= 1) needed so lines `spacingFt` apart stay >= minHatchMm on paper. */
export function thinFactor(spacingFt: number, ctx: PatternCtx): number {
  const mm = spacingFt * ctx.mmPerFt;
  if (mm <= 0) return 1;
  return Math.max(1, Math.ceil(ctx.minHatchMm / mm - 1e-9));
}

function spacing(nominalFt: number, ctx: PatternCtx): number {
  const s = nominalFt * (ctx.detail === 'low' ? 2 : 1);
  return s * thinFactor(s, ctx);
}

const clipAll = (lines: Polyline[], area: Region, exclude: readonly Region[]) =>
  lines.flatMap((l) => clipPolyline(l, [area], exclude));

function horizontalCourses(area: Region, exclude: readonly Region[], s: number, anchorY: number): Polyline[] {
  return clipAll(hatchLines(area.bbox, s, 0, { x: 0, y: anchorY }), area, exclude);
}

function verticalLines(area: Region, exclude: readonly Region[], s: number, anchorX: number): Polyline[] {
  return clipAll(hatchLines(area.bbox, s, Math.PI / 2, { x: anchorX, y: 0 }), area, exclude);
}

/** Short vertical joints inside each course band (shakes, slate, brick heads). */
function courseJoints(
  area: Region,
  exclude: readonly Region[],
  course: number,
  anchorY: number,
  joint: (row: number, rng: () => number) => number[],
  rng: () => number,
): Polyline[] {
  const b = area.bbox;
  const out: Polyline[] = [];
  const k0 = Math.floor((b.y0 - anchorY) / course);
  const k1 = Math.ceil((b.y1 - anchorY) / course);
  let guard = 0;
  for (let k = k0; k < k1; k++) {
    const y0 = anchorY + k * course;
    const y1 = y0 + course;
    for (const x of joint(k, rng)) {
      if (x < b.x0 || x > b.x1) continue;
      if (++guard > 60000) return out;
      out.push(...clipPolyline([{ x, y: y0 }, { x, y: y1 }], [area], exclude));
    }
  }
  return out;
}

function staggeredJoints(x0: number, x1: number, pitch: number, offsetPerRow: number) {
  return (row: number) => {
    const xs: number[] = [];
    const off = ((row % 2) + 2) % 2 === 1 ? offsetPerRow : 0;
    const start = Math.floor((x0 - off) / pitch) * pitch + off;
    for (let x = start; x <= x1; x += pitch) xs.push(x);
    return xs;
  };
}

function randomJoints(x0: number, x1: number, minW: number, maxW: number) {
  return (_row: number, rng: () => number) => {
    const xs: number[] = [];
    let x = x0 - rng() * maxW;
    while (x <= x1) {
      x += minW + rng() * (maxW - minW);
      xs.push(x);
    }
    return xs;
  };
}

function stipple(area: Region, exclude: readonly Region[], ctx: PatternCtx, perSqFt: number): Polyline[] {
  const b = area.bbox;
  const a = (b.x1 - b.x0) * (b.y1 - b.y0);
  const n = Math.min(1500, Math.round(a * perSqFt * (ctx.detail === 'low' ? 0.5 : ctx.detail === 'high' ? 1.4 : 1)));
  const r = 0.18 / ctx.mmPerFt;
  const out: Polyline[] = [];
  for (let i = 0; i < n; i++) {
    const p = { x: b.x0 + ctx.rng() * (b.x1 - b.x0), y: b.y0 + ctx.rng() * (b.y1 - b.y0) };
    if (!pointInPolygon(p, area.poly)) continue;
    if (exclude.some((e) => pointInPolygon(p, e.poly))) continue;
    const c = circlePoly(p, r, 6);
    out.push([...c, c[0]]);
  }
  return out;
}

/** Irregular ashlar stone: rows of random height, stones of random length with softened corners. */
function stones(area: Region, exclude: readonly Region[], ctx: PatternCtx, anchorY: number): Polyline[] {
  const b = area.bbox;
  // Keep individual stones readable on the output: at least ~2.2 mm tall.
  const mul = Math.max(1, 2.2 / (8 * IN * ctx.mmPerFt)) * (ctx.detail === 'low' ? 1.4 : 1);
  const joint = Math.max(0.45 * IN * mul, 0.22 / ctx.mmPerFt);
  const out: Polyline[] = [];
  let y = anchorY + Math.floor((b.y0 - anchorY) / (8 * IN * mul)) * 8 * IN * mul;
  let guard = 0;
  while (y < b.y1 && guard < 4000) {
    const h = (5 + ctx.rng() * 6) * IN * mul;
    let x = b.x0 - ctx.rng() * 16 * IN * mul;
    while (x < b.x1 && guard < 4000) {
      guard++;
      const w = (9 + ctx.rng() * 15) * IN * mul;
      const x0 = x + joint / 2;
      const x1 = x + w - joint / 2;
      const y0 = y + joint / 2;
      const y1 = y + h - joint / 2;
      const j = () => (ctx.rng() - 0.5) * 1.2 * IN * mul;
      const c = Math.min((x1 - x0) * 0.22, (y1 - y0) * 0.3, 1.6 * IN * mul);
      const stone: Vec[] = [
        { x: x0 + c + j(), y: y0 + j() * 0.4 },
        { x: x1 - c + j(), y: y0 + j() * 0.4 },
        { x: x1 + j() * 0.4, y: y0 + c + j() },
        { x: x1 + j() * 0.4, y: y1 - c + j() },
        { x: x1 - c + j(), y: y1 + j() * 0.4 },
        { x: x0 + c + j(), y: y1 + j() * 0.4 },
        { x: x0 + j() * 0.4, y: y1 - c + j() },
        { x: x0 + j() * 0.4, y: y0 + c + j() },
      ];
      out.push(...clipPolyline([...stone, stone[0]], [area], exclude));
      x += w;
    }
    y += h;
  }
  return out;
}

function brick(area: Region, exclude: readonly Region[], ctx: PatternCtx, anchorY: number, courseIn: number): Polyline[] {
  const course = (courseIn || 8 / 3) * IN;
  const k = thinFactor(course, ctx) * (ctx.detail === 'low' ? 2 : 1);
  const c = course * k;
  const lines = horizontalCourses(area, exclude, c, anchorY);
  const pitch = 8 * IN * k;
  lines.push(...courseJoints(area, exclude, c, anchorY, staggeredJoints(area.bbox.x0 - pitch, area.bbox.x1 + pitch, pitch, pitch / 2), ctx.rng));
  return lines;
}

/** Hatch for a wall-type surface. `anchorY` aligns courses between neighbouring walls. */
export function wallPattern(
  material: WallMaterial | ChimneyMaterial,
  exposureIn: number,
  area: Region,
  exclude: readonly Region[],
  ctx: PatternCtx,
  anchorY: number,
): Polyline[] {
  const b = area.bbox;
  switch (material) {
    case 'lap':
    case 'siding':
      return horizontalCourses(area, exclude, spacing((exposureIn || 6) * IN, ctx), anchorY);
    case 'dutch-lap': {
      const e = (exposureIn || 8) * IN;
      const s = spacing(e, ctx);
      const lines = horizontalCourses(area, exclude, s, anchorY);
      if (s === e && thinFactor(e * 0.35, ctx) === 1) lines.push(...horizontalCourses(area, exclude, s, anchorY + e * 0.35));
      return lines;
    }
    case 'board-batten': {
      const pitch = (exposureIn || 16) * IN * (ctx.detail === 'low' ? 1.5 : 1);
      const batten = 2.5 * IN;
      const lines = verticalLines(area, exclude, pitch, b.x0 + pitch / 2);
      if (thinFactor(batten, ctx) === 1) lines.push(...verticalLines(area, exclude, pitch, b.x0 + pitch / 2 + batten));
      return lines;
    }
    case 'vertical':
      return verticalLines(area, exclude, spacing((exposureIn || 8) * IN, ctx), b.x0);
    case 'shake': {
      const course = spacing((exposureIn || 7) * IN, ctx);
      const lines = horizontalCourses(area, exclude, course, anchorY);
      if (ctx.detail !== 'low') lines.push(...courseJoints(area, exclude, course, anchorY, randomJoints(b.x0, b.x1, 4 * IN * (course / (7 * IN)), 10 * IN * (course / (7 * IN))), ctx.rng));
      return lines;
    }
    case 'brick':
      return brick(area, exclude, ctx, anchorY, exposureIn);
    case 'stone':
      return stones(area, exclude, ctx, anchorY);
    case 'stucco':
      return stipple(area, exclude, ctx, 0.9);
    case 'plain':
      return [];
  }
}

export function roofPattern(material: RoofMaterial, area: Region, exclude: readonly Region[], ctx: PatternCtx, anchorY: number): Polyline[] {
  const b = area.bbox;
  switch (material) {
    case 'shingle': {
      const course = spacing(5 * IN, ctx);
      const lines = horizontalCourses(area, exclude, course, anchorY);
      if (ctx.detail === 'high') lines.push(...courseJoints(area, exclude, course, anchorY, randomJoints(b.x0, b.x1, 10 * IN, 40 * IN), ctx.rng));
      return lines;
    }
    case 'metal':
      return verticalLines(area, exclude, spacing(16 * IN, ctx), b.x0 + 8 * IN);
    case 'tile': {
      const pitch = spacing(10 * IN, ctx);
      const lines = verticalLines(area, exclude, pitch, b.x0);
      if (thinFactor(3 * IN, ctx) === 1) lines.push(...verticalLines(area, exclude, pitch, b.x0 + 3 * IN));
      lines.push(...horizontalCourses(area, exclude, spacing(15 * IN, ctx), anchorY));
      return lines;
    }
    case 'slate': {
      const course = spacing(7 * IN, ctx);
      const lines = horizontalCourses(area, exclude, course, anchorY);
      if (ctx.detail !== 'low') lines.push(...courseJoints(area, exclude, course, anchorY, staggeredJoints(b.x0 - 1, b.x1 + 1, 12 * IN * (course / (7 * IN)), 6 * IN * (course / (7 * IN))), ctx.rng));
      return lines;
    }
    case 'shake': {
      const course = spacing(9 * IN, ctx);
      const lines = horizontalCourses(area, exclude, course, anchorY);
      if (ctx.detail !== 'low') lines.push(...courseJoints(area, exclude, course, anchorY, randomJoints(b.x0, b.x1, 5 * IN, 12 * IN), ctx.rng));
      return lines;
    }
    case 'flat':
      return [];
  }
}
