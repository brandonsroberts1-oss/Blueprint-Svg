import emsTech from './fonts/ems-tech.json';
import hersheySans from './fonts/hershey-sans.json';
import type { Polyline, Vec } from '../geometry/vec';

export interface Glyph {
  /** Advance width in font units. */
  a: number;
  /** Strokes as flat [x0, y0, x1, y1, ...] arrays in font units (y up, baseline 0). */
  p: number[][];
}

export interface StrokeFont {
  name: string;
  license: string;
  unitsPerEm: number;
  capHeight: number;
  defaultAdvance: number;
  glyphs: Record<string, Glyph>;
}

export type FontId = 'ems-tech' | 'hershey-sans';

export const FONTS: Record<FontId, StrokeFont> = {
  'ems-tech': emsTech as StrokeFont,
  'hershey-sans': hersheySans as StrokeFont,
};

export const FONT_LABELS: Record<FontId, string> = {
  'ems-tech': 'Architect hand-lettering (EMS Tech)',
  'hershey-sans': 'Technical sans (Hershey)',
};

export interface TextStyle {
  font: StrokeFont;
  /** Cap height in output units (mm). */
  size: number;
  /** Extra letter spacing as a fraction of the cap height. */
  tracking?: number;
}

export interface PlaceOptions {
  align?: 'left' | 'center' | 'right';
  /** Visual counter-clockwise rotation in degrees, about the anchor point. */
  rotateDeg?: number;
}

const FALLBACK = '?';

function glyphFor(font: StrokeFont, ch: string): Glyph {
  return font.glyphs[ch] ?? font.glyphs[FALLBACK] ?? { a: font.defaultAdvance, p: [] };
}

interface Laid {
  strokes: number[][];
  inkMinX: number;
  inkMaxX: number;
  advance: number;
}

/** Lay out a single line in font units, returning strokes offset along x. */
function layoutLine(style: TextStyle, text: string): Laid {
  const { font } = style;
  const k = style.size / font.capHeight;
  const trackUnits = ((style.tracking ?? 0.08) * style.size) / k;
  let x = 0;
  let inkMinX = Infinity;
  let inkMaxX = -Infinity;
  const strokes: number[][] = [];
  const chars = [...text];
  chars.forEach((ch, i) => {
    const g = glyphFor(font, ch);
    for (const s of g.p) {
      const shifted = new Array<number>(s.length);
      for (let j = 0; j < s.length; j += 2) {
        const gx = s[j] + x;
        shifted[j] = gx;
        shifted[j + 1] = s[j + 1];
        if (gx < inkMinX) inkMinX = gx;
        if (gx > inkMaxX) inkMaxX = gx;
      }
      strokes.push(shifted);
    }
    x += g.a + (i < chars.length - 1 ? trackUnits : 0);
  });
  if (!isFinite(inkMinX)) {
    inkMinX = 0;
    inkMaxX = x;
  }
  return { strokes, inkMinX, inkMaxX, advance: x };
}

/** Visible (ink) width of a single line, in output units. */
export function measureText(style: TextStyle, text: string): number {
  if (!text) return 0;
  const k = style.size / style.font.capHeight;
  const l = layoutLine(style, text);
  return (l.inkMaxX - l.inkMinX) * k;
}

/**
 * Convert one line of text to polylines. (x, y) is the anchor on the baseline in a
 * y-down coordinate system (SVG / paper space).
 */
export function textPolylines(style: TextStyle, text: string, x: number, y: number, opts: PlaceOptions = {}): Polyline[] {
  if (!text) return [];
  const k = style.size / style.font.capHeight;
  const l = layoutLine(style, text);
  const inkW = l.inkMaxX - l.inkMinX;
  const align = opts.align ?? 'left';
  const startUnits = align === 'left' ? l.inkMinX : align === 'right' ? l.inkMaxX : l.inkMinX + inkW / 2;
  const rot = ((opts.rotateDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const out: Polyline[] = [];
  for (const st of l.strokes) {
    const pl: Vec[] = [];
    for (let j = 0; j < st.length; j += 2) {
      const dx = (st[j] - startUnits) * k;
      const dy = -st[j + 1] * k;
      pl.push({ x: x + dx * c + dy * s, y: y - dx * s + dy * c });
    }
    if (pl.length >= 2) out.push(pl);
  }
  return out;
}

/** Greedy word wrap to `maxWidth` (output units). Long single words are kept whole. */
export function wrapText(style: TextStyle, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (!line || measureText(style, candidate) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function lineHeight(style: TextStyle, factor = 1.65): number {
  return style.size * factor;
}
