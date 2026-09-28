import { ensureCCW } from '../geometry/polygon';
import { type BBox, type Vec, bboxOf, bboxUnion, rectPoly } from '../geometry/vec';
import { formatFtIn } from '../units';
import { newId } from './defaults';
import type { HouseElement, Level, Project, RectElement } from './types';
import { isPolyElement } from './types';

/** Standard nominal sizes used when the photo is the only source of scale. */
export const ASSUMED = {
  /** 6'-8" slab + ~4" head trim. */
  doorAssemblyFt: 7.0,
  /** Extra height when an entry has a transom. */
  transomFt: 1.33,
  /** 7'-0" door + ~5" head trim. */
  garageAssemblyFt: 7.42,
};

export interface ScaleInfo {
  pxPerFtX: number;
  pxPerFtY: number;
  /** Human readable description of the reference used. */
  source: string;
  confidence: 'measured' | 'records' | 'estimated' | 'guess';
}

export interface WorldFrame {
  pxPerFtX: number;
  pxPerFtY: number;
  groundY: number;
}

export const pxToWorld = (f: WorldFrame, p: Vec): Vec => ({ x: p.x / f.pxPerFtX, y: (f.groundY - p.y) / f.pxPerFtY });
export const worldToPx = (f: WorldFrame, w: Vec): Vec => ({ x: w.x * f.pxPerFtX, y: f.groundY - w.y * f.pxPerFtY });

/** Horizontal pixel extent of all walls (and gables) — the "wall to wall" width. */
export function wallExtentPx(elements: readonly HouseElement[]): { x0: number; x1: number } | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  const hasWalls = elements.some((e) => e.kind === 'wall' && !e.hidden);
  for (const e of elements) {
    if (e.hidden || (e.kind !== 'wall' && (hasWalls || e.kind !== 'gable'))) continue;
    for (const p of e.points) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
    }
  }
  return isFinite(x0) && x1 > x0 ? { x0, x1 } : null;
}

export function resolveScale(project: Project): ScaleInfo {
  const { calibration, elements, property } = project;
  if (calibration.mode === 'measure' && calibration.measure && calibration.measure.lengthFt > 0) {
    const { a, b, lengthFt } = calibration.measure;
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (px > 2) {
      const ppf = px / lengthFt;
      return { pxPerFtX: ppf, pxPerFtY: ppf, source: `Measured reference line = ${formatFtIn(lengthFt)}`, confidence: 'measured' };
    }
  }
  if (calibration.mode === 'facade-width') {
    const width = calibration.facadeWidthFt ?? property.footprintFacadeFt;
    const ext = wallExtentPx(elements);
    if (width && width > 1 && ext) {
      const ppf = (ext.x1 - ext.x0) / width;
      return { pxPerFtX: ppf, pxPerFtY: ppf, source: `Facade width = ${formatFtIn(width)}`, confidence: 'records' };
    }
  }
  return estimateScale(project);
}

/** Estimate from standard door heights, falling back to a typical house height. */
export function estimateScale(project: Project): ScaleInfo {
  const est: { ppf: number; w: number }[] = [];
  const notes: string[] = [];
  for (const e of project.elements) {
    if (e.hidden) continue;
    if (e.kind === 'garage' && e.h > 4) {
      const ft = e.trim ? ASSUMED.garageAssemblyFt : 7.0;
      est.push({ ppf: e.h / ft, w: 2 });
      if (!notes.includes('garage door 7\'-0"')) notes.push(`garage door 7'-0"`);
    } else if (e.kind === 'door' && e.h > 4) {
      const ft = (e.trim ? ASSUMED.doorAssemblyFt : 6.67) + (e.transom ? ASSUMED.transomFt : 0);
      est.push({ ppf: e.h / ft, w: 1.5 });
      if (!notes.includes('entry door 6\'-8"')) notes.push(`entry door 6'-8"`);
    }
  }
  if (est.length) {
    // Weighted median-ish: weighted mean after discarding outliers > 25% from the median.
    const sorted = [...est].sort((a, b) => a.ppf - b.ppf);
    const med = sorted[Math.floor(sorted.length / 2)].ppf;
    const keep = sorted.filter((s) => Math.abs(s.ppf - med) / med < 0.25);
    const wsum = keep.reduce((s, k) => s + k.w, 0);
    const ppf = keep.reduce((s, k) => s + k.ppf * k.w, 0) / wsum;
    return { pxPerFtX: ppf, pxPerFtY: ppf, source: `Estimated from standard ${notes.join(' + ')}`, confidence: 'estimated' };
  }
  // Nothing standard to measure: assume a typical height to the highest roof point.
  const top = highestPointPx(project.elements);
  const stories = project.property.stories ?? guessStories(project);
  const typical = stories >= 2 ? 27 : 18;
  if (top !== null && project.groundY - top > 10) {
    const ppf = (project.groundY - top) / typical;
    return { pxPerFtX: ppf, pxPerFtY: ppf, source: `Rough guess: ${typical} ft to the ridge — add a door or measure something`, confidence: 'guess' };
  }
  const w = project.photo?.width ?? 1000;
  const ppf = w / 60;
  return { pxPerFtX: ppf, pxPerFtY: ppf, source: 'Rough guess — trace the house and add a door or a measurement', confidence: 'guess' };
}

