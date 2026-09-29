import { describe, expect, it } from 'vitest';
import type { Vec } from '../src/lib/geometry/vec';
import { demoProject } from '../src/lib/model/demo';
import { createElement, defaultProject } from '../src/lib/model/defaults';
import { hasPhotoWork, withoutPhoto } from '../src/lib/model/photo';
import type { Project } from '../src/lib/model/types';
import { optimizeStrokes } from '../src/lib/render/optimize';
import { buildSheet } from '../src/lib/render/sheet';
import { strokesToSvg } from '../src/lib/render/svg';
import type { Stroke } from '../src/lib/render/types';
import { mmPerFoot } from '../src/lib/units';
import { migrate } from '../src/state/store';

function withLayout(p: Project, patch: Partial<Project['layout']>): Project {
  return { ...p, layout: { ...p.layout, ...patch } };
}

describe('sheet composition', () => {
  it('fits the demo house at a standard architectural scale', () => {
    const sheet = buildSheet(demoProject());
    expect(sheet.scale?.label).toBe(`1/8" = 1'-0"`);
    expect(sheet.mmPerFt).toBeCloseTo(304.8 / 96);
    // The house is 47 ft wall-to-wall in the demo.
    expect(sheet.houseWidthFt).toBeCloseTo(47, 1);
    expect(sheet.warnings).toEqual([]);
    expect(sheet.callouts.filter((c) => c.placed).length).toBeGreaterThan(10);
    // Everything stays on the sheet.
    for (const s of sheet.strokes) {
      if (s.layer === 'cut') continue;
      for (const p of s.pts) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(sheet.widthMm + 1e-6);
        expect(p.y).toBeLessThanOrEqual(sheet.heightMm + 1e-6);
      }
    }
  });

  it('keeps world distances exact on paper', () => {
    const sheet = buildSheet(demoProject());
    const a = sheet.toPaper({ x: 0, y: 0 });
    const b = sheet.toPaper({ x: 16, y: 0 });
    expect(b.x - a.x).toBeCloseTo(16 * sheet.mmPerFt, 6);
    const back = sheet.fromPaper(b);
    expect(back.x).toBeCloseTo(16, 6);
    expect(back.y).toBeCloseTo(0, 6);
  });

  it('picks a larger scale on a larger board and honours a fixed scale', () => {
    const big = buildSheet(withLayout(demoProject(), { paperWidthMm: 609.6, paperHeightMm: 457.2 }));
    expect(big.mmPerFt).toBeGreaterThan(304.8 / 96);
    const fixed = buildSheet(withLayout(demoProject(), { scaleId: '1/16in' }));
    expect(fixed.mmPerFt).toBeCloseTo(mmPerFoot({ id: '1/16in', label: '', ratio: 192, system: 'imperial' }));
    const tooBig = buildSheet(withLayout(demoProject(), { scaleId: '1/2in' }));
    expect(tooBig.warnings.some((w) => w.includes('larger than the space'))).toBe(true);
  });

  it('supports metric scales and the fill-the-board option', () => {
    const metric = buildSheet(withLayout(demoProject(), { scaleSystem: 'metric' }));
    expect(metric.scale?.label).toMatch(/^1:\d+$/);
    const fit = buildSheet(withLayout(demoProject(), { scaleId: 'fit' }));
    expect(fit.mmPerFt).toBeGreaterThanOrEqual(metric.mmPerFt * 0.99);
  });

  it('renders small boards (xTool F1) without errors', () => {
    const sheet = buildSheet(withLayout(demoProject(), { paperWidthMm: 115, paperHeightMm: 115, marginMm: 3 }));
    expect(sheet.strokes.length).toBeGreaterThan(100);
  });

  it('handles an empty project', () => {
    const sheet = buildSheet(defaultProject());
    expect(sheet.houseWidthFt).toBeNull();
    expect(sheet.strokes.length).toBeGreaterThan(0); // title block
  });

  it('applies callout overrides and custom notes', () => {
    const p = demoProject();
    p.calloutOverrides = { 'roof:shingle': { text: 'CUSTOM ROOF NOTE' }, 'roof:metal': { enabled: false } };
    p.customCallouts = [{ id: 'n1', text: 'CEDAR PORCH CEILING', anchor: { x: 700, y: 620 }, side: 'left' }];
    const sheet = buildSheet(p);
    expect(sheet.callouts.find((c) => c.key === 'roof:shingle')?.text).toBe('CUSTOM ROOF NOTE');
    expect(sheet.callouts.find((c) => c.key === 'roof:metal')?.placed).toBe(false);
    const note = sheet.callouts.find((c) => c.key === 'custom:n1');
    expect(note?.placed).toBe(true);
    expect(note?.side).toBe('left');
  });

  it('draws no roof-pitch symbols over the roof', () => {
    const sheet = buildSheet(demoProject());
    const flat = (a: Vec, b: Vec) => Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 1e-6;
    const plumb = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) > 1e-6;
    // The old symbol was a closed right triangle (run 12, rise N) in the annotation layer.
    const triangles = sheet.strokes.filter((s) => {
      const p = s.pts;
      if (s.layer !== 'annotation' || p.length !== 4 || Math.hypot(p[0].x - p[3].x, p[0].y - p[3].y) > 1e-6) return false;
      const edges = [0, 1, 2].map((i) => [p[i], p[i + 1]] as const);
      return edges.some(([a, b]) => flat(a, b)) && edges.some(([a, b]) => plumb(a, b));
    });
    expect(triangles).toHaveLength(0);
    // Projects saved while the option existed load without it.
    const old = demoProject();
    const loaded = migrate({ ...old, annotations: { ...old.annotations, showPitch: true } as Project['annotations'] });
    expect('showPitch' in loaded.annotations).toBe(false);
  });

  it('hides lines behind elements in front (hidden-line removal)', () => {
    const p = defaultProject();
    p.groundY = 500;
    p.calibration = { mode: 'measure', measure: { a: { x: 0, y: 500 }, b: { x: 200, y: 500 }, lengthFt: 10 }, facadeWidthFt: null };
    const wall = createElement('wall', [{ x: 0, y: 500 }, { x: 400, y: 500 }, { x: 400, y: 200 }, { x: 0, y: 200 }]);
    const win = createElement('window', { x: 150, y: 250, w: 100, h: 150 });
    p.elements = [wall, win];
    const sheet = buildSheet(withLayout(p, { frame: 'none' }));
    const w0 = sheet.toPaper({ x: 150 / 20 + 0.3, y: 0 }).x;
    const w1 = sheet.toPaper({ x: 250 / 20 - 0.3, y: 0 }).x;
    const top = sheet.toPaper({ x: 0, y: (500 - 250) / 20 - 0.3 }).y;
    const bottom = sheet.toPaper({ x: 0, y: (500 - 400) / 20 + 0.3 }).y;
    // No siding (hatch layer, horizontal) should cross the window interior.
    const crossing = sheet.strokes.filter(
      (s) => s.layer === 'hatch' && s.pts.some((q, i) => i > 0 && Math.abs(q.y - s.pts[i - 1].y) < 1e-6 && q.y > top && q.y < bottom && Math.min(q.x, s.pts[i - 1].x) < w1 && Math.max(q.x, s.pts[i - 1].x) > w0 && Math.abs(q.x - s.pts[i - 1].x) > (w1 - w0) * 0.9),
    );
    expect(crossing).toHaveLength(0);
  });
});

