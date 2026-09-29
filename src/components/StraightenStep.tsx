import { useMemo, useRef, useState } from 'react';
import { type Mat3, applyH, estimateRectAspect, homographyFromPoints, invertH, multiplyH } from '../lib/geometry/homography';
import type { Vec } from '../lib/geometry/vec';
import { loadImage, resizeImage, warpToRectangle } from '../lib/image/imageUtils';
import type { HouseElement, Project } from '../lib/model/types';
import { isPolyElement } from '../lib/model/types';
import { formatFtIn, parseLength } from '../lib/units';
import { useStore } from '../state/store';
import { useUI } from '../state/ui';
import { ChangePhotoButton } from './PhotoActions';
import { Viewport } from './Viewport';

const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

/** Move traced elements from the old rectified photo onto a new one. */
function remapElements(elements: HouseElement[], M: Mat3): HouseElement[] {
  return elements.map((e) => {
    if (isPolyElement(e)) return { ...e, points: e.points.map((p) => applyH(M, p)) };
    const corners = [
      { x: e.x, y: e.y },
      { x: e.x + e.w, y: e.y },
      { x: e.x + e.w, y: e.y + e.h },
      { x: e.x, y: e.y + e.h },
    ].map((p) => applyH(M, p));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { ...e, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  });
}

function applyNewPhoto(p: Project, photo: Project['photo'], H: Mat3, quad: Vec[] | null): Project {
  const st = p.straighten!;
  let elements = p.elements;
  let groundY = p.groundY;
  let calibration = p.calibration;
  const oldH = st.H as Mat3 | null | undefined;
  if (p.photo && oldH && elements.length) {
    const inv = invertH(oldH);
    if (inv) {
      const M = multiplyH(H, inv);
      elements = remapElements(elements, M);
      groundY = applyH(M, { x: p.photo.width / 2, y: p.groundY }).y;
      if (calibration.measure) calibration = { ...calibration, measure: { ...calibration.measure, a: applyH(M, calibration.measure.a), b: applyH(M, calibration.measure.b) } };
    }
  } else if (quad) {
    // Fresh tracing: put the grade line at the bottom of the reference rectangle.
    groundY = (applyH(H, quad[2]).y + applyH(H, quad[3]).y) / 2;
  } else {
    groundY = photo!.height * 0.88;
  }
  if (quad && st.knownWidthFt && st.knownWidthFt > 0) {
    calibration = { ...calibration, mode: 'measure', measure: { a: applyH(H, quad[3]), b: applyH(H, quad[2]), lengthFt: st.knownWidthFt } };
  }
  return { ...p, photo, straighten: { ...st, H: [...H] }, elements, groundY, calibration };
}

export function StraightenPanel() {
  const { project, update } = useStore();
  const { setStep, notify } = useUI();
  const st = project.straighten;
  const [busy, setBusy] = useState(false);
  const [widthText, setWidthText] = useState(st?.knownWidthFt ? formatFtIn(st.knownWidthFt) : '');
  const [heightText, setHeightText] = useState(st?.knownHeightFt ? formatFtIn(st.knownHeightFt) : '');

  const estimate = useMemo(() => (st?.quad ? estimateRectAspect(st.quad, st.original.width, st.original.height) : null), [st]);
  if (!st) return <div className="panel">Upload a photo first.</div>;
  const w = parseLength(widthText);
  const h = parseLength(heightText);
  const aspect = w && h ? w / h : estimate?.aspect ?? 1;

  const setKnown = (wt: string, ht: string) => {
    const kw = parseLength(wt);
    const kh = parseLength(ht);
    update((p) => ({ ...p, straighten: { ...p.straighten!, knownWidthFt: kw, knownHeightFt: kh, aspect: kw && kh ? kw / kh : null } }), { mergeKey: 'known-size' });
  };

  const apply = async () => {
    if (!st.quad) return;
    setBusy(true);
    try {
      const img = await loadImage(st.original.dataUrl);
      const res = warpToRectangle(img, st.quad, aspect);
      if (!res) throw new Error('Those corners do not form a usable rectangle — make sure they go around clockwise.');
      update((p) => applyNewPhoto(p, res.photo, res.H, st.quad));
      setStep('trace');
      notify('Photo straightened. Next, trace the house (or let AI do a first pass).', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    try {
      const img = await loadImage(st.original.dataUrl);
      const photo = resizeImage(img, 2400, 0.9);
      const s = photo.width / st.original.width;
      update((p) => applyNewPhoto(p, photo, [s, 0, 0, 0, s, 0, 0, 0, 1], null));
      setStep('trace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <section>
        <h2>Straighten the photo</h2>
        <p>
          Drag the four corners onto something that is a <b>rectangle on the front wall</b> — ideally the outside corners of the main wall at the
          ground and just under the eaves. The grid shows what will become level and plumb.
        </p>
        <p className="muted small">Zoom with the mouse wheel; hold Space and drag to pan. A magnifier appears while you drag a corner.</p>
      </section>
      <section>
        <h3>Real size of that rectangle (optional)</h3>
        <div className="grid2">
          <label>
            Width
            <input
              placeholder={`e.g. 42'-6"`}
              value={widthText}
              onChange={(e) => {
                setWidthText(e.target.value);
                setKnown(e.target.value, heightText);
              }}
            />
          </label>
          <label>
            Height
            <input
              placeholder={`e.g. 18'`}
              value={heightText}
              onChange={(e) => {
                setHeightText(e.target.value);
                setKnown(widthText, e.target.value);
              }}
            />
          </label>
        </div>
        <p className="muted small">
          {w && h
            ? `Using your size: ${aspect.toFixed(2)} : 1.`
            : estimate
              ? `Estimated proportions ${estimate.aspect.toFixed(2)} : 1 (${estimate.method === 'perspective' ? 'from the perspective' : 'from the side lengths'}).`
              : ''}{' '}
          A known width also sets the drawing scale.
        </p>
        {project.property.footprintFacadeFt && !widthText && (
          <button
            className="btn small"
            onClick={() => {
              const t = formatFtIn(project.property.footprintFacadeFt!);
              setWidthText(t);
              setKnown(t, heightText);
            }}
          >
            Use footprint width {formatFtIn(project.property.footprintFacadeFt)}
          </button>
        )}
      </section>
      <section className="row wrap">
        <button className="btn primary" disabled={busy || !st.quad} onClick={apply}>
          {busy ? 'Working…' : 'Straighten photo →'}
        </button>
        <button className="btn" disabled={busy} onClick={skip}>
          Photo is already straight
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            const W = st.original.width;
            const H = st.original.height;
            update((p) => ({
              ...p,
              straighten: {
                ...p.straighten!,
                quad: [
                  { x: W * 0.22, y: H * 0.34 },
                  { x: W * 0.78, y: H * 0.34 },
                  { x: W * 0.78, y: H * 0.78 },
                  { x: W * 0.22, y: H * 0.78 },
                ],
              },
            }));
          }}
        >
          Reset corners
        </button>
      </section>
      <section className="row wrap">
        <span className="muted small">Not the right photo?</span>
        <ChangePhotoButton className="btn small" label="Choose a different photo…" />
      </section>
    </div>
  );
}

export function StraightenCanvas() {
  const { project, update } = useStore();
  const st = project.straighten;
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<Vec | null>(null);
  const drag = useRef<number | null>(null);

  const quad = st?.quad;
  const grid = useMemo(() => {
    if (!quad) return [];
    const Hq = homographyFromPoints(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      quad,
    );
    if (!Hq) return [];
    const lines: Vec[][] = [];
    const n = 6;
    for (let i = -2; i <= n + 2; i++) {
      const t = i / n;
      lines.push([applyH(Hq, { x: t, y: -0.6 }), applyH(Hq, { x: t, y: 1.4 })]);
      lines.push([applyH(Hq, { x: -0.5, y: t }), applyH(Hq, { x: 1.5, y: t })]);
    }
    return lines;
  }, [quad]);

  if (!st || !quad) return null;
  const { width: W, height: H } = st.original;

  return (
    <Viewport
      width={W}
      height={H}
      overlay={() =>
        active !== null && hover ? (
          <div className="loupe">
            <div
              className="loupe-img"
              style={{
                width: W * 4,
                height: H * 4,
                backgroundImage: `url(${st.original.dataUrl})`,
                backgroundSize: `${W * 4}px ${H * 4}px`,
                transform: `translate(${-hover.x * 4 + 90}px, ${-hover.y * 4 + 90}px)`,
              }}
            />
            <div className="loupe-cross" />
            <div className="loupe-label">{CORNER_NAMES[active]}</div>
          </div>
        ) : null
      }
    >
      {({ view, toImage }) => (
        <>
          <img src={st.original.dataUrl} width={W} height={H} alt="" draggable={false} />
          <svg
            className="overlay"
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            onPointerMove={(e) => {
              if (drag.current === null) return;
              const p = toImage(e.clientX, e.clientY);
              const i = drag.current;
              setHover(p);
              update(
                (pr) => {
                  const q = [...pr.straighten!.quad!];
                  q[i] = { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
                  return { ...pr, straighten: { ...pr.straighten!, quad: q } };
                },
                { mergeKey: `quad-${i}` },
              );
            }}
            onPointerUp={() => {
              drag.current = null;
              setActive(null);
            }}
          >
            {grid.map((l, i) => (
              <line key={i} x1={l[0].x} y1={l[0].y} x2={l[1].x} y2={l[1].y} className="persp-grid" vectorEffect="non-scaling-stroke" />
            ))}
            <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} className="quad" vectorEffect="non-scaling-stroke" />
            {quad.map((p, i) => (
              <g key={i}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={11 / view.s}
                  className={`handle ${active === i ? 'active' : ''}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                    drag.current = i;
                    setActive(i);
                    setHover(p);
                  }}
                />
                <text x={p.x + 14 / view.s} y={p.y - 14 / view.s} fontSize={13 / view.s} className="handle-label">
                  {i + 1}
                </text>
              </g>
            ))}
          </svg>
        </>
      )}
    </Viewport>
  );
}
