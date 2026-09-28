import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnalysisError, analyzePhoto } from '../server/analyze';
import { elementsFromAnalysis } from '../src/lib/model/fromAnalysis';
import type { Analysis } from '../src/lib/shared/analysisSchema';

const nulls = {
  box: null,
  polygon: null,
  material: null,
  windowStyle: null,
  grid: null,
  gridCols: null,
  gridRows: null,
  units: null,
  shutters: null,
  doorStyle: null,
  sidelights: null,
  transom: null,
  garageStyle: null,
  garageSections: null,
  garageWindows: null,
  ventShape: null,
  columnStyle: null,
};

const sample: Analysis = {
  houseFound: true,
  groundY: 900,
  stories: 2,
  architecturalStyle: 'Craftsman',
  notes: 'Tree hides the left corner.',
  elements: [
    { ...nulls, kind: 'window', description: 'upper window', box: { x0: 200, y0: 300, x1: 280, y1: 420 }, windowStyle: 'double-hung', grid: 'top', gridCols: 3, gridRows: 2 },
    { ...nulls, kind: 'wall', description: 'main wall', polygon: [{ x: 100, y: 900 }, { x: 900, y: 900 }, { x: 900, y: 250 }, { x: 100, y: 250 }], material: 'lap' },
    { ...nulls, kind: 'roof', description: 'main roof', polygon: [{ x: 80, y: 250 }, { x: 920, y: 250 }, { x: 800, y: 100 }, { x: 200, y: 100 }], material: 'brick' },
    { ...nulls, kind: 'garage', description: 'garage', box: { x0: 550, y0: 700, x1: 850, y1: 900 }, garageStyle: 'carriage', garageSections: 20 },
    { ...nulls, kind: 'column', description: 'post', polygon: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 11, y: 11 }] },
    { ...nulls, kind: 'door', description: 'no geometry' },
  ],
};

describe('elementsFromAnalysis', () => {
  it('scales, validates and orders detected elements', () => {
    const r = elementsFromAnalysis(sample, 2, 2, 2000, 2000);
    expect(r.skipped).toBe(2); // tiny column + door without geometry
    expect(r.elements.map((e) => e.kind)).toEqual(['wall', 'roof', 'window', 'garage']);
    const wall = r.elements[0];
    expect(wall.kind === 'wall' && wall.points[1]).toEqual({ x: 1800, y: 1800 });
    const roof = r.elements[1];
    expect(roof.kind === 'roof' && roof.material).toBe('shingle'); // invalid roof material falls back
    const win = r.elements[2];
    expect(win.kind === 'window' && [win.x, win.y, win.w, win.h, win.gridCols, win.grid]).toEqual([400, 600, 160, 240, 3, 'top']);
    const garage = r.elements[3];
    expect(garage.kind === 'garage' && [garage.style, garage.sections]).toEqual(['carriage', 8]);
    expect(r.groundY).toBe(1800);
    expect(r.stories).toBe(2);
  });
});

describe('analyzePhoto', () => {
  const image = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');

  it('requests structured output with fallbacks and returns the parsed tracing', async () => {
    const parse = vi.fn(async (_params: unknown) => ({ stop_reason: 'end_turn', parsed_output: sample, model: 'claude-opus-5' }));
    const client = { beta: { messages: { parse } } } as unknown as Anthropic;
    const res = await analyzePhoto({ image, width: 1000, height: 1000 }, client);
    expect(res.analysis.elements).toHaveLength(6);
    const params = parse.mock.calls[0][0] as { model: string; fallbacks: string; betas: string[]; output_config: { format: unknown }; messages: { content: { type: string }[] }[] };
    expect(params.model).toBe('claude-opus-5');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toContain('server-side-fallback-2026-07-01');
    expect(params.output_config.format).toBeTruthy();
    expect(params.messages[0].content.map((c) => c.type)).toEqual(['image', 'text']);
  });

  it('reports refusals and bad input', async () => {
    const client = { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) } } } as unknown as Anthropic;
    await expect(analyzePhoto({ image, width: 10, height: 10 }, client)).rejects.toMatchObject({ status: 422 });
    await expect(analyzePhoto({ image: 'nope', width: 10, height: 10 }, client)).rejects.toBeInstanceOf(AnalysisError);
  });
});
