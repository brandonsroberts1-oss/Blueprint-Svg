/** The three on-device models (ONNX, served next to the app from `models/`). */

export type ModelName = 'seg' | 'openings' | 'extras';

/** Bump when the .onnx files change so browsers drop their cached copies. */
export const MODEL_VERSION = 2;

export interface ModelSpec {
  file: string;
  /** Square input size in pixels (the detectors also take other shapes of about the same area). */
  size: number;
  /** Approximate download size in MB, for progress messages. */
  mb: number;
  labels: readonly string[];
}

export const MODELS: Record<ModelName, ModelSpec> = {
  // YOLO26s semantic segmentation trained on ADE20K (150 classes) — output: class map [1, 640, 640] (uint8).
  seg: { file: 'house-seg.onnx', size: 640, mb: 12.5, labels: [] },
  // YOLOv8s trained on Open Images V7, trimmed to these classes — output: [1, 4 + 8, anchors].
  openings: { file: 'house-openings.onnx', size: 800, mb: 11.8, labels: ['window', 'door', 'house', 'building', 'porch', 'stairs', 'lamp', 'tree'] },
  // YOLOE-26s open-vocabulary detector with these text prompts baked in — output: [1, 4 + 11, anchors].
  extras: { file: 'house-extras.onnx', size: 640, mb: 11.4, labels: ['garage door', 'lamp', 'front door', 'chimney', 'column', 'house', 'tree', 'bush', 'car', 'house door', 'door'] },
};

/** ADE20K class ids used by the parser. */
export const ADE = {
  wall: 0,
  building: 1,
  sky: 2,
  floor: 3,
  tree: 4,
  road: 6,
  windowpane: 8,
  grass: 9,
  sidewalk: 11,
  person: 12,
  earth: 13,
  door: 14,
  mountain: 16,
  plant: 17,
  car: 20,
  house: 25,
  field: 29,
  fence: 32,
  rock: 34,
  railing: 38,
  column: 42,
  sand: 46,
  skyscraper: 48,
  path: 52,
  stairs: 53,
  stairway: 59,
  flower: 66,
  hill: 68,
  palm: 72,
  hovel: 79,
  tower: 84,
  awning: 86,
  streetlight: 87,
  pole: 93,
  land: 94,
  bannister: 95,
  step: 121,
} as const;

// ADE20K 'wall' is left out on purpose: outdoors it is mostly garden walls and fences.
export const HOUSE_CLASSES = new Set<number>([ADE.building, ADE.house, ADE.skyscraper, ADE.hovel, ADE.tower, ADE.windowpane, ADE.door, ADE.column, ADE.awning, ADE.railing, ADE.bannister]);
export const SKY_CLASSES = new Set<number>([ADE.sky]);
export const VEG_CLASSES = new Set<number>([ADE.tree, ADE.plant, ADE.palm, ADE.flower]);
export const GROUND_CLASSES = new Set<number>([ADE.floor, ADE.road, ADE.grass, ADE.sidewalk, ADE.earth, ADE.field, ADE.sand, ADE.path, ADE.land, ADE.rock, ADE.stairs, ADE.stairway, ADE.step]);
