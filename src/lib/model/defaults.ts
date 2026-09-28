import type { Vec } from '../geometry/vec';
import type {
  Annotations,
  DoorStyle,
  ElementKind,
  GarageStyle,
  GridStyle,
  HouseElement,
  LayoutSettings,
  Project,
  PropertyInfo,
  RoofMaterial,
  WallMaterial,
  WindowStyle,
  ChimneyMaterial,
  ColumnStyle,
  VentShape,
  Sidelights,
} from './types';

let counter = 0;
export function newId(prefix = 'el'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface KindInfo {
  label: string;
  plural: string;
  shape: 'rect' | 'poly';
  color: string;
  /** Painter band: 0 walls, 1 roofs & gables, 2 openings & trim, 3 porch items in front. */
  band: number;
  hint: string;
}

export const KIND_INFO: Record<ElementKind, KindInfo> = {
  wall: { label: 'Wall', plural: 'Walls', shape: 'poly', color: '#4f9dff', band: 0, hint: 'Click the corners of a wall area (siding, brick, stone…). Double-click to finish.' },
  roof: { label: 'Roof', plural: 'Roofs', shape: 'poly', color: '#ff7a45', band: 1, hint: 'Click the corners of a visible roof surface (eave at the bottom). Double-click to finish.' },
  gable: { label: 'Gable', plural: 'Gables', shape: 'poly', color: '#ffb020', band: 1, hint: 'Click the outline of a front-facing gable, including the rake trim. Double-click to finish.' },
  chimney: { label: 'Chimney', plural: 'Chimneys', shape: 'poly', color: '#b37feb', band: 1, hint: 'Click the outline of the visible chimney. Double-click to finish.' },
  window: { label: 'Window', plural: 'Windows', shape: 'rect', color: '#36cfc9', band: 2, hint: 'Drag a box around the window including its trim.' },
  door: { label: 'Door', plural: 'Doors', shape: 'rect', color: '#73d13d', band: 2, hint: 'Drag a box around the whole entry: trim, sidelights and transom.' },
  garage: { label: 'Garage door', plural: 'Garage doors', shape: 'rect', color: '#95de64', band: 2, hint: 'Drag a box around the garage door including its trim.' },
  vent: { label: 'Vent', plural: 'Vents', shape: 'rect', color: '#ffd666', band: 2, hint: 'Drag a box around the gable vent / louver.' },
  trim: { label: 'Trim board', plural: 'Trim boards', shape: 'rect', color: '#d3adf7', band: 2, hint: 'Drag a box for a frieze board, band board or water table.' },
  light: { label: 'Light', plural: 'Lights', shape: 'rect', color: '#fff566', band: 2, hint: 'Drag a box around an exterior light fixture.' },
  column: { label: 'Column', plural: 'Columns', shape: 'rect', color: '#ff85c0', band: 3, hint: 'Drag a box around a porch column.' },
  railing: { label: 'Railing', plural: 'Railings', shape: 'rect', color: '#ffc069', band: 3, hint: 'Drag a box around a porch railing.' },
  steps: { label: 'Steps', plural: 'Steps', shape: 'rect', color: '#bfbfbf', band: 3, hint: 'Drag a box around the entry steps.' },
};

export const TOOL_ORDER: ElementKind[] = ['wall', 'roof', 'gable', 'window', 'door', 'garage', 'vent', 'column', 'railing', 'steps', 'trim', 'chimney', 'light'];

export const WALL_MATERIALS: { id: WallMaterial; label: string }[] = [
  { id: 'lap', label: 'Lap siding' },
  { id: 'dutch-lap', label: 'Dutch lap siding' },
  { id: 'board-batten', label: 'Board & batten' },
  { id: 'vertical', label: 'Vertical siding' },
  { id: 'shake', label: 'Shake / shingle siding' },
  { id: 'brick', label: 'Brick' },
  { id: 'stone', label: 'Stone veneer' },
  { id: 'stucco', label: 'Stucco' },
  { id: 'plain', label: 'Plain (no pattern)' },
];

export const ROOF_MATERIALS: { id: RoofMaterial; label: string }[] = [
  { id: 'shingle', label: 'Asphalt shingles' },
  { id: 'metal', label: 'Standing-seam metal' },
  { id: 'tile', label: 'Clay / concrete tile' },
  { id: 'slate', label: 'Slate' },
  { id: 'shake', label: 'Cedar shake' },
  { id: 'flat', label: 'Flat / membrane' },
];

export const WINDOW_STYLES: { id: WindowStyle; label: string }[] = [
  { id: 'double-hung', label: 'Double-hung' },
  { id: 'casement', label: 'Casement' },
  { id: 'picture', label: 'Picture (fixed)' },
  { id: 'slider', label: 'Slider' },
  { id: 'awning', label: 'Awning' },
  { id: 'arch-top', label: 'Arch-top' },
  { id: 'half-round', label: 'Half-round' },
  { id: 'round', label: 'Round' },
  { id: 'octagon', label: 'Octagon' },
];

export const GRID_STYLES: { id: GridStyle; label: string }[] = [
  { id: 'none', label: 'No grilles' },
  { id: 'top', label: 'Upper sash only' },
  { id: 'full', label: 'Full grid' },
  { id: 'prairie', label: 'Prairie (perimeter)' },
];

export const DOOR_STYLES: { id: DoorStyle; label: string }[] = [
  { id: 'six-panel', label: 'Six-panel' },
  { id: 'craftsman', label: 'Craftsman' },
  { id: 'half-lite', label: 'Half-lite' },
  { id: 'full-lite', label: 'Full-lite' },
  { id: 'flush', label: 'Flush' },
  { id: 'double', label: 'Double panel doors' },
  { id: 'french', label: 'French doors' },
];

export const SIDELIGHTS: { id: Sidelights; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'both', label: 'Both sides' },
];

