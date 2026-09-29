import type { Vec } from '../geometry/vec';
import type { Analysis, DetectedElement } from '../shared/analysisSchema';
import { KINDS } from '../shared/kinds';
import { createElement, sortIntoBands } from './defaults';
import type {
  ChimneyMaterial,
  ColumnStyle,
  DoorStyle,
  GarageStyle,
  GridStyle,
  HouseElement,
  RoofMaterial,
  Sidelights,
  VentShape,
  WallMaterial,
  WindowStyle,
} from './types';

const WALL: WallMaterial[] = ['lap', 'dutch-lap', 'board-batten', 'vertical', 'shake', 'brick', 'stone', 'stucco', 'plain'];
const ROOF: RoofMaterial[] = ['shingle', 'metal', 'tile', 'slate', 'shake', 'flat'];
const CHIMNEY: ChimneyMaterial[] = ['brick', 'stone', 'stucco', 'siding'];
const WINDOW: WindowStyle[] = ['double-hung', 'casement', 'picture', 'slider', 'awning', 'arch-top', 'round', 'octagon', 'half-round'];
const GRID: GridStyle[] = ['none', 'full', 'top', 'prairie'];
const DOOR: DoorStyle[] = ['six-panel', 'craftsman', 'half-lite', 'full-lite', 'flush', 'double', 'french'];
const SIDE: Sidelights[] = ['none', 'left', 'right', 'both'];
const GARAGE: GarageStyle[] = ['raised-panel', 'long-panel', 'carriage', 'flush', 'ribbed', 'full-view'];
const VENT: VentShape[] = ['rect', 'round', 'octagon', 'half-round', 'triangle'];
const COLUMN: ColumnStyle[] = ['square', 'tapered', 'round'];

const pick = <T extends string>(v: string | null | undefined, allowed: readonly T[], fallback: T): T => (v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const intIn = (v: number | null | undefined, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;

export interface ImportedTracing {
  elements: HouseElement[];
  groundY: number;
  stories: number;
  style: string;
  notes: string;
  skipped: number;
}

/**
 * Convert a structured analysis into editable elements. `sx`/`sy` scale analysis
 * pixels to the rectified photo; `w`/`h` is the photo size.
 */
export function elementsFromAnalysis(a: Analysis, sx: number, sy: number, w: number, h: number): ImportedTracing {
  const clampPt = (p: Vec): Vec => ({ x: Math.max(-0.05 * w, Math.min(1.05 * w, p.x * sx)), y: Math.max(-0.05 * h, Math.min(1.05 * h, p.y * sy)) });
  const out: HouseElement[] = [];
  let skipped = 0;

  for (const d of a.elements ?? []) {
    const el = convert(d, clampPt);
    if (el) out.push(el);
    else skipped++;
  }

  const bottoms = out.filter((e) => e.kind === 'wall').flatMap((e) => ('points' in e ? e.points.map((p) => p.y) : []));
  let groundY = typeof a.groundY === 'number' && isFinite(a.groundY) ? a.groundY * sy : NaN;
  if (!(groundY > h * 0.3 && groundY <= h * 1.02)) groundY = bottoms.length ? Math.max(...bottoms) : h * 0.9;

  return {
    elements: sortIntoBands(out),
    groundY,
    stories: intIn(a.stories, 1, 4, 1),
    style: a.architecturalStyle ?? '',
    notes: a.notes ?? '',
    skipped,
  };
}

function convert(d: DetectedElement, P: (p: Vec) => Vec): HouseElement | null {
  if (!(KINDS as readonly string[]).includes(d.kind)) return null;
  const polyKinds = ['wall', 'roof', 'gable', 'chimney'];
  let pts: Vec[] | null = d.polygon && d.polygon.length >= 3 ? d.polygon.map(P) : null;
  let box: { x: number; y: number; w: number; h: number } | null = null;
  if (d.box) {
    const a = P({ x: Math.min(d.box.x0, d.box.x1), y: Math.min(d.box.y0, d.box.y1) });
    const b = P({ x: Math.max(d.box.x0, d.box.x1), y: Math.max(d.box.y0, d.box.y1) });
    box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  if (polyKinds.includes(d.kind)) {
    if (!pts && box) pts = [{ x: box.x, y: box.y + box.h }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x + box.w, y: box.y }, { x: box.x, y: box.y }];
    if (!pts) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) < 4 || Math.max(...ys) - Math.min(...ys) < 4) return null;
  } else {
    if (!box && pts) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (!box || box.w < 3 || box.h < 3) return null;
  }

  const name = d.description?.slice(0, 60) || undefined;
  switch (d.kind) {
    case 'wall': {
      const e = createElement('wall', pts!);
      if (e.kind !== 'wall') return null;
      e.material = pick(d.material, WALL, 'lap');
      if (['brick', 'stone', 'stucco'].includes(e.material)) e.cornerBoards = false;
      return { ...e, name };
    }
    case 'gable': {
      const e = createElement('gable', pts!);
      if (e.kind !== 'gable') return null;
      e.material = pick(d.material, WALL, 'lap');
      return { ...e, name };
    }
    case 'roof': {
      const e = createElement('roof', pts!);
      if (e.kind !== 'roof') return null;
      e.material = pick(d.material, ROOF, 'shingle');
      return { ...e, name };
    }
    case 'chimney': {
      const e = createElement('chimney', pts!);
      if (e.kind !== 'chimney') return null;
      const m = d.material === 'lap' || d.material === 'vertical' || d.material === 'shake' ? 'siding' : d.material;
      e.material = pick(m, CHIMNEY, 'brick');
      return { ...e, name };
    }
    case 'window': {
      const e = createElement('window', box!);
      if (e.kind !== 'window') return null;
      e.style = pick(d.windowStyle, WINDOW, 'double-hung');
      e.grid = pick(d.grid, GRID, 'none');
      e.gridCols = intIn(d.gridCols, 0, 8, 0);
      e.gridRows = intIn(d.gridRows, 0, 6, 0);
      e.units = intIn(d.units, 1, 6, 1);
      e.shutters = d.shutters ?? false;
      return { ...e, name };
    }
    case 'door': {
      const e = createElement('door', box!);
      if (e.kind !== 'door') return null;
      e.style = pick(d.doorStyle, DOOR, 'six-panel');
      e.sidelights = pick(d.sidelights, SIDE, 'none');
      e.transom = d.transom ?? false;
      return { ...e, name };
    }
    case 'garage': {
      const e = createElement('garage', box!);
      if (e.kind !== 'garage') return null;
      e.style = pick(d.garageStyle, GARAGE, 'raised-panel');
      e.sections = intIn(d.garageSections, 1, 8, 4);
      e.windows = d.garageWindows ?? false;
      return { ...e, name };
    }
    case 'vent': {
      const e = createElement('vent', box!);
      if (e.kind !== 'vent') return null;
      e.shape = pick(d.ventShape, VENT, 'rect');
      return { ...e, name };
    }
    case 'column': {
      const e = createElement('column', box!);
      if (e.kind !== 'column') return null;
      e.style = pick(d.columnStyle, COLUMN, 'square');
      return { ...e, name };
    }
    case 'railing':
    case 'steps':
    case 'trim':
    case 'light':
      return { ...createElement(d.kind, box!), name };
    default:
      return null;
  }
}
