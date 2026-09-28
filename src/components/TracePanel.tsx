import { useState } from 'react';
import { analyzeImage } from '../api';
import { photoForAnalysis } from '../lib/image/imageUtils';
import { KIND_INFO, TOOL_ORDER } from '../lib/model/defaults';
import { elementsFromAnalysis } from '../lib/model/fromAnalysis';
import type { CalibrationMode } from '../lib/model/types';
import { resolveScale } from '../lib/model/world';
import { formatFtIn, parseLength } from '../lib/units';
import { useSheet } from '../state/sheet';
import { useStore } from '../state/store';
import { type Tool, useUI } from '../state/ui';
import { ElementProps } from './ElementProps';
import { HOTKEYS } from './TraceEditor';

const hotkeyFor = (t: Tool) => Object.entries(HOTKEYS).find(([, v]) => v === t)?.[0]?.toUpperCase();

function AiSection() {
  const { project, update } = useStore();
  const { config, notify, setSelectedId } = useUI();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!project.photo) return;
    if (project.elements.length && !confirm('Replace your current tracing with the AI tracing?')) return;
    setBusy(true);
    try {
      const img = await photoForAnalysis(project.photo);
      const res = await analyzeImage(img.dataUrl, img.width, img.height);
      if (!res.analysis.houseFound) {
        notify('The AI could not find the front of a house in this photo.', 'error');
        return;
      }
      const sx = project.photo.width / res.width;
      const sy = project.photo.height / res.height;
      const t = elementsFromAnalysis(res.analysis, sx, sy, project.photo.width, project.photo.height);
      update((p) => ({
        ...p,
        elements: t.elements,
        groundY: t.groundY,
        levelsCustomized: false,
        property: { ...p.property, stories: p.property.stories ?? t.stories, hints: { ...p.property.hints, style: p.property.hints.style ?? t.style } },
      }));
      setSelectedId(null);
      notify(
        `Traced ${t.elements.length} elements${t.skipped ? ` (${t.skipped} unusable ones skipped)` : ''}. ${t.notes} Check the shapes against the photo and adjust.`,
        'success',
      );
    } catch (e) {
      notify(`AI tracing failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2>Trace the house</h2>
      <button className="btn primary wide" disabled={!config.ai || busy} onClick={run}>
        {busy ? 'Analysing photo… (up to a minute)' : '✨ Auto-trace with AI'}
      </button>
      {!config.ai && <p className="hint">AI tracing is off. Set ANTHROPIC_API_KEY on the server to enable it — or trace by hand with the tools below.</p>}
      {config.ai && <p className="muted small">Uses {config.aiModel}. The result is a starting point — drag corners to match the photo exactly.</p>}
    </section>
  );
}

function ScaleSection() {
  const { project, update } = useStore();
  const { setTool } = useUI();
  const sheet = useSheet();
  const info = resolveScale(project);
  const cal = project.calibration;
  const [lenText, setLenText] = useState(cal.measure?.lengthFt ? formatFtIn(cal.measure.lengthFt) : '');
  const [widthText, setWidthText] = useState(cal.facadeWidthFt ? formatFtIn(cal.facadeWidthFt) : project.property.footprintFacadeFt ? formatFtIn(project.property.footprintFacadeFt) : '');
  const setMode = (mode: CalibrationMode) => update((p) => ({ ...p, calibration: { ...p.calibration, mode } }));

  return (
    <section>
      <h2>Scale</h2>
      <p className={`scale-source ${info.confidence}`}>
        {info.source}
        {sheet.houseWidthFt ? (
          <>
            <br />
            House: <b>{formatFtIn(sheet.houseWidthFt)}</b> wide × <b>{formatFtIn(sheet.houseHeightFt ?? 0)}</b> to the ridge
          </>
        ) : null}
      </p>
      <div className="seg">
        {(
          [
            ['auto', 'Standard doors'],
            ['measure', 'Measured line'],
            ['facade-width', 'Facade width'],
          ] as [CalibrationMode, string][]
        ).map(([m, label]) => (
          <button key={m} className={cal.mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {cal.mode === 'auto' && <p className="muted small">Assumes a 6'-8" entry door and 7'-0" garage door. For better accuracy, measure something.</p>}
      {cal.mode === 'measure' && (
        <div className="stack">
          <button className="btn small" onClick={() => setTool('measure')}>
            {cal.measure ? 'Redraw reference line' : 'Draw reference line on photo'}
          </button>
          <label>
            Real length of the line
            <input
              placeholder={`e.g. 16'-0"`}
              value={lenText}
              onChange={(e) => {
                setLenText(e.target.value);
                const ft = parseLength(e.target.value);
                if (ft && cal.measure) update((p) => ({ ...p, calibration: { ...p.calibration, measure: { ...p.calibration.measure!, lengthFt: ft } } }), { mergeKey: 'measure-len' });
              }}
            />
          </label>
        </div>
      )}
      {cal.mode === 'facade-width' && (
        <label>
          Wall-to-wall width of the traced walls
          <input
            placeholder={`e.g. 44'-6"`}
            value={widthText}
            onChange={(e) => {
              setWidthText(e.target.value);
              const ft = parseLength(e.target.value);
              update((p) => ({ ...p, calibration: { ...p.calibration, facadeWidthFt: ft } }), { mergeKey: 'facade-width' });
            }}
          />
        </label>
      )}
    </section>
  );
}

