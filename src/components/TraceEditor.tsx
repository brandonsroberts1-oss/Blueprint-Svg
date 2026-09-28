import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Vec } from '../lib/geometry/vec';
import { KIND_INFO, createElement, insertElement, newId, TOOL_ORDER } from '../lib/model/defaults';
import { roofMaterialHint, wallMaterialHint } from '../lib/model/facts';
import type { HouseElement, Project } from '../lib/model/types';
import { isPolyElement } from '../lib/model/types';
import { houseLinesInImage } from '../lib/render/overlay';
import { formatFtIn } from '../lib/units';
import { useStore } from '../state/store';
import { type Tool, useUI } from '../state/ui';
import { Viewport } from './Viewport';

type Draft =
  | { type: 'rect'; kind: HouseElement['kind']; a: Vec; b: Vec }
  | { type: 'poly'; kind: HouseElement['kind']; pts: Vec[]; cursor: Vec | null }
  | { type: 'measure'; a: Vec; b: Vec };

type Drag =
  | { type: 'move'; id: string; start: Vec; orig: HouseElement; key: string }
  | { type: 'resize'; id: string; handle: string; start: Vec; orig: HouseElement; key: string }
  | { type: 'vertex'; id: string; index: number; key: string }
  | { type: 'ground'; key: string }
  | { type: 'measure-end'; end: 'a' | 'b'; key: string };

export const HOTKEYS: Record<string, Tool> = {
  v: 'select',
  w: 'wall',
  r: 'roof',
  g: 'gable',
  n: 'window',
  d: 'door',
  a: 'garage',
  e: 'vent',
  c: 'column',
  l: 'railing',
  s: 'steps',
  t: 'trim',
  h: 'chimney',
  i: 'light',
  b: 'ground',
  m: 'measure',
};

function moveElement(e: HouseElement, dx: number, dy: number): HouseElement {
  if (isPolyElement(e)) return { ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...e, x: e.x + dx, y: e.y + dy };
}

