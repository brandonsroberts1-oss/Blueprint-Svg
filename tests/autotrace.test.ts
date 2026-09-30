import { describe, expect, it } from 'vitest';
import { type Detection, decodeYolo, nms } from '../src/lib/autotrace/decode';
import { parseHouse } from '../src/lib/autotrace/house';
import { closeMask, columnProfile, components, douglasPeucker, fillHoles, maskWhere, morph } from '../src/lib/autotrace/mask';
import { ADE } from '../src/lib/autotrace/models';
import { inputSize, letterbox } from '../src/lib/autotrace/raster';
import { elementsFromAnalysis } from '../src/lib/model/fromAnalysis';

describe('model output decoding', () => {
  it('maps YOLO boxes back through the letterbox and suppresses duplicates', () => {
    const photo = { width: 400, height: 200, data: new Uint8ClampedArray(400 * 200 * 4) };
    const { box } = letterbox(photo, 100);
    expect(box.scale).toBeCloseTo(0.25);
    expect(box.padY).toBe(25);
    // Two anchors on the same window (one weaker) and one on a door.
    const n = 3;
    const labels = ['window', 'door'];
    const out = new Float32Array((4 + labels.length) * n);
    const put = (i: number, cx: number, cy: number, w: number, h: number, sw: number, sd: number) => {
      out[i] = cx;
      out[n + i] = cy;
      out[2 * n + i] = w;
      out[3 * n + i] = h;
      out[4 * n + i] = sw;
      out[5 * n + i] = sd;
    };
    put(0, 50, 50, 10, 20, 0.9, 0.05);
    put(1, 51, 50, 10, 20, 0.6, 0.05);
    put(2, 20, 60, 8, 16, 0.02, 0.7);
    const dets = decodeYolo(out, [1, 4 + labels.length, n], labels, box, { conf: 0.3 });
    expect(dets).toHaveLength(2);
    const win = dets.find((d) => d.label === 'window')!;
    expect(win.x0).toBeCloseTo((45 - 0) / 0.25);
    expect(win.y0).toBeCloseTo((40 - 25) / 0.25);
    expect(win.score).toBeCloseTo(0.9);
  });

  it('gives a wide house a wide model input of about the same area', () => {
    const wide = inputSize(800, { w: 1200, h: 300 });
    expect(wide.w % 32).toBe(0);
    expect(wide.h % 32).toBe(0);
    expect(wide.w / wide.h).toBeGreaterThan(3);
    expect(Math.abs(wide.w * wide.h - 800 * 800) / (800 * 800)).toBeLessThan(0.15);
    // A small crop is not blown up more than twice.
    const small = inputSize(800, { w: 200, h: 100 });
    expect(small.w).toBeLessThanOrEqual(2 * 200 + 32);
    const { box } = letterbox({ width: 1200, height: 300, data: new Uint8ClampedArray(1200 * 300 * 4) }, wide);
    expect(box.w).toBe(wide.w);
    expect(box.h).toBe(wide.h);
    expect(box.padX + box.padY).toBeLessThan(32);
  });

  it('keeps separate labels apart unless asked to be agnostic', () => {
    const a: Detection = { x0: 0, y0: 0, x1: 10, y1: 10, score: 0.9, label: 'window' };
    const b: Detection = { ...a, score: 0.8, label: 'door' };
    expect(nms([a, b])).toHaveLength(2);
    expect(nms([a, b], 0.5, true)).toHaveLength(1);
  });
});

describe('mask tools', () => {
  it('dilates, erodes, labels, fills holes and profiles columns', () => {
    const m = maskWhere(10, 10, (i) => {
      const x = i % 10;
      const y = Math.floor(i / 10);
      return x >= 2 && x <= 7 && y >= 3 && y <= 8 && !(x === 4 && y === 5);
    });
    expect(fillHoles(m).data[5 * 10 + 4]).toBe(1);
    expect(morph(m, 1).data[2 * 10 + 1]).toBe(1);
    expect(morph(m, -1).data[3 * 10 + 2]).toBe(0);
    expect(closeMask(m, 1).data[5 * 10 + 4]).toBe(1);
    const two = maskWhere(10, 1, (i) => i < 3 || i > 6);
    expect(components(two).comps).toHaveLength(2);
    const { top, bottom } = columnProfile(m);
    expect(top[5]).toBe(3);
    expect(bottom[5]).toBe(9);
    expect(isNaN(top[0])).toBe(true);
  });

  it('simplifies a staircase line to its corners', () => {
    const pts = Array.from({ length: 21 }, (_, x) => ({ x, y: x <= 10 ? 0 : 5 }));
    const s = douglasPeucker(pts, 0.5);
    expect(s.length).toBeLessThanOrEqual(4);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 20, y: 5 });
  });
});