describe('changing the photo', () => {
  it('clears the photo and its tracing but keeps the address, notes wording and sheet settings', () => {
    const p = demoProject();
    p.customCallouts = [{ id: 'n1', text: 'CEDAR PORCH CEILING', anchor: { x: 700, y: 620 }, side: 'left' }];
    p.calibration = { ...p.calibration, mode: 'measure', measure: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, lengthFt: 16 } };
    expect(hasPhotoWork(p)).toBe(true);
    const q = withoutPhoto(p);
    expect(q.photo).toBeNull();
    expect(q.straighten).toBeNull();
    expect(q.elements).toEqual([]);
    expect(q.customCallouts).toEqual([]);
    expect(q.calibration.measure).toBeNull();
    expect(q.calibration.mode).toBe('auto');
    expect(hasPhotoWork(q)).toBe(false);
    expect(q.property).toEqual(p.property);
    expect(q.annotations).toEqual(p.annotations);
    expect(q.layout).toEqual(p.layout);
    expect(q.calloutOverrides).toEqual(p.calloutOverrides);
    expect(hasPhotoWork(defaultProject())).toBe(false);
  });
});

describe('laser SVG', () => {
  it('uses millimetre units, stroked paths and colour groups only', () => {
    const sheet = buildSheet(withLayout(demoProject(), { cutOutline: 'rounded' }));
    const svg = strokesToSvg(sheet.widthMm, sheet.heightMm, sheet.strokes, { mode: 'laser', colorMode: 'layers', title: 'Test & <title>' });
    expect(svg).toContain('width="300mm" height="200mm" viewBox="0 0 300 200"');
    expect(svg).not.toMatch(/<text|<image|<style|transform=|<use|fill="#/);
    for (const id of ['outline', 'detail', 'hatch', 'annotation', 'text', 'cut']) expect(svg).toContain(`<g id="${id}"`);
    expect(svg).toContain('stroke="#FF0000"');
    expect(svg).toContain('<title>Test &amp; &lt;title&gt;</title>');
    const single = strokesToSvg(sheet.widthMm, sheet.heightMm, sheet.strokes, { mode: 'laser', colorMode: 'single' });
    expect(single).not.toContain('stroke="#0000FF"');
    expect(single).toContain('stroke="#FF0000"'); // cut stays red
  });
});

describe('stroke optimisation', () => {
  it('removes overlaps so nothing is burned twice, keeping the heavier line', () => {
    const strokes: Stroke[] = [
      { layer: 'hatch', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { layer: 'outline', pts: [{ x: 5, y: 0 }, { x: 15, y: 0 }] },
      { layer: 'detail', pts: [{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 10 }] },
      { layer: 'detail', pts: [{ x: 10, y: 10 }, { x: 0, y: 10 }] },
    ];
    const out = optimizeStrokes(strokes);
    const len = (layer: string) =>
      out.filter((s) => s.layer === layer).reduce((a, s) => a + s.pts.slice(1).reduce((b, p, i) => b + Math.hypot(p.x - s.pts[i].x, p.y - s.pts[i].y), 0), 0);
    expect(len('outline')).toBeCloseTo(10);
    expect(len('hatch')).toBeCloseTo(5);
    // The two detail pieces share an endpoint and are chained into one polyline.
    expect(out.filter((s) => s.layer === 'detail')).toHaveLength(1);
  });
});
