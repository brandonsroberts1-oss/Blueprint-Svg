import { describe, expect, it } from 'vitest';
import { clipPolyline, hatchLines, region } from '../src/lib/geometry/clip';
import { applyH, estimateRectAspect, homographyFromPoints, invertH } from '../src/lib/geometry/homography';
import { area, centroid, insetPolygon, minAreaRect, pointInPolygon, signedArea } from '../src/lib/geometry/polygon';
import { rectPoly, type Vec } from '../src/lib/geometry/vec';
import { formatFtIn, parseLength, pickStandardScale, mmPerFoot } from '../src/lib/units';
import { FONTS, measureText, textPolylines, wrapText } from '../src/lib/text/strokeFont';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('polygon utilities', () => {
  it('computes area, orientation and centroid', () => {
    const sq = rectPoly(0, 0, 2, 2);
    expect(signedArea(sq)).toBeGreaterThan(0);
    close(area(sq), 4);
    const c = centroid(sq);
    close(c.x, 1);
    close(c.y, 1);
  });

  it('point in concave polygon', () => {
    const L: Vec[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(pointInPolygon({ x: 0.5, y: 3 }, L)).toBe(true);
    expect(pointInPolygon({ x: 3, y: 3 }, L)).toBe(false);
    expect(pointInPolygon({ x: 3, y: 0.5 }, L)).toBe(true);
  });

  it('insets edges by individual distances', () => {
    const sq = rectPoly(0, 0, 10, 10);
    // edges: bottom, right, top, left
    const inner = insetPolygon(sq, [1, 0, 2, 0])!;
    const ys = inner.map((p) => p.y).sort((a, b) => a - b);
    close(ys[0], 1);
    close(ys[3], 8);
    const xs = inner.map((p) => p.x).sort((a, b) => a - b);
    close(xs[0], 0);
    close(xs[3], 10);
  });

  it('finds the minimum-area rectangle of a rotated box', () => {
    const a = Math.PI / 7;
    const pts = rectPoly(0, 0, 12, 5).map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
    const r = minAreaRect(pts)!;
    const dims = [r.width, r.height].sort((x, y) => x - y);
    close(dims[0], 5, 1e-6);
    close(dims[1], 12, 1e-6);
  });
});

describe('clipping', () => {
  it('keeps segment parts inside include and outside exclude', () => {
    const inc = region(rectPoly(0, 0, 10, 10));
    const exc = region(rectPoly(3, -1, 5, 11));
    const parts = clipPolyline(
      [
        { x: -5, y: 5 },
        { x: 15, y: 5 },
      ],
      [inc],
      [exc],
    );
    expect(parts).toHaveLength(2);
    close(parts[0][0].x, 0);
    close(parts[0][1].x, 3);
    close(parts[1][0].x, 5);
    close(parts[1][1].x, 10);
  });

  it('keeps continuous polylines joined', () => {
    const parts = clipPolyline(
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
      ],
      null,
      [],
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(3);
  });

  it('hatches a triangle with lines anchored to a datum', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
    ];
    const r = region(tri);
    const lines = hatchLines(r.bbox, 1, 0, { x: 0, y: 0.5 }).flatMap((l) => clipPolyline(l, [r], []));
    // y = 0.5, 1.5, 2.5, 3.5, 4.5
    expect(lines).toHaveLength(5);
    const l0 = lines.find((l) => Math.abs(l[0].y - 0.5) < 1e-9)!;
    close(Math.abs(l0[1].x - l0[0].x), 9);
  });
});

