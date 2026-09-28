import { edgeMapForPhoto, snapBox } from '../lib/image/edges';
import type { HouseElement, Project } from '../lib/model/types';
import { isRectElement } from '../lib/model/types';

const SKIP = new Set(['railing', 'light']);

/** Snap the sides of box elements (all, or just `ids`) to the strongest nearby photo edges. */
export async function snapElementsToPhoto(project: Project, ids?: string[]): Promise<{ elements: HouseElement[]; moved: number }> {
  if (!project.photo) return { elements: project.elements, moved: 0 };
  const map = await edgeMapForPhoto(project.photo.dataUrl);
  let moved = 0;
  const elements = project.elements.map((e) => {
    if (!isRectElement(e) || SKIP.has(e.kind) || e.hidden || (ids && !ids.includes(e.id))) return e;
    const b = snapBox(map, { x: e.x, y: e.y, w: e.w, h: e.h });
    if (Math.abs(b.x - e.x) + Math.abs(b.y - e.y) + Math.abs(b.w - e.w) + Math.abs(b.h - e.h) < 0.5) return e;
    moved++;
    return { ...e, ...b };
  });
  return { elements, moved };
}
