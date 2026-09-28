import type { Vec } from '../geometry/vec';
import { LAYERS, LAYER_BY_ID, type Layer, type Stroke } from './types';

export type SvgMode = 'laser' | 'blueprint';

export interface SvgOptions {
  mode: SvgMode;
  colorMode: 'layers' | 'single';
  title?: string;
  description?: string;
  /** Faint drafting grid on the blueprint background. */
  grid?: boolean;
}

export const BLUEPRINT = {
  paper: '#1d4f8c',
  grid: '#2c62a3',
  ink: '#eef5ff',
};

const fmt = (n: number) => {
  const s = n.toFixed(3);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

function pathData(polys: Vec[][]): string {
  const parts: string[] = [];
  for (const pts of polys) {
    if (pts.length < 2) continue;
    let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}L`;
    d += pts
      .slice(1)
      .map((p) => `${fmt(p.x)} ${fmt(p.y)}`)
      .join(' ');
    parts.push(d);
  }
  return parts.join('');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Serialise strokes to SVG in millimetres (1 user unit = 1 mm). Laser mode emits
 * only stroked paths grouped by line class — no fills, text, transforms or CSS —
 * which xTool Creative Space and LightBurn import at true size.
 */
export function strokesToSvg(widthMm: number, heightMm: number, strokes: readonly Stroke[], opts: SvgOptions): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(widthMm)}mm" height="${fmt(heightMm)}mm" viewBox="0 0 ${fmt(widthMm)} ${fmt(heightMm)}">`,
  );
  if (opts.title) out.push(`<title>${esc(opts.title)}</title>`);
  if (opts.description) out.push(`<desc>${esc(opts.description)}</desc>`);

  const blueprint = opts.mode === 'blueprint';
  if (blueprint) {
    out.push(`<rect id="paper" x="0" y="0" width="${fmt(widthMm)}" height="${fmt(heightMm)}" fill="${BLUEPRINT.paper}" stroke="none"/>`);
    if (opts.grid !== false) {
      const lines: Vec[][] = [];
      for (let x = 5; x < widthMm; x += 5) lines.push([{ x, y: 0 }, { x, y: heightMm }]);
      for (let y = 5; y < heightMm; y += 5) lines.push([{ x: 0, y }, { x: widthMm, y }]);
      out.push(`<path id="grid" d="${pathData(lines)}" fill="none" stroke="${BLUEPRINT.grid}" stroke-width="0.12" opacity="0.55"/>`);
    }
  }

  const byLayer = new Map<Layer, Stroke[]>();
  for (const s of strokes) {
    const l = byLayer.get(s.layer) ?? [];
    l.push(s);
    byLayer.set(s.layer, l);
  }
  for (const info of LAYERS) {
    const list = byLayer.get(info.id);
    if (!list?.length) continue;
    const color = blueprint ? (info.id === 'cut' ? '#ff6b6b' : BLUEPRINT.ink) : opts.colorMode === 'single' && info.id !== 'cut' ? '#000000' : info.color;
    out.push(
      `<g id="${info.id}" data-layer="${esc(info.name)}" fill="none" stroke="${color}" stroke-width="${fmt(info.width)}" stroke-linecap="round" stroke-linejoin="round">`,
    );
    // Group by preview width so text sizes keep their weight.
    const byWidth = new Map<string, Vec[][]>();
    for (const s of list) {
      const w = s.w !== undefined ? fmt(s.w) : '';
      const arr = byWidth.get(w) ?? [];
      arr.push(s.pts);
      byWidth.set(w, arr);
    }
    for (const [w, polys] of byWidth) {
      for (let i = 0; i < polys.length; i += 1500) {
        const chunk = polys.slice(i, i + 1500);
        out.push(`<path d="${pathData(chunk)}"${w ? ` stroke-width="${w}"` : ''}/>`);
      }
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

export function layerColor(layer: Layer, colorMode: 'layers' | 'single'): string {
  if (colorMode === 'single' && layer !== 'cut') return '#000000';
  return LAYER_BY_ID[layer].color;
}