export const GARAGE_STYLES: { id: GarageStyle; label: string }[] = [
  { id: 'raised-panel', label: 'Short raised panels' },
  { id: 'long-panel', label: 'Long raised panels' },
  { id: 'carriage', label: 'Carriage house' },
  { id: 'flush', label: 'Flush' },
  { id: 'ribbed', label: 'Ribbed' },
  { id: 'full-view', label: 'Full-view glass' },
];

export const VENT_SHAPES: { id: VentShape; label: string }[] = [
  { id: 'rect', label: 'Rectangle' },
  { id: 'round', label: 'Round' },
  { id: 'octagon', label: 'Octagon' },
  { id: 'half-round', label: 'Half-round' },
  { id: 'triangle', label: 'Triangle' },
];

export const COLUMN_STYLES: { id: ColumnStyle; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'tapered', label: 'Tapered on pedestal' },
  { id: 'round', label: 'Round' },
];

export const CHIMNEY_MATERIALS: { id: ChimneyMaterial; label: string }[] = [
  { id: 'brick', label: 'Brick' },
  { id: 'stone', label: 'Stone' },
  { id: 'stucco', label: 'Stucco' },
  { id: 'siding', label: 'Siding' },
];

export function defaultAnnotations(): Annotations {
  return {
    title: 'FRONT ELEVATION',
    elevationTag: '',
    projectName: '',
    sheetName: 'A-1',
    showCallouts: true,
    showLevels: true,
    showDimensions: true,
    showPitch: true,
    showScaleBar: true,
    showDetailTags: true,
    showAddress: true,
    dimPrecision: 1,
    maxCallouts: 18,
  };
}

export function defaultLayout(): LayoutSettings {
  return {
    paperWidthMm: 300,
    paperHeightMm: 200,
    marginMm: 6,
    scaleId: 'auto',
    scaleSystem: 'imperial',
    font: 'ems-tech',
    textScale: 1,
    detail: 'medium',
    frame: 'double',
    cutOutline: 'none',
    cornerRadiusMm: 6,
    colorMode: 'layers',
    minHatchMm: 0.9,
  };
}

