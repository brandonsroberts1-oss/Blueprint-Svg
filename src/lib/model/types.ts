import type { Vec } from '../geometry/vec';
import type { FontId } from '../text/strokeFont';

export type WallMaterial =
  | 'lap'
  | 'dutch-lap'
  | 'board-batten'
  | 'vertical'
  | 'shake'
  | 'brick'
  | 'stone'
  | 'stucco'
  | 'plain';
export type RoofMaterial = 'shingle' | 'metal' | 'tile' | 'slate' | 'shake' | 'flat';
export type WindowStyle =
  | 'double-hung'
  | 'casement'
  | 'picture'
  | 'slider'
  | 'awning'
  | 'arch-top'
  | 'round'
  | 'octagon'
  | 'half-round';
export type GridStyle = 'none' | 'full' | 'top' | 'prairie';
export type DoorStyle = 'six-panel' | 'craftsman' | 'half-lite' | 'full-lite' | 'flush' | 'double' | 'french';
export type Sidelights = 'none' | 'left' | 'right' | 'both';
export type GarageStyle = 'raised-panel' | 'long-panel' | 'carriage' | 'flush' | 'ribbed' | 'full-view';
export type VentShape = 'rect' | 'round' | 'octagon' | 'half-round' | 'triangle';
export type ColumnStyle = 'square' | 'tapered' | 'round';
export type ChimneyMaterial = 'brick' | 'stone' | 'stucco' | 'siding';

interface ElementBase {
  id: string;
  /** Optional user label shown in the element list. */
  name?: string;
  hidden?: boolean;
}

export interface RectGeom {
  /** Rectified-photo pixel coordinates (y down). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PolyGeom {
  points: Vec[];
}

export interface WallEl extends ElementBase, PolyGeom {
  kind: 'wall';
  material: WallMaterial;
  /** Siding exposure / course height in inches (0 = material default). */
  exposureIn: number;
  cornerBoards: boolean;
  /** Plain exposed foundation band at grade. */
  foundation: boolean;
}

export interface RoofEl extends ElementBase, PolyGeom {
  kind: 'roof';
  material: RoofMaterial;
  /** Fascia + gutter band along horizontal eaves. */
  fascia: boolean;
}

export interface GableEl extends ElementBase, PolyGeom {
  kind: 'gable';
  material: WallMaterial;
  exposureIn: number;
  /** Width of the rake trim band in inches. */
  rakeIn: number;
}

export interface ChimneyEl extends ElementBase, PolyGeom {
  kind: 'chimney';
  material: ChimneyMaterial;
}

export interface WindowEl extends ElementBase, RectGeom {
  kind: 'window';
  style: WindowStyle;
  grid: GridStyle;
  /** Panes across / down per sash (0 = automatic). */
  gridCols: number;
  gridRows: number;
  /** Number of mulled units side by side. */
  units: number;
  shutters: boolean;
  trim: boolean;
  sill: boolean;
  header: boolean;
}

export interface DoorEl extends ElementBase, RectGeom {
  kind: 'door';
  style: DoorStyle;
  sidelights: Sidelights;
  transom: boolean;
  trim: boolean;
}

export interface GarageEl extends ElementBase, RectGeom {
  kind: 'garage';
  style: GarageStyle;
  sections: number;
  /** Panels per section (0 = automatic). */
  panels: number;
  windows: boolean;
  trim: boolean;
}

export interface VentEl extends ElementBase, RectGeom {
  kind: 'vent';
  shape: VentShape;
}

export interface ColumnEl extends ElementBase, RectGeom {
  kind: 'column';
  style: ColumnStyle;
}

export interface RailingEl extends ElementBase, RectGeom {
  kind: 'railing';
}

export interface StepsEl extends ElementBase, RectGeom {
  kind: 'steps';
  /** Number of risers (0 = automatic). */
  count: number;
}

export interface TrimEl extends ElementBase, RectGeom {
  kind: 'trim';
}

export interface LightEl extends ElementBase, RectGeom {
  kind: 'light';
}

export type PolyElement = WallEl | RoofEl | GableEl | ChimneyEl;
export type RectElement = WindowEl | DoorEl | GarageEl | VentEl | ColumnEl | RailingEl | StepsEl | TrimEl | LightEl;
export type HouseElement = PolyElement | RectElement;
export type ElementKind = HouseElement['kind'];

export const POLY_KINDS = ['wall', 'roof', 'gable', 'chimney'] as const;
export const isPolyElement = (e: HouseElement): e is PolyElement => (POLY_KINDS as readonly string[]).includes(e.kind);
export const isRectElement = (e: HouseElement): e is RectElement => !isPolyElement(e);

