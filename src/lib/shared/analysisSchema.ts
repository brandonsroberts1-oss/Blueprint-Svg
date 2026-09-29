import * as z from 'zod';
import { KINDS } from './kinds';

/**
 * Structured output returned by the photo analysis (Claude vision). Coordinates are
 * pixels of the image that was analysed (x right, y down).
 */
export { KINDS };

/**
 * Enumerations are expressed as strings that list their allowed values. The SDK sends
 * enums to the API as descriptions anyway, and a lenient parse means one unexpected
 * value can't discard a whole tracing — fromAnalysis() validates every field.
 */
const oneOf = (values: readonly string[], note = '') => z.string().describe(`One of: ${values.join(', ')}.${note ? ` ${note}` : ''}`);

const Point = z.object({ x: z.number(), y: z.number() });
const Box = z.object({
  x0: z.number().describe('left edge (px)'),
  y0: z.number().describe('top edge (px)'),
  x1: z.number().describe('right edge (px)'),
  y1: z.number().describe('bottom edge (px)'),
});

export const DetectedElementSchema = z.object({
  kind: oneOf(KINDS),
  description: z.string().describe('Short description, e.g. "upper left bedroom window"'),
  box: Box.nullable().describe('Axis-aligned box for windows, doors, garage doors, vents, columns, railings, steps, trim boards and lights (include trim/casing). Null for polygon kinds.'),
  polygon: z.array(Point).nullable().describe('Outline vertices for walls, roofs, gables and chimneys. Null for box kinds.'),
  material: oneOf(
    ['lap', 'dutch-lap', 'board-batten', 'vertical', 'shake', 'brick', 'stone', 'stucco', 'plain', 'shingle', 'metal', 'tile', 'slate', 'flat'],
    'Walls/gables/chimneys: cladding. Roofs: shingle, metal, tile, slate, shake or flat.',
  ).nullable(),
  windowStyle: oneOf(['double-hung', 'casement', 'picture', 'slider', 'awning', 'arch-top', 'round', 'octagon', 'half-round']).nullable(),
  grid: oneOf(['none', 'full', 'top', 'prairie'], 'Window grilles: full = all sashes, top = upper sash only, prairie = perimeter.').nullable(),
  gridCols: z.number().int().nullable().describe('Panes across per sash'),
  gridRows: z.number().int().nullable().describe('Panes down per sash'),
  units: z.number().int().nullable().describe('Number of windows mulled side by side inside this box'),
  shutters: z.boolean().nullable(),
  doorStyle: oneOf(['six-panel', 'craftsman', 'half-lite', 'full-lite', 'flush', 'double', 'french']).nullable(),
  sidelights: oneOf(['none', 'left', 'right', 'both']).nullable(),
  transom: z.boolean().nullable(),
  garageStyle: oneOf(['raised-panel', 'long-panel', 'carriage', 'flush', 'ribbed', 'full-view']).nullable(),
  garageSections: z.number().int().nullable().describe('Horizontal sections (usually 4)'),
  garageWindows: z.boolean().nullable().describe('True if the top section has windows'),
  ventShape: oneOf(['rect', 'round', 'octagon', 'half-round', 'triangle']).nullable(),
  columnStyle: oneOf(['square', 'tapered', 'round']).nullable(),
});

export const AnalysisSchema = z.object({
  houseFound: z.boolean().describe('False if the image does not show the front of a house'),
  groundY: z.number().describe('Pixel y of finish grade at the foot of the front wall'),
  stories: z.number().int(),
  architecturalStyle: z.string().describe('e.g. Craftsman, Colonial, Ranch, Farmhouse, Contemporary'),
  elements: z.array(DetectedElementSchema).describe('Back-to-front painting order'),
  notes: z.string().describe('Anything the user should check, in one or two sentences'),
});

export type DetectedElement = z.infer<typeof DetectedElementSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;

export interface AnalyzeRequest {
  /** JPEG/PNG data URL of the (straightened) photo. */
  image: string;
  width: number;
  height: number;
}

export interface AnalyzeResponse {
  analysis: Analysis;
  model: string;
  /** Pixel size of the image the coordinates refer to. */
  width: number;
  height: number;
}