/**
 * A synthetic "photo" 320×200: sky, a dark hip roof over a light wall, a window,
 * a garage door and ground — plus the matching class map.
 */
function syntheticHouse(opts: { roof?: number[]; wall?: number[]; gutter?: boolean } = {}) {
  const W = 320;
  const H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  const cls = new Uint8Array(W * H);
  const roofTop = (x: number) => (x < 60 || x > 260 ? Infinity : Math.max(40, 100 - Math.min(x - 60, 260 - x)));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let rgb = [120, 170, 235];
      let c: number = ADE.sky;
      if (y >= 170) {
        rgb = [110, 140, 70];
        c = ADE.grass;
      } else if (x >= 70 && x <= 250 && y >= 100) {
        rgb = opts.gutter && y < 103 ? [25, 25, 28] : (opts.wall ?? [225, 220, 205]);
        c = ADE.house;
      } else if (y >= roofTop(x) && y < 100) {
        rgb = opts.roof ?? [70, 70, 75];
        c = ADE.house;
      }
      data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
      cls[i] = c;
    }
  // Window and garage door drawn into the photo.
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: number[]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([rgb[0], rgb[1], rgb[2], 255], (y * W + x) * 4);
  };
  fill(90, 115, 120, 145, [40, 50, 60]);
  fill(160, 120, 235, 170, [240, 240, 240]);
  const detections: Detection[] = [
    { x0: 90, y0: 115, x1: 120, y1: 145, score: 0.8, label: 'window' },
    { x0: 160, y0: 120, x1: 235, y1: 170, score: 0.7, label: 'garage' },
  ];
  return { photo: { width: W, height: H, data }, seg: { w: W, h: H, cls, scale: 1 }, detections };
}

describe('house parsing', () => {
  it('turns a segmented photo and detections into walls, a roof and openings', () => {
    const { photo, seg, detections } = syntheticHouse();
    const { analysis } = parseHouse({ photo, seg, detections });
    expect(analysis.houseFound).toBe(true);
    expect(analysis.groundY).toBeGreaterThan(165);
    expect(analysis.groundY).toBeLessThan(175);
    const kinds = analysis.elements.map((e) => e.kind);
    expect(kinds).toContain('wall');
    expect(kinds).toContain('roof');
    expect(kinds).toContain('window');
    expect(kinds).toContain('garage');
    // The roof sits above the wall and the eave is near y = 100.
    const roof = analysis.elements.find((e) => e.kind === 'roof')!;
    const ys = roof.polygon!.map((p) => p.y);
    expect(Math.min(...ys)).toBeLessThan(60);
    expect(Math.max(...ys)).toBeGreaterThan(92);
    expect(Math.max(...ys)).toBeLessThan(108);
    const wall = analysis.elements.find((e) => e.kind === 'wall')!;
    const wx = wall.polygon!.map((p) => p.x);
    expect(Math.min(...wx)).toBeLessThan(80);
    expect(Math.max(...wx)).toBeGreaterThan(240);
    // And the result converts into editable project elements.
    const t = elementsFromAnalysis(analysis, 1, 1, photo.width, photo.height);
    expect(t.elements.length).toBe(analysis.elements.length);
  });

  it('finds the eave from the gutter line when roof and wall are nearly the same colour', () => {
    // A dark roof over dark brick in shade: colour can't separate them, the gutter's shadow line can.
    const { photo, seg, detections } = syntheticHouse({ roof: [70, 70, 75], wall: [78, 72, 74], gutter: true });
    const { analysis } = parseHouse({ photo, seg, detections });
    const roof = analysis.elements.find((e) => e.kind === 'roof');
    expect(roof).toBeTruthy();
    const ys = roof!.polygon!.map((p) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(94);
    expect(Math.max(...ys)).toBeLessThan(106);
  });

  it('calls a door-shaped "window" standing on the ground a door', () => {
    const { photo, seg, detections } = syntheticHouse();
    const withDoor = [...detections, { x0: 130, y0: 125, x1: 150, y1: 169, score: 0.3, label: 'window' }];
    const { analysis } = parseHouse({ photo, seg, detections: withDoor });
    const door = analysis.elements.find((e) => e.kind === 'door');
    expect(door).toBeTruthy();
    expect(door!.box!.x0).toBeCloseTo(130);
  });

  it('reports no house when the class map has none', () => {
    const { photo, seg } = syntheticHouse();
    const empty = { ...seg, cls: new Uint8Array(seg.cls.length).fill(ADE.sky) };
    const { analysis } = parseHouse({ photo, seg: empty, detections: [] });
    expect(analysis.houseFound).toBe(false);
    expect(analysis.elements).toHaveLength(0);
  });
});
