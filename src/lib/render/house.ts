import { type Region, clipPolyline, region } from '../geometry/clip';
import { rectPoly } from '../geometry/vec';
import type { WorldEl } from '../model/world';
import { type RenderCtx, renderElement } from './elements';
import { hashString, mulberry32 } from './patterns';
import type { Stroke } from './types';

/**
 * Render all elements in world feet with hidden-line removal: elements are
 * processed front-to-back and each one's lines are clipped by everything in
 * front of it (plus everything below grade).
 */
export function renderHouse(els: readonly WorldEl[], ctx: Omit<RenderCtx, 'rng'>): Stroke[] {
  const occluders: Region[] = [region(rectPoly(-1e4, -1e4, 1e4, 0))];
  const out: Stroke[] = [];
  for (let i = els.length - 1; i >= 0; i--) {
    const we = els[i];
    const res = renderElement(we, { ...ctx, rng: mulberry32(hashString(we.el.id)) });
    for (const s of res.strokes) {
      for (const pts of clipPolyline(s.pts, null, occluders)) out.push({ layer: s.layer, pts });
    }
    for (const o of res.occluders) if (o.length >= 3) occluders.push(region(o));
  }
  return out;
}