function resizeRect(e: HouseElement, handle: string, p: Vec): HouseElement {
  if (isPolyElement(e)) return e;
  let x0 = e.x;
  let y0 = e.y;
  let x1 = e.x + e.w;
  let y1 = e.y + e.h;
  if (handle.includes('w')) x0 = p.x;
  if (handle.includes('e')) x1 = p.x;
  if (handle.includes('n')) y0 = p.y;
  if (handle.includes('s')) y1 = p.y;
  return { ...e, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
}

function snapPoints(project: Project, excludeId?: string): Vec[] {
  const out: Vec[] = [];
  for (const e of project.elements) {
    if (e.id === excludeId || e.hidden) continue;
    if (isPolyElement(e)) out.push(...e.points);
    else out.push({ x: e.x, y: e.y }, { x: e.x + e.w, y: e.y }, { x: e.x, y: e.y + e.h }, { x: e.x + e.w, y: e.y + e.h });
  }
  return out;
}

export function TraceEditor() {
  const { project, update } = useStore();
  const { tool, setTool, selectedId, setSelectedId, notify } = useUI();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showLines, setShowLines] = useState(true);
  const [photoOpacity, setPhotoOpacity] = useState(1);
  const [fillShapes, setFillShapes] = useState(true);
  const drag = useRef<Drag | null>(null);
  const scaleRef = useRef(1);
  const deferred = useDeferredValue(project);
  const linesD = useMemo(() => (showLines ? houseLinesInImage(deferred) : ''), [deferred, showLines]);
  const photo = project.photo;

  const hints = useMemo(
    () => ({ wall: wallMaterialHint(project.property.hints.exterior), roof: roofMaterialHint(project.property.hints.roof) }),
    [project.property.hints],
  );

  const snap = useCallback(
    (p: Vec, opts: { from?: Vec; shift?: boolean; excludeId?: string } = {}): Vec => {
      const tol = 9 / scaleRef.current;
      let q = { ...p };
      if (opts.shift && opts.from) {
        const dx = q.x - opts.from.x;
        const dy = q.y - opts.from.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        q = { x: opts.from.x + Math.cos(ang) * len, y: opts.from.y + Math.sin(ang) * len };
      }
      let best: Vec | null = null;
      let bd = tol;
      for (const s of snapPoints(project, opts.excludeId)) {
        const d = Math.hypot(s.x - q.x, s.y - q.y);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (best) return { ...best };
      if (Math.abs(q.y - project.groundY) < tol) q.y = project.groundY;
      return q;
    },
    [project],
  );

  const finishPoly = useCallback(
    (d: Extract<Draft, { type: 'poly' }>) => {
      const pts = d.pts.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1.5 / scaleRef.current);
      if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 2 / scaleRef.current) pts.pop();
      setDraft(null);
      if (pts.length < 3) {
        notify('A shape needs at least three corners.', 'error');
        return;
      }
      const el = createElement(d.kind, pts, hints);
      update((p) => ({ ...p, elements: insertElement(p.elements, el) }));
      setSelectedId(el.id);
    },
    [update, setSelectedId, notify, hints],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    update((p) => ({ ...p, elements: p.elements.filter((e) => e.id !== selectedId) }));
    setSelectedId(null);
  }, [selectedId, update, setSelectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = e.key.toLowerCase();
      if (draft?.type === 'poly') {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishPoly(draft);
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          setDraft({ ...draft, pts: draft.pts.slice(0, -1) });
          return;
        }
      }
      if (e.key === 'Escape') {
        if (draft) setDraft(null);
        else if (selectedId) setSelectedId(null);
        else setTool('select');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === 'd' && selectedId) {
        e.preventDefault();
        const el = project.elements.find((x) => x.id === selectedId);
        if (!el) return;
        const off = 16 / scaleRef.current;
        const copy = { ...moveElement(el, off, 0), id: newId(el.kind) };
        update((p) => {
          const i = p.elements.findIndex((x) => x.id === selectedId);
          const els = [...p.elements];
          els.splice(i + 1, 0, copy);
          return { ...p, elements: els };
        });
        setSelectedId(copy.id);
        return;
      }
      if (e.key.startsWith('Arrow') && selectedId) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        update((p) => ({ ...p, elements: p.elements.map((x) => (x.id === selectedId ? moveElement(x, dx, dy) : x)) }), { mergeKey: `nudge-${selectedId}` });
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && HOTKEYS[k]) {
        setDraft(null);
        setTool(HOTKEYS[k]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, selectedId, project.elements, finishPoly, deleteSelected, setSelectedId, setTool, update]);

  useEffect(() => {
    if (draft && draft.type !== 'measure' && draft.kind !== tool) setDraft(null);
  }, [tool, draft]);

  if (!photo) return <div className="empty">Add and straighten a photo first.</div>;
  const W = photo.width;
  const H = photo.height;
  const selected = project.elements.find((e) => e.id === selectedId) ?? null;
  const drawingKind = tool !== 'select' && tool !== 'ground' && tool !== 'measure' ? tool : null;
  const measure = project.calibration.measure;

  const cursor = tool === 'select' ? 'default' : 'crosshair';

  return (
    <div className="trace-wrap">
      <div className="float-bar">
        <label title="Show the generated blueprint lines over the photo">
          <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} /> Blueprint lines
        </label>
        <label title="Tint traced shapes">
          <input type="checkbox" checked={fillShapes} onChange={(e) => setFillShapes(e.target.checked)} /> Shape tint
        </label>
        <label className="range">
          Photo
          <input type="range" min={0} max={1} step={0.05} value={photoOpacity} onChange={(e) => setPhotoOpacity(parseFloat(e.target.value))} />
        </label>
      </div>
      {drawingKind && (
        <div className="draw-hint">
          {draft?.type === 'poly'
            ? 'Click to add corners · Shift = straight lines · Enter or click the first corner to finish · Backspace removes the last corner · Esc cancels'
            : KIND_INFO[drawingKind].hint}
        </div>
      )}
      {tool === 'ground' && <div className="draw-hint">Click where the ground meets the front wall to set the finish-grade line.</div>}
      {tool === 'measure' && <div className="draw-hint">Drag along something whose real length you know (e.g. the garage door width), then enter the length in the Scale panel.</div>}
      <Viewport width={W} height={H} cursor={cursor}>
        {({ view, toImage }) => {
          scaleRef.current = view.s;
          const px = (n: number) => n / view.s;
          const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
            if (e.button !== 0) return;
            const p = toImage(e.clientX, e.clientY);
            const svg = e.currentTarget;
            if (tool === 'ground') {
              update((pr) => ({ ...pr, groundY: p.y }));
              return;
            }
            if (tool === 'measure') {
              svg.setPointerCapture(e.pointerId);
              setDraft({ type: 'measure', a: snap(p), b: snap(p) });
              return;
            }
            if (drawingKind) {
              const info = KIND_INFO[drawingKind];
              if (info.shape === 'rect') {
                svg.setPointerCapture(e.pointerId);
                const q = snap(p);
                setDraft({ type: 'rect', kind: drawingKind, a: q, b: q });
              } else {
                const prev = draft?.type === 'poly' ? draft : null;
                const q = snap(p, { from: prev?.pts[prev.pts.length - 1], shift: e.shiftKey });
                if (prev && prev.pts.length >= 3 && Math.hypot(q.x - prev.pts[0].x, q.y - prev.pts[0].y) < 10 / view.s) {
                  finishPoly(prev);
                  return;
                }
                setDraft({ type: 'poly', kind: drawingKind, pts: [...(prev?.pts ?? []), q], cursor: q });
              }
              return;
            }
            // Select tool on empty space.
            setSelectedId(null);
          };
          const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
            const p = toImage(e.clientX, e.clientY);
            const d = drag.current;
            if (d) {
              if (d.type === 'move') {
                const dx = p.x - d.start.x;
                const dy = p.y - d.start.y;
                update((pr) => ({ ...pr, elements: pr.elements.map((x) => (x.id === d.id ? moveElement(d.orig, dx, dy) : x)) }), { mergeKey: d.key });
              } else if (d.type === 'resize') {
                const q = snap(p, { excludeId: d.id });
                update((pr) => ({ ...pr, elements: pr.elements.map((x) => (x.id === d.id ? resizeRect(d.orig, d.handle, q) : x)) }), { mergeKey: d.key });
              } else if (d.type === 'vertex') {
                const q = snap(p, { excludeId: d.id });
                update(
                  (pr) => ({
                    ...pr,
                    elements: pr.elements.map((x) => (x.id === d.id && isPolyElement(x) ? { ...x, points: x.points.map((pt, i) => (i === d.index ? q : pt)) } : x)),
                  }),
                  { mergeKey: d.key },
                );
              } else if (d.type === 'ground') {
                update((pr) => ({ ...pr, groundY: p.y }), { mergeKey: d.key });
              } else if (d.type === 'measure-end') {
                const q = snap(p);
                update((pr) => (pr.calibration.measure ? { ...pr, calibration: { ...pr.calibration, measure: { ...pr.calibration.measure, [d.end]: q } } } : pr), { mergeKey: d.key });
              }
              return;
            }
            if (draft?.type === 'rect') setDraft({ ...draft, b: snap(p) });
            else if (draft?.type === 'measure') setDraft({ ...draft, b: snap(p, { from: draft.a, shift: e.shiftKey }) });
            else if (draft?.type === 'poly') setDraft({ ...draft, cursor: snap(p, { from: draft.pts[draft.pts.length - 1], shift: e.shiftKey }) });
          };
          const onUp = () => {
            drag.current = null;
            if (draft?.type === 'rect') {
              const x = Math.min(draft.a.x, draft.b.x);
              const y = Math.min(draft.a.y, draft.b.y);
              const w = Math.abs(draft.b.x - draft.a.x);
              const h = Math.abs(draft.b.y - draft.a.y);
              setDraft(null);
              if (w > 3 && h > 3) {
                const el = createElement(draft.kind, { x, y, w, h }, hints);
                update((pr) => ({ ...pr, elements: insertElement(pr.elements, el) }));
                setSelectedId(el.id);
              }
            } else if (draft?.type === 'measure') {
              const len = Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y);
              setDraft(null);
              if (len > 5) {
                update((pr) => ({
                  ...pr,
                  calibration: { ...pr.calibration, mode: 'measure', measure: { a: draft.a, b: draft.b, lengthFt: pr.calibration.measure?.lengthFt ?? 0 } },
                }));
                setTool('select');
                notify('Reference line drawn — now type its real length in the Scale panel.', 'info');
              }
            }
          };
          const startDrag = (e: React.PointerEvent, el: HouseElement, extra?: { handle?: string; vertex?: number }) => {
            if (tool !== 'select' || e.button !== 0) return;
            e.stopPropagation();
            const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement);
            svg.setPointerCapture(e.pointerId);
            setSelectedId(el.id);
            const start = toImage(e.clientX, e.clientY);
            const key = `drag-${el.id}-${Date.now()}`;
            if (extra?.handle) drag.current = { type: 'resize', id: el.id, handle: extra.handle, start, orig: el, key };
            else if (extra?.vertex !== undefined) drag.current = { type: 'vertex', id: el.id, index: extra.vertex, key };
            else drag.current = { type: 'move', id: el.id, start, orig: el, key };
          };

          return (
            <>
              <img src={photo.dataUrl} width={W} height={H} alt="" draggable={false} style={{ opacity: photoOpacity }} />
              <svg className="overlay" width={W} height={H} viewBox={`0 0 ${W} ${H}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
                onDoubleClick={(e) => {
                  if (draft?.type === 'poly') {
                    e.preventDefault();
                    finishPoly(draft);
                  }
                }}
              >
                {project.elements.map((el) => {
                  if (el.hidden) return null;
                  const color = KIND_INFO[el.kind].color;
                  const isSel = el.id === selectedId;
                  const common = {
                    fill: color,
                    fillOpacity: fillShapes ? (isSel ? 0.28 : 0.14) : 0.001,
                    stroke: color,
                    strokeWidth: isSel ? 2.5 : 1.4,
                    vectorEffect: 'non-scaling-stroke' as const,
                    style: { cursor: tool === 'select' ? 'move' : undefined },
                    onPointerDown: (e: React.PointerEvent) => startDrag(e, el),
                  };
                  return isPolyElement(el) ? (
                    <polygon key={el.id} points={el.points.map((p) => `${p.x},${p.y}`).join(' ')} {...common} />
                  ) : (
                    <rect key={el.id} x={el.x} y={el.y} width={el.w} height={el.h} {...common} />
                  );
                })}
                {showLines && linesD && <path d={linesD} className="bp-lines" vectorEffect="non-scaling-stroke" pointerEvents="none" />}

                {/* Grade line */}
                <line x1={0} x2={W} y1={project.groundY} y2={project.groundY} className="ground-line" vectorEffect="non-scaling-stroke" pointerEvents="none" />
                <g
                  className="ground-handle"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                    drag.current = { type: 'ground', key: `ground-${Date.now()}` };
                  }}
                >
                  <rect x={px(6)} y={project.groundY - px(9)} width={px(64)} height={px(18)} rx={px(4)} />
                  <text x={px(14)} y={project.groundY + px(4.5)} fontSize={px(11)}>
                    GRADE
                  </text>
                </g>

                {/* Scale reference line */}
                {measure && (project.calibration.mode === 'measure' || tool === 'measure') && (
                  <g className="measure">
                    <line x1={measure.a.x} y1={measure.a.y} x2={measure.b.x} y2={measure.b.y} vectorEffect="non-scaling-stroke" />
                    {(['a', 'b'] as const).map((end) => (
                      <circle
                        key={end}
                        cx={measure[end].x}
                        cy={measure[end].y}
                        r={px(6)}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                          drag.current = { type: 'measure-end', end, key: `measure-${Date.now()}` };
                        }}
                      />
                    ))}
                    <text x={(measure.a.x + measure.b.x) / 2} y={(measure.a.y + measure.b.y) / 2 - px(10)} fontSize={px(13)} textAnchor="middle">
                      {measure.lengthFt > 0 ? formatFtIn(measure.lengthFt) : 'enter length →'}
                    </text>
                  </g>
                )}

                {/* Selection handles */}
                {selected && !selected.hidden && tool === 'select' && (
                  <g className="handles">
                    {isPolyElement(selected)
                      ? selected.points.map((p, i) => {
                          const q = selected.points[(i + 1) % selected.points.length];
                          const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
                          return (
                            <g key={i}>
                              <circle
                                cx={mid.x}
                                cy={mid.y}
                                r={px(4)}
                                className="mid-handle"
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  const idx = i + 1;
                                  update((pr) => ({
                                    ...pr,
                                    elements: pr.elements.map((x) => (x.id === selected.id && isPolyElement(x) ? { ...x, points: [...x.points.slice(0, idx), mid, ...x.points.slice(idx)] } : x)),
                                  }));
                                  (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                                  drag.current = { type: 'vertex', id: selected.id, index: idx, key: `ins-${Date.now()}` };
                                }}
                              >
                                <title>Drag to add a corner</title>
                              </circle>
                              <circle
                                cx={p.x}
                                cy={p.y}
                                r={px(6)}
                                className="handle"
                                onPointerDown={(e) => {
                                  if (e.altKey && selected.points.length > 3) {
                                    e.stopPropagation();
                                    update((pr) => ({
                                      ...pr,
                                      elements: pr.elements.map((x) => (x.id === selected.id && isPolyElement(x) ? { ...x, points: x.points.filter((_, j) => j !== i) } : x)),
                                    }));
                                    return;
                                  }
                                  startDrag(e, selected, { vertex: i });
                                }}
                              >
                                <title>Drag to move · Alt+click to delete corner</title>
                              </circle>
                            </g>
                          );
                        })
                      : (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => {
                          const x = h.includes('w') ? selected.x : h.includes('e') ? selected.x + selected.w : selected.x + selected.w / 2;
                          const y = h.includes('n') ? selected.y : h.includes('s') ? selected.y + selected.h : selected.y + selected.h / 2;
                          return (
                            <rect
                              key={h}
                              x={x - px(5)}
                              y={y - px(5)}
                              width={px(10)}
                              height={px(10)}
                              className="handle"
                              style={{ cursor: `${h}-resize` }}
                              onPointerDown={(e) => startDrag(e, selected, { handle: h })}
                            />
                          );
                        })}
                  </g>
                )}

                {/* Drafts */}
                {draft?.type === 'rect' && (
                  <rect
                    x={Math.min(draft.a.x, draft.b.x)}
                    y={Math.min(draft.a.y, draft.b.y)}
                    width={Math.abs(draft.b.x - draft.a.x)}
                    height={Math.abs(draft.b.y - draft.a.y)}
                    className="draft"
                    stroke={KIND_INFO[draft.kind].color}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {draft?.type === 'poly' && (
                  <g className="draft" stroke={KIND_INFO[draft.kind].color}>
                    <polyline points={[...draft.pts, ...(draft.cursor ? [draft.cursor] : [])].map((p) => `${p.x},${p.y}`).join(' ')} vectorEffect="non-scaling-stroke" />
                    {draft.pts.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r={px(i === 0 ? 7 : 4)} className={i === 0 ? 'first' : ''} />
                    ))}
                  </g>
                )}
                {draft?.type === 'measure' && (
                  <g className="measure">
                    <line x1={draft.a.x} y1={draft.a.y} x2={draft.b.x} y2={draft.b.y} vectorEffect="non-scaling-stroke" />
                  </g>
                )}
              </svg>
            </>
          );
        }}
      </Viewport>
    </div>
  );
}

export const TOOLS: Tool[] = ['select', ...TOOL_ORDER, 'ground', 'measure'];
