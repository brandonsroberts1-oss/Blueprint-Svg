import type { Project } from '../model/types';
import { resolveScale, toWorldElements, worldToPx, type WorldFrame } from '../model/world';
import { renderHouse } from './house';

/** Blueprint linework of the house mapped back onto the rectified photo (SVG path data in photo pixels). */
export function houseLinesInImage(project: Project): string {
  const scale = resolveScale(project);
  const frame: WorldFrame = { pxPerFtX: scale.pxPerFtX, pxPerFtY: scale.pxPerFtY, groundY: project.groundY };
  const els = toWorldElements(project.elements, frame);
  if (!els.length) return '';
  const strokes = renderHouse(els, {
    // Treat one photo pixel as the output unit so hatch thinning keeps lines >= 3 px apart.
    mmPerFt: frame.pxPerFtY,
    minHatchMm: 3,
    detail: project.layout.detail,
    courseAnchorY: 8 / 12,
  });
  const parts: string[] = [];
  for (const s of strokes) {
    const pts = s.pts.map((p) => worldToPx(frame, p));
    parts.push(`M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}`);
  }
  return parts.join('');
}
