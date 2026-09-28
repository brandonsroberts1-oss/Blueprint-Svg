import * as z from 'zod';

/**
 * Structured output returned by the photo analysis (Claude vision). Coordinates are
 * pixels of the image that was analysed (x right, y down).
 */
export const KINDS = ['wall', 'roof', 'gable', 'chimney', 'window', 'door', 'garage', 'vent', 'column', 'railing', 'steps', 'trim', 'light'] as const;

const Point = z.object({ x: z.number(), y: z.number() });
const Box = z.object({
  x0: z.number().describe('left edge (px)'),
  y0: z.number().describe('top edge (px)'),
  x1: z.number().describe('right edge (px)'),
  y1: z.number().describe('bottom edge (px)'),
});

export const DetectedElementSchema = z.object({
  kind: z.enum(KINDS),
  description: z.string().describe('Short description, e.g. "upper left bedroom window"'),
  box: Box.nullable().describe('Axis-aligned box for windows, doors, garage doors, vents, columns, railings, steps, trim boards and lights (include trim/casing). Null for polygon kinds.'),
  polygon: z.array(Point).nullable().describe('Outline vertices for walls, roofs, gables and chimneys. Null for box kinds.'),
  material: z
    .enum(['lap', 'dutch-lap', 'board-batten', 'vertical', 'shake', 'brick', 'stone', 'stucco', 'plain', 'shingle', 'metal', 'tile', 'slate', 'flat'])
    .nullable()
    .describe('Walls/gables/chimneys: cladding. Roofs: shingle, metal, tile, slate, shake or flat.'),
  windowStyle: z.enum(['double-hung', 'casement', 'picture', 'slider', 'awning', 'arch-top', 'round', 'octagon', 'half-round']).nullable(),
  grid: z.enum(['none', 'full', 'top', 'prairie']).nullable().describe('Window grilles: none, full (all sashes), top (upper sash only) or prairie (perimeter).'),
  gridCols: z.number().int().nullable().describe('Panes across per sash'),
  gridRows: z.number().int().nullable().describe('Panes down per sash'),
  units: z.number().int().nullable().describe('Number of windows mulled side by side inside this box'),
  shutters: z.boolean().nullable(),
  doorStyle: z.enum(['six-panel', 'craftsman', 'half-lite', 'full-lite', 'flush', 'double', 'french']).nullable(),
  sidelights: z.enum(['none', 'left', 'right', 'both']).nullable(),
  transom: z.boolean().nullable(),
  garageStyle: z.enum(['raised-panel', 'long-panel', 'carriage', 'flush', 'ribbed', 'full-view']).nullable(),
  garageSections: z.number().int().nullable().describe('Horizontal sections (usually 4)'),
  garageWindows: z.boolean().nullable().describe('True if the top section has windows'),
  ventShape: z.enum(['rect', 'round', 'octagon', 'half-round', 'triangle']).nullable(),
  columnStyle: z.enum(['square', 'tapered', 'round']).nullable(),
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
