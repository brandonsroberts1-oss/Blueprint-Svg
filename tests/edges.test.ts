import { describe, expect, it } from 'vitest';
import { edgeMapFromGray, snapBox } from '../src/lib/image/edges';

function synthetic(w: number, h: number, rect: { x0: number; y0: number; x1: number; y1: number }) {
  const g = new Float32Array(w * h).fill(40);
  for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) g[y * w + x] = 220;
  return g;
}

describe('snapBox', () => {
  it('moves each side of a box onto the nearby photo edge', () => {
    const map = edgeMapFromGray(synthetic(200, 160, { x0: 50, y0: 40, x1: 130, y1: 120 }), 200, 160);
    const snapped = snapBox(map, { x: 46, y: 44, w: 88, h: 73 });
    expect(Math.abs(snapped.x - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapped.x + snapped.w - 130)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapped.y - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(snapped.y + snapped.h - 120)).toBeLessThanOrEqual(1);
  });

  it('works through a downscaled map and leaves boxes alone on flat areas', () => {
    const map = edgeMapFromGray(synthetic(100, 80, { x0: 25, y0: 20, x1: 65, y1: 60 }), 100, 80, 0.5);
    const snapped = snapBox(map, { x: 46, y: 44, w: 88, h: 73 });
    expect(Math.abs(snapped.x - 50)).toBeLessThanOrEqual(2);
    expect(Math.abs(snapped.y + snapped.h - 120)).toBeLessThanOrEqual(2);
    const flat = edgeMapFromGray(new Float32Array(100 * 80).fill(90), 100, 80);
    expect(snapBox(flat, { x: 20, y: 20, w: 30, h: 30 })).toEqual({ x: 20, y: 20, w: 30, h: 30 });
  });
});