export function TracePanel() {
  const { project, update } = useStore();
  const { tool, setTool, selectedId, setSelectedId, setStep } = useUI();
  const selected = project.elements.find((e) => e.id === selectedId) ?? null;
  const move = (id: string, dir: 1 | -1) =>
    update((p) => {
      const i = p.elements.findIndex((e) => e.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.elements.length) return p;
      const els = [...p.elements];
      [els[i], els[j]] = [els[j], els[i]];
      return { ...p, elements: els };
    });

  return (
    <div className="panel">
      <AiSection />
      <section>
        <h3>Tools</h3>
        <div className="tools">
          <button className={`tool ${tool === 'select' ? 'on' : ''}`} onClick={() => setTool('select')} title="Select & edit (V)">
            <span className="swatch sel" />
            Select <kbd>V</kbd>
          </button>
          {TOOL_ORDER.map((k) => (
            <button key={k} className={`tool ${tool === k ? 'on' : ''}`} onClick={() => setTool(k)} title={KIND_INFO[k].hint}>
              <span className="swatch" style={{ background: KIND_INFO[k].color }} />
              {KIND_INFO[k].label} <kbd>{hotkeyFor(k)}</kbd>
            </button>
          ))}
          <button className={`tool ${tool === 'ground' ? 'on' : ''}`} onClick={() => setTool('ground')} title="Set the finish grade line (B)">
            <span className="swatch ground" />
            Grade line <kbd>B</kbd>
          </button>
        </div>
        <p className="muted small">
          Trace back to front: walls, then roofs & gables, then windows and doors. Later shapes hide earlier ones. Wheel = zoom, Space+drag = pan,
          Ctrl+D = duplicate, arrows = nudge.
        </p>
      </section>

      {selected && (
        <section className="selected">
          <h3>
            <span className="swatch" style={{ background: KIND_INFO[selected.kind].color }} /> {selected.name || KIND_INFO[selected.kind].label}
          </h3>
          <ElementProps el={selected} />
          <div className="row wrap">
            <button className="btn small" onClick={() => move(selected.id, 1)} title="Draw in front of the next element">
              Bring forward
            </button>
            <button className="btn small" onClick={() => move(selected.id, -1)} title="Draw behind the previous element">
              Send back
            </button>
            <button
              className="btn small danger"
              onClick={() => {
                update((p) => ({ ...p, elements: p.elements.filter((e) => e.id !== selected.id) }));
                setSelectedId(null);
              }}
            >
              Delete
            </button>
          </div>
        </section>
      )}

      <section>
        <h3>Elements ({project.elements.length})</h3>
        {project.elements.length === 0 ? (
          <p className="muted small">Nothing traced yet.</p>
        ) : (
          <ul className="layers">
            <li className="layers-note">front</li>
            {[...project.elements].reverse().map((e) => (
              <li key={e.id} className={e.id === selectedId ? 'on' : ''} onClick={() => setSelectedId(e.id)}>
                <span className="swatch" style={{ background: KIND_INFO[e.kind].color }} />
                <span className="grow">{e.name || KIND_INFO[e.kind].label}</span>
                <button
                  className="mini"
                  title={e.hidden ? 'Show' : 'Hide'}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    update((p) => ({ ...p, elements: p.elements.map((x) => (x.id === e.id ? { ...x, hidden: !x.hidden } : x)) }));
                  }}
                >
                  {e.hidden ? '◌' : '●'}
                </button>
              </li>
            ))}
            <li className="layers-note">back</li>
          </ul>
        )}
      </section>

      <ScaleSection />

      <section>
        <button className="btn primary wide" disabled={!project.elements.length} onClick={() => setStep('details')}>
          Next: callouts & details →
        </button>
      </section>
    </div>
  );
}
