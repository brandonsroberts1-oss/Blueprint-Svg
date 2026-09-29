import { useEffect, useState } from 'react';
import { newId } from '../lib/model/defaults';
import type { Annotations, CalloutOverride, Level } from '../lib/model/types';
import { formatFtIn, parseLength } from '../lib/units';
import { useSheet } from '../state/sheet';
import { useStore } from '../state/store';
import { useUI } from '../state/ui';

function LevelRow({ level, onChange, onDelete }: { level: Level; onChange: (l: Level) => void; onDelete: () => void }) {
  const [h, setH] = useState(formatFtIn(level.heightFt));
  useEffect(() => setH(formatFtIn(level.heightFt)), [level.heightFt]);
  return (
    <div className="level-row">
      <input type="checkbox" checked={level.show} onChange={(e) => onChange({ ...level, show: e.target.checked })} title="Show" />
      <input className="grow" value={level.name} onChange={(e) => onChange({ ...level, name: e.target.value })} />
      <input
        className="short"
        value={h}
        onChange={(e) => setH(e.target.value)}
        onBlur={() => {
          const ft = parseLength(h);
          if (ft !== null) onChange({ ...level, heightFt: ft });
          else setH(formatFtIn(level.heightFt));
        }}
        title="Height above finish grade"
      />
      <button className="mini" onClick={onDelete} title="Remove">
        ✕
      </button>
    </div>
  );
}

