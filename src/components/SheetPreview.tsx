import { useMemo } from 'react';
import { newId } from '../lib/model/defaults';
import { worldToPx } from '../lib/model/world';
import { strokesToSvg } from '../lib/render/svg';
import { useSheet } from '../state/sheet';
import { useStore } from '../state/store';
import { useUI } from '../state/ui';
import { Viewport } from './Viewport';

/** Screen pixels per sheet millimetre at zoom 1. */
const PX_PER_MM = 4;

export function SheetPreview() {
  const sheet = useSheet();
  const { update } = useStore();
  const { previewMode, setPreviewMode, pendingNote, setPendingNote, notify } = useUI();
  const W = sheet.widthMm * PX_PER_MM;
  const H = sheet.heightMm * PX_PER_MM;
  const markup = useMemo(() => {
    const svg = strokesToSvg(sheet.widthMm, sheet.heightMm, sheet.strokes, { mode: previewMode, colorMode: 'layers' });
    return svg.replace(/^<\?xml[^>]*>\s*/, '').replace(/width="[\d.]+mm" height="[\d.]+mm"/, `width="${W}" height="${H}"`);
  }, [sheet, previewMode, W, H]);

  return (
    <div className={`preview-wrap ${previewMode}`}>
      <div className="float-bar">
        <div className="seg">
          <button className={previewMode === 'blueprint' ? 'on' : ''} onClick={() => setPreviewMode('blueprint')}>
            Blueprint
          </button>
          <button className={previewMode === 'laser' ? 'on' : ''} onClick={() => setPreviewMode('laser')}>
            Laser layers
          </button>
        </div>
        <span className="muted small">
          {Math.round(sheet.widthMm)} × {Math.round(sheet.heightMm)} mm · {sheet.scale?.label ?? ''}
        </span>
      </div>
      {pendingNote && <div className="draw-hint">Click the drawing where the note “{pendingNote}” should point. Esc to cancel.</div>}
      <Viewport width={W} height={H} cursor={pendingNote ? 'crosshair' : 'default'}>
        {({ toImage }) => (
          <div
            className="sheet"
            style={{ width: W, height: H }}
            onPointerDown={(e) => {
              if (!pendingNote || e.button !== 0) return;
              const p = toImage(e.clientX, e.clientY);
              const world = sheet.fromPaper({ x: p.x / PX_PER_MM, y: p.y / PX_PER_MM });
              const anchor = worldToPx(sheet.frame, world);
              update((pr) => ({ ...pr, customCallouts: [...pr.customCallouts, { id: newId('note'), text: pendingNote, anchor, side: 'auto' }] }));
              setPendingNote(null);
              notify('Note added.', 'success');
            }}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        )}
      </Viewport>
      {sheet.warnings.length > 0 && (
        <div className="warnings">
          {sheet.warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}