export interface Photo {
  dataUrl: string;
  width: number;
  height: number;
}

export interface Straighten {
  /** The original, un-rectified upload. */
  original: Photo;
  /** Quad on the original photo (tl, tr, br, bl) that is a rectangle in reality. */
  quad: Vec[] | null;
  /** Real width/height of the quad (null = estimated automatically). */
  aspect: number | null;
  /** Known real width / height of the quad in feet (optional; also sets the scale). */
  knownWidthFt?: number | null;
  knownHeightFt?: number | null;
  /** Row-major 3x3 homography from original-photo pixels to the current rectified photo. */
  H?: number[] | null;
}

export type CalibrationMode = 'auto' | 'measure' | 'facade-width';

export interface Calibration {
  mode: CalibrationMode;
  /** Measured reference line on the rectified photo. */
  measure: { a: Vec; b: Vec; lengthFt: number } | null;
  /** Wall-to-wall facade width in feet (e.g. from a building footprint). */
  facadeWidthFt: number | null;
}

export interface Level {
  id: string;
  name: string;
  /** Height above finish grade in feet. */
  heightFt: number;
  show: boolean;
}

export type FactKey =
  | 'yearBuilt'
  | 'livingArea'
  | 'lotSize'
  | 'bedsBaths'
  | 'stories'
  | 'style'
  | 'parcel'
  | 'subdivision'
  | 'county'
  | 'coordinates'
  | 'elevation'
  | 'footprint';

export interface PropertyInfo {
  /** What the user typed. */
  address: string;
  /** Normalized address lines for the title block. */
  line1: string;
  line2: string;
  lat: number | null;
  lon: number | null;
  /** Human-readable facts that can be printed on the sheet (editable). */
  facts: Partial<Record<FactKey, string>>;
  /** Which facts to print. */
  show: Partial<Record<FactKey, boolean>>;
  /** Wall-to-wall facade width estimated from public footprint data (ft). */
  footprintFacadeFt: number | null;
  /** Stories from public records, used for level lines. */
  stories: number | null;
  /** Material hints from records for new callouts. */
  hints: { roof?: string; exterior?: string; style?: string };
  sources: string[];
}

export interface CalloutOverride {
  text?: string;
  enabled?: boolean;
  side?: 'left' | 'right';
}

export interface CustomCallout {
  id: string;
  text: string;
  /** Anchor in rectified-photo pixels. */
  anchor: Vec;
  side: 'auto' | 'left' | 'right';
}

export interface Annotations {
  /** e.g. FRONT ELEVATION */
  title: string;
  /** Builder-style elevation letter, e.g. C -> FRONT ELEVATION "C" (blank = none). */
  elevationTag: string;
  /** e.g. THE SMITH RESIDENCE (blank = none). */
  projectName: string;
  /** Sheet reference in the title bubble, e.g. A-1. */
  sheetName: string;
  showCallouts: boolean;
  showLevels: boolean;
  showDimensions: boolean;
  showPitch: boolean;
  showScaleBar: boolean;
  showDetailTags: boolean;
  showAddress: boolean;
  /** Inch fraction resolution for dimensions (1 = whole inches). */
  dimPrecision: 1 | 2 | 4 | 8;
  maxCallouts: number;
}

export type Detail = 'low' | 'medium' | 'high';
export type FrameStyle = 'none' | 'single' | 'double';
export type CutOutline = 'none' | 'rect' | 'rounded';

export interface LayoutSettings {
  paperWidthMm: number;
  paperHeightMm: number;
  marginMm: number;
  /** 'auto' or a scale id from units.ts */
  scaleId: string;
  scaleSystem: 'imperial' | 'metric';
  font: FontId;
  textScale: number;
  detail: Detail;
  frame: FrameStyle;
  cutOutline: CutOutline;
  cornerRadiusMm: number;
  colorMode: 'layers' | 'single';
  /** Minimum spacing between parallel hatch lines on the output (mm). */
  minHatchMm: number;
}

export interface Project {
  version: 1;
  photo: Photo | null;
  straighten: Straighten | null;
  /** Finish grade line (y in rectified pixels). */
  groundY: number;
  calibration: Calibration;
  /** Painter's order: index 0 is furthest back. */
  elements: HouseElement[];
  levels: Level[];
  /** Levels were edited by hand (otherwise they follow the tracing). */
  levelsCustomized: boolean;
  annotations: Annotations;
  property: PropertyInfo;
  layout: LayoutSettings;
  calloutOverrides: Record<string, CalloutOverride>;
  customCallouts: CustomCallout[];
}