export function defaultProperty(): PropertyInfo {
  return {
    address: '',
    line1: '',
    line2: '',
    lat: null,
    lon: null,
    facts: {},
    show: {},
    footprintFacadeFt: null,
    stories: null,
    hints: {},
    sources: [],
  };
}

export function defaultProject(): Project {
  return {
    version: 1,
    photo: null,
    straighten: null,
    groundY: 0,
    calibration: { mode: 'auto', measure: null, facadeWidthFt: null },
    elements: [],
    levels: [],
    levelsCustomized: false,
    annotations: defaultAnnotations(),
    property: defaultProperty(),
    layout: defaultLayout(),
    calloutOverrides: {},
    customCallouts: [],
  };
}

type RectInput = { x: number; y: number; w: number; h: number };

/** Create an element with sensible defaults. `wallHint`/`roofHint` come from public records. */
export function createElement(
  kind: ElementKind,
  geom: RectInput | Vec[],
  hints: { wall?: WallMaterial; roof?: RoofMaterial } = {},
): HouseElement {
  const id = newId(kind);
  const pts = Array.isArray(geom) ? geom.map((p) => ({ ...p })) : [];
  const r: RectInput = Array.isArray(geom) ? rectFromPoints(geom) : { ...geom };
  switch (kind) {
    case 'wall':
      return { id, kind, points: pts, material: hints.wall ?? 'lap', exposureIn: 0, cornerBoards: true, foundation: true };
    case 'roof':
      return { id, kind, points: pts, material: hints.roof ?? 'shingle', fascia: true };
    case 'gable':
      return { id, kind, points: pts, material: hints.wall ?? 'lap', exposureIn: 0, rakeIn: 10 };
    case 'chimney':
      return { id, kind, points: pts, material: 'brick' };
    case 'window':
      return { id, kind, ...r, style: 'double-hung', grid: 'top', gridCols: 0, gridRows: 0, units: 1, shutters: false, trim: true, sill: true, header: false };
    case 'door':
      return { id, kind, ...r, style: 'six-panel', sidelights: 'none', transom: false, trim: true };
    case 'garage':
      return { id, kind, ...r, style: 'raised-panel', sections: 4, panels: 0, windows: false, trim: true };
    case 'vent':
      return { id, kind, ...r, shape: 'rect' };
    case 'column':
      return { id, kind, ...r, style: 'square' };
    case 'railing':
      return { id, kind, ...r };
    case 'steps':
      return { id, kind, ...r, count: 0 };
    case 'trim':
      return { id, kind, ...r };
    case 'light':
      return { id, kind, ...r };
  }
}

export function rectFromPoints(points: readonly Vec[]): RectInput {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Index at which a new element should be inserted so openings stay on top of
 * walls/roofs and porch items stay in front of everything.
 */
export function insertionIndex(elements: readonly HouseElement[], kind: ElementKind): number {
  const band = KIND_INFO[kind].band;
  const firstAtLeast = (b: number) => {
    const i = elements.findIndex((e) => KIND_INFO[e.kind].band >= b);
    return i === -1 ? elements.length : i;
  };
  if (band <= 1) return firstAtLeast(2);
  if (band === 2) return firstAtLeast(3);
  return elements.length;
}

export function insertElement(elements: readonly HouseElement[], el: HouseElement): HouseElement[] {
  const i = insertionIndex(elements, el.kind);
  return [...elements.slice(0, i), el, ...elements.slice(i)];
}

/** Stable sort into painter bands while keeping the relative order of walls, roofs and gables. */
export function sortIntoBands(elements: readonly HouseElement[]): HouseElement[] {
  const group = (e: HouseElement) => {
    const b = KIND_INFO[e.kind].band;
    return b <= 1 ? 0 : b === 2 ? 1 : 2;
  };
  return elements
    .map((e, i) => ({ e, i }))
    .sort((a, b) => group(a.e) - group(b.e) || a.i - b.i)
    .map((x) => x.e);
}