describe('homography', () => {
  it('maps the four correspondences and inverts', () => {
    const src = [
      { x: 10, y: 20 },
      { x: 200, y: 35 },
      { x: 190, y: 160 },
      { x: 20, y: 150 },
    ];
    const dst = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    const H = homographyFromPoints(src, dst)!;
    src.forEach((p, i) => {
      const q = applyH(H, p);
      close(q.x, dst[i].x, 1e-6);
      close(q.y, dst[i].y, 1e-6);
    });
    const Hi = invertH(H)!;
    const back = applyH(Hi, dst[2]);
    close(back.x, src[2].x, 1e-6);
    close(back.y, src[2].y, 1e-6);
  });

  it('recovers the aspect ratio of a rectangle photographed in perspective', () => {
    const W = 4000;
    const H = 3000;
    const f = 3200;
    // 12 m x 6 m facade, yawed 30 degrees, camera 20 m away, slightly below.
    const rw = 12;
    const rh = 6;
    const yaw = (30 * Math.PI) / 180;
    const pitch = (-6 * Math.PI) / 180;
    const corners3 = [
      [-rw / 2, -rh / 2, 0],
      [rw / 2, -rh / 2, 0],
      [rw / 2, rh / 2, 0],
      [-rw / 2, rh / 2, 0],
    ];
    const project = ([x, y, z]: number[]) => {
      // yaw about y axis, pitch about x axis, then translate.
      let X = x * Math.cos(yaw) + z * Math.sin(yaw);
      let Z = -x * Math.sin(yaw) + z * Math.cos(yaw);
      let Y = y;
      const Y2 = Y * Math.cos(pitch) - Z * Math.sin(pitch);
      const Z2 = Y * Math.sin(pitch) + Z * Math.cos(pitch);
      Y = Y2;
      Z = Z2 + 20;
      X += 1.5;
      return { x: W / 2 + (f * X) / Z, y: H / 2 + (f * Y) / Z };
    };
    // image y grows downward; rectangle top = -rh/2 in this frame
    const quad = corners3.map(project);
    const est = estimateRectAspect(quad, W, H);
    expect(est.method).toBe('perspective');
    close(est.aspect, rw / rh, 0.02);
    close(est.focal!, f, 20);
  });
});

describe('units', () => {
  it('formats feet and inches', () => {
    expect(formatFtIn(9 + 1.125 / 12, 8)).toBe(`9'-1 1/8"`);
    expect(formatFtIn(16)).toBe(`16'-0"`);
    expect(formatFtIn(6 + 8 / 12)).toBe(`6'-8"`);
    expect(formatFtIn(0.5)).toBe(`0'-6"`);
    expect(formatFtIn(11.999)).toBe(`12'-0"`);
  });

  it('parses lengths', () => {
    close(parseLength(`6'8"`)!, 6 + 8 / 12);
    close(parseLength(`16'-0"`)!, 16);
    close(parseLength(`80"`)!, 80 / 12);
    close(parseLength('80 in')!, 80 / 12);
    close(parseLength('2.4 m')!, 2400 / 304.8);
    close(parseLength(`6' 8 1/2"`)!, 6 + 8.5 / 12);
    close(parseLength('7-0')!, 7);
    close(parseLength('42.5')!, 42.5);
    expect(parseLength('abc')).toBeNull();
  });

  it('picks the largest standard scale that fits', () => {
    const s = pickStandardScale(5.5, 'imperial')!;
    expect(s.label).toBe(`3/16" = 1'-0"`);
    close(mmPerFoot(s), 304.8 / 64);
  });
});

describe('stroke fonts', () => {
  for (const font of Object.values(FONTS)) {
    it(`${font.name} renders all label characters`, () => {
      const text = `FRONT ELEVATION 1/4" = 1'-0" (TYP.) 0123456789 #&-,.:`;
      for (const ch of text) expect(font.glyphs[ch], `glyph ${ch}`).toBeDefined();
      const style = { font, size: 2.5 };
      const lines = textPolylines(style, 'HELLO', 10, 20, { align: 'left' });
      expect(lines.length).toBeGreaterThanOrEqual(5);
      const ys = lines.flat().map((p) => p.y);
      // Cap height of 2.5 mm above the baseline (y-down)
      close(Math.min(...ys), 20 - 2.5, 0.2);
      close(Math.max(...ys), 20, 0.2);
      const xs = lines.flat().map((p) => p.x);
      close(Math.min(...xs), 10, 1e-6);
      close(Math.max(...xs) - Math.min(...xs), measureText(style, 'HELLO'), 1e-6);
    });
  }

  it('wraps words to a width', () => {
    const style = { font: FONTS['ems-tech'], size: 2 };
    const lines = wrapText(style, 'STONE VENEER WITH STONE CAP AND WATERTABLE', 25);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(style, l)).toBeLessThanOrEqual(25 + 1e-6);
  });

  it('rotates text counter-clockwise', () => {
    const style = { font: FONTS['hershey-sans'], size: 3 };
    const lines = textPolylines(style, 'HH', 0, 0, { rotateDeg: 90 });
    const pts = lines.flat();
    // rotated 90° CCW: the text runs upward (negative y) and extends to the left of x = 0 for its height
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(-3);
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThanOrEqual(1e-6);
  });
});