function highestPointPx(elements: readonly HouseElement[]): number | null {
  let top = Infinity;
  for (const e of elements) {
    if (e.hidden) continue;
    if (isPolyElement(e)) for (const p of e.points) top = Math.min(top, p.y);
    else top = Math.min(top, e.y);
  }
  return isFinite(top) ? top : null;
}

function guessStories(project: Project): number {
  // Two rows of windows usually means two stories.
  const wins = project.elements.filter((e): e is RectElement => e.kind === 'window' && !e.hidden);
  if (wins.length < 2) return 1;
  const bottoms = wins.map((w) => w.y + w.h).sort((a, b) => a - b);
  const spread = bottoms[bottoms.length - 1] - bottoms[0];
  const heights = wins.map((w) => w.h).sort((a, b) => a - b);
  const typicalH = heights[Math.floor(heights.length / 2)];
  return spread > typicalH * 1.3 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// World-space element geometry
// ---------------------------------------------------------------------------

export interface WRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WorldEl {
  el: HouseElement;
  index: number;
  /** Counter-clockwise outline in world feet (y up, grade = 0). */
  poly: Vec[];
  /** For rectangle elements. */
  rect: WRect | null;
}

export function toWorldElements(elements: readonly HouseElement[], frame: WorldFrame): WorldEl[] {
  const out: WorldEl[] = [];
  elements.forEach((el, index) => {
    if (el.hidden) return;
    if (isPolyElement(el)) {
      if (el.points.length < 3) return;
      const poly = ensureCCW(el.points.map((p) => pxToWorld(frame, p)));
      out.push({ el, index, poly, rect: null });
    } else {
      if (el.w <= 0 || el.h <= 0) return;
      const a = pxToWorld(frame, { x: el.x, y: el.y + el.h });
      const b = pxToWorld(frame, { x: el.x + el.w, y: el.y });
      const rect = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      out.push({ el, index, poly: rectPoly(rect.x0, rect.y0, rect.x1, rect.y1), rect });
    }
  });
  return out;
}

export function worldBBox(els: readonly WorldEl[]): BBox | null {
  let b: BBox | null = null;
  for (const e of els) b = bboxUnion(b, bboxOf(e.poly));
  return b;
}

// ---------------------------------------------------------------------------
// Level lines
// ---------------------------------------------------------------------------

/** Derive typical datum lines (first floor, second floor, plate, ridge) from the tracing. */
export function autoLevels(project: Project, frame: WorldFrame): Level[] {
  const els = toWorldElements(project.elements, frame);
  if (!els.length) return [];
  const levels: Level[] = [];
  const doors = els.filter((e) => e.el.kind === 'door' && e.rect);
  let ff = 0.67;
  if (doors.length) {
    const d = Math.min(...doors.map((e) => e.rect!.y0));
    if (d > 0.15 && d < 6) ff = d;
  }
  levels.push({ id: newId('lvl'), name: 'FIRST FLOOR', heightFt: ff, show: true });

  const roofs = els.filter((e) => e.el.kind === 'roof' || e.el.kind === 'gable');
  const ridge = roofs.length ? Math.max(...roofs.map((e) => Math.max(...e.poly.map((p) => p.y)))) : null;

  // Eave / plate: bottom of the largest roof surface.
  const roofSurfaces = els.filter((e) => e.el.kind === 'roof');
  let plate: number | null = null;
  if (roofSurfaces.length) {
    const byArea = [...roofSurfaces].sort((a, b) => {
      const ba = bboxOf(a.poly);
      const bb = bboxOf(b.poly);
      return (bb.x1 - bb.x0) * (bb.y1 - bb.y0) - (ba.x1 - ba.x0) * (ba.y1 - ba.y0);
    });
    plate = Math.min(...byArea[0].poly.map((p) => p.y));
  }

  const stories = project.property.stories ?? guessStories(project);
  if (stories >= 2) {
    // Second floor: a little below the sills of the upper windows, else a typical 10'-1".
    const wins = els.filter((e) => e.el.kind === 'window' && e.rect && e.rect.y0 > ff + 8);
    let sf = ff + 10.1;
    if (wins.length) {
      const sill = Math.min(...wins.map((w) => w.rect!.y0));
      sf = Math.min(Math.max(sill - 2.5, ff + 8.5), ff + 12.5);
    }
    if (!plate || plate > sf + 3) levels.push({ id: newId('lvl'), name: 'SECOND FLOOR', heightFt: sf, show: true });
  }
  if (plate !== null && plate > ff + 6) levels.push({ id: newId('lvl'), name: 'TRUSS BEARING', heightFt: plate, show: true });
  if (ridge !== null && (plate === null || ridge > plate + 2)) levels.push({ id: newId('lvl'), name: 'RIDGE', heightFt: ridge, show: true });
  return levels.sort((a, b) => a.heightFt - b.heightFt);
}