export function DetailsPanel() {
  const { project, update } = useStore();
  const { setStep, pendingNote, setPendingNote } = useUI();
  const sheet = useSheet();
  const ann = project.annotations;
  const [noteText, setNoteText] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingNote(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPendingNote]);

  const setAnn = (patch: Partial<Annotations>, key?: string) => update((p) => ({ ...p, annotations: { ...p.annotations, ...patch } }), key ? { mergeKey: key } : undefined);
  const override = (key: string, patch: CalloutOverride, mergeKey?: string) =>
    update((p) => ({ ...p, calloutOverrides: { ...p.calloutOverrides, [key]: { ...p.calloutOverrides[key], ...patch } } }), mergeKey ? { mergeKey } : undefined);

  const levels = sheet.levels;
  const setLevels = (next: Level[]) => update((p) => ({ ...p, levels: next, levelsCustomized: true }), { mergeKey: 'levels' });

  const toggles: [keyof Annotations, string][] = [
    ['showCallouts', 'Callouts'],
    ['showLevels', 'Level lines'],
    ['showDimensions', 'Dimensions'],
    ['showScaleBar', 'Graphic scale bar'],
    ['showDetailTags', 'Detail tags'],
    ['showAddress', 'Address'],
  ];

  return (
    <div className="panel">
      <section>
        <h2>Title block</h2>
        <label>
          Title
          <input value={ann.title} onChange={(e) => setAnn({ title: e.target.value }, 'title')} />
        </label>
        <div className="grid2">
          <label title='Builder-style elevation letter, e.g. C → FRONT ELEVATION "C"'>
            Elevation letter
            <input value={ann.elevationTag} maxLength={3} placeholder="none" onChange={(e) => setAnn({ elevationTag: e.target.value }, 'etag')} />
          </label>
          <label>
            Sheet no.
            <input value={ann.sheetName} maxLength={6} onChange={(e) => setAnn({ sheetName: e.target.value }, 'sheet')} />
          </label>
        </div>
        <label>
          Name line
          <input value={ann.projectName} placeholder="e.g. The Anderson Residence" onChange={(e) => setAnn({ projectName: e.target.value }, 'pname')} />
        </label>
        <p className="muted small">
          Address and facts come from step 1 ({project.property.line1 ? 'set' : 'not set'}).{' '}
          <button className="link" onClick={() => setStep('photo')}>
            Edit
          </button>
        </p>
      </section>

      <section>
        <h3>Show on the sheet</h3>
        <div className="checks two">
          {toggles.map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={Boolean(ann[k])} onChange={(e) => setAnn({ [k]: e.target.checked } as Partial<Annotations>)} /> {label}
            </label>
          ))}
        </div>
        <div className="grid2">
          <label>
            Dimension precision
            <select value={ann.dimPrecision} onChange={(e) => setAnn({ dimPrecision: Number(e.target.value) as Annotations['dimPrecision'] })}>
              <option value={1}>1"</option>
              <option value={2}>1/2"</option>
              <option value={4}>1/4"</option>
              <option value={8}>1/8"</option>
            </select>
          </label>
          <label>
            Max callouts
            <input type="number" min={1} max={40} value={ann.maxCallouts} onChange={(e) => setAnn({ maxCallouts: Math.max(1, Math.min(40, Number(e.target.value) || 1)) })} />
          </label>
        </div>
      </section>

      <section>
        <h2>Callouts</h2>
        <p className="muted small">Generated from your tracing. Edit the wording, hide any, or force a side. Grey ones didn’t fit — hide others or use a bigger board.</p>
        <ul className="callouts">
          {sheet.callouts.map((c) => {
            const o = project.calloutOverrides[c.key] ?? {};
            const custom = c.custom;
            return (
              <li
                key={c.key}
                className={`${c.enabled ? '' : 'off'} ${c.enabled && !c.placed && ann.showCallouts ? 'unplaced' : ''}`}
                title={c.enabled && !c.placed && ann.showCallouts ? 'No room on this board — hide other callouts, shorten the text or use a bigger board' : undefined}
              >
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onChange={(e) => override(c.key, { enabled: e.target.checked })}
                  title={c.enabled ? 'Hide' : 'Show'}
                />
                {c.tag ? (
                  <span className="grow muted">Detail tag {Number(c.key.split(':')[1] ?? 0) + 1} (decorative)</span>
                ) : (
                  <input className="grow" value={o.text ?? c.text} onChange={(e) => override(c.key, { text: e.target.value }, `co-${c.key}`)} />
                )}
                <select value={o.side ?? 'auto'} onChange={(e) => override(c.key, { side: e.target.value === 'auto' ? undefined : (e.target.value as 'left' | 'right') })}>
                  <option value="auto">Auto</option>
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
                {custom && (
                  <button
                    className="mini"
                    title="Delete note"
                    onClick={() => update((p) => ({ ...p, customCallouts: p.customCallouts.filter((x) => `custom:${x.id}` !== c.key) }))}
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!noteText.trim()) return;
            setPendingNote(noteText.trim().toUpperCase());
            setNoteText('');
          }}
        >
          <input className="grow" placeholder="Add your own note, e.g. CEDAR PORCH CEILING" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          <button className="btn small" disabled={!noteText.trim()}>
            Place…
          </button>
        </form>
        {pendingNote && <p className="hint">Now click the drawing where the arrow should point.</p>}
        <button className="btn small ghost" onClick={() => update((p) => ({ ...p, calloutOverrides: {} }))}>
          Reset callout edits
        </button>
      </section>

      <section>
        <h2>Level lines</h2>
        <p className="muted small">{project.levelsCustomized ? 'Edited by you.' : 'Placed automatically from the tracing.'} Heights are above finish grade.</p>
        {levels.map((l, i) => (
          <LevelRow
            key={l.id}
            level={l}
            onChange={(nl) => setLevels(levels.map((x, j) => (j === i ? nl : x)))}
            onDelete={() => setLevels(levels.filter((_, j) => j !== i))}
          />
        ))}
        <div className="row wrap">
          <button className="btn small" onClick={() => setLevels([...levels, { id: newId('lvl'), name: 'NEW LEVEL', heightFt: 10, show: true }])}>
            Add level
          </button>
          {project.levelsCustomized && (
            <button className="btn small ghost" onClick={() => update((p) => ({ ...p, levels: [], levelsCustomized: false }))}>
              Reset to automatic
            </button>
          )}
        </div>
      </section>

      <section>
        <button className="btn primary wide" onClick={() => setStep('export')}>
          Next: size & export →
        </button>
      </section>
    </div>
  );
}
