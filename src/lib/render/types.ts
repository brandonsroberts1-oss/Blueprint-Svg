import type { Vec } from '../geometry/vec';

/**
 * Line classes. In the laser file each class is its own colour/group so it can get
 * its own power & speed (heavy outlines darker, hatching lighter).
 */
export type Layer = 'outline' | 'detail' | 'hatch' | 'annotation' | 'text' | 'cut';

export interface Stroke {
  layer: Layer;
  pts: Vec[];
  /** Preview line width override in mm. */
  w?: number;
}

export interface LayerInfo {
  id: Layer;
  name: string;
  /** Laser colour (LightBurn-style palette so layers map automatically). */
  color: string;
  /** Preview stroke width in mm. */
  width: number;
  description: string;
}

export const LAYERS: LayerInfo[] = [
  { id: 'outline', name: 'Outlines', color: '#000000', width: 0.35, description: 'Building silhouette, roof and wall edges, grade line' },
  { id: 'detail', name: 'Details', color: '#0000FF', width: 0.22, description: 'Windows, doors, trim, fascia, columns' },
  { id: 'hatch', name: 'Hatching', color: '#00A000', width: 0.13, description: 'Siding, shingles, brick, stone, grilles' },
  { id: 'annotation', name: 'Annotation lines', color: '#FF00FF', width: 0.16, description: 'Leaders, dimension and level lines, frame' },
  { id: 'text', name: 'Lettering', color: '#FF8000', width: 0.2, description: 'All text (single-line font)' },
  { id: 'cut', name: 'Cut line', color: '#FF0000', width: 0.2, description: 'Optional outline to cut the plaque out' },
];

export const LAYER_BY_ID = Object.fromEntries(LAYERS.map((l) => [l.id, l])) as Record<Layer, LayerInfo>;
