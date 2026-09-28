import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Vec } from '../lib/geometry/vec';

export interface ViewState {
  s: number;
  tx: number;
  ty: number;
}

export interface ViewportApi {
  view: ViewState;
  /** Client (screen) coordinates -> image pixel coordinates. */
  toImage: (clientX: number, clientY: number) => Vec;
  fit: () => void;
  zoomBy: (f: number) => void;
}

interface Props {
  width: number;
  height: number;
  /** Rendered under the transform, in image pixel space. */
  children: (api: ViewportApi) => ReactNode;
  /** Rendered on top, in screen space (toolbars, loupes). */
  overlay?: (api: ViewportApi) => ReactNode;
  className?: string;
  cursor?: string;
}

/** Zoomable, pannable canvas for an image-sized coordinate space. Wheel zooms; middle-drag or Space+drag pans. */
export function Viewport({ width, height, children, overlay, className, cursor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const space = useRef(false);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !width || !height) return;
    const r = el.getBoundingClientRect();
    const s = Math.min((r.width - 24) / width, (r.height - 24) / height);
    setView({ s, tx: (r.width - width * s) / 2, ty: (r.height - height * s) / 2 });
  }, [width, height]);

  useLayoutEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomAt = useCallback((cx: number, cy: number, f: number) => {
    setView((v) => {
      const s = Math.min(40, Math.max(0.02, v.s * f));
      const k = s / v.s;
      return { s, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomAt(e.clientX - r.left, e.clientY - r.top, f);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        space.current = true;
        el.style.cursor = 'grab';
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        space.current = false;
        el.style.cursor = '';
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [zoomAt]);

  const toImage = useCallback((clientX: number, clientY: number): Vec => {
    const el = ref.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.tx) / v.s, y: (clientY - r.top - v.ty) / v.s };
  }, []);

  const api: ViewportApi = {
    view,
    toImage,
    fit,
    zoomBy: (f) => {
      const r = ref.current?.getBoundingClientRect();
      if (r) zoomAt(r.width / 2, r.height / 2, f);
    },
  };

  return (
    <div
      ref={ref}
      className={`viewport ${className ?? ''}`}
      style={{ cursor }}
      onPointerDownCapture={(e) => {
        if (e.button === 1 || (e.button === 0 && space.current)) {
          e.preventDefault();
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pan.current = { x: e.clientX, y: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
        }
      }}
      onPointerMove={(e) => {
        const p = pan.current;
        if (p) setView((v) => ({ ...v, tx: p.tx + e.clientX - p.x, ty: p.ty + e.clientY - p.y }));
      }}
      onPointerUp={() => {
        pan.current = null;
      }}
    >
      <div className="viewport-layer" style={{ width, height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
        {children(api)}
      </div>
      {overlay?.(api)}
      <div className="zoom-controls">
        <button onClick={() => api.zoomBy(1.25)} title="Zoom in">
          +
        </button>
        <button onClick={() => api.zoomBy(0.8)} title="Zoom out">
          −
        </button>
        <button onClick={fit} title="Fit to window">
          Fit
        </button>
      </div>
    </div>
  );
}
