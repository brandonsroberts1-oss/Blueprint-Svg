import { houseLinesInImage } from '../render/overlay';
import { DEMO_CANVAS, demoProject } from './demo';
import type { Project } from './types';

/** The demo project with a generated "photo" (a pencil sketch of the house) to trace over. */
export function demoWithSketch(): Project {
  const p = demoProject();
  const { width, height } = DEMO_CANVAS;
  const d = houseLinesInImage(p);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe9f3"/><stop offset="1" stop-color="#f4f1ea"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#sky)"/>
<rect y="${p.groundY}" width="${width}" height="${height - p.groundY}" fill="#b9c7a4"/>
<path d="${d}" fill="none" stroke="#5b6572" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  p.photo = { dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height };
  return p;
}
