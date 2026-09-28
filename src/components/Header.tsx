import { useEffect, useRef } from 'react';
import { defaultProject } from '../lib/model/defaults';
import { demoWithSketch } from '../lib/model/demoPhoto';
import type { Project } from '../lib/model/types';
import { downloadBlob } from '../lib/image/imageUtils';
import { migrate, useStore } from '../state/store';
import { STEPS, useUI } from '../state/ui';

export function Header() {
  const { step, setStep, notify, setSelectedId } = useUI();
  const { project, replace, undo, redo, canUndo, canRedo } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const available = (id: string) => {
    if (id === 'photo') return true;
    if (id === 'straighten') return !!project.straighten;
    return !!project.photo;
  };

  const save = () => {
    const name = (project.annotations.projectName || project.property.line1 || 'house').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${name || 'house'}-blueprint.json`);
  };
  const open = async (file: File) => {
    try {
      const p = JSON.parse(await file.text()) as Project;
      if (p.version !== 1) throw new Error('Not a Blueprint Engraver project file');
      replace(migrate(p));
      setSelectedId(null);
      setStep(p.photo ? 'trace' : 'photo');
      notify('Project loaded.', 'success');
    } catch (e) {
      notify(`Could not open project: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <header className="header">
      <div className="brand">
        <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden>
          <rect width="64" height="64" rx="12" fill="#1c4f8c" />
          <path d="M12 50V30L32 14l20 16v20z M24 50V36h10v14 M38 36h8v7h-8z" fill="none" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />
        </svg>
        <div>
          <div className="brand-name">Blueprint Engraver</div>
          <div className="brand-sub">House photo → laser-ready elevation SVG</div>
        </div>
      </div>
      <nav className="steps">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`step ${s.id === step ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`}
            disabled={!available(s.id)}
            onClick={() => setStep(s.id)}
          >
            <span className="step-num">{i + 1}</span>
            <span className="step-label">{s.label}</span>
          </button>
        ))}
      </nav>
      <div className="header-actions">
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          ↶
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
          ↷
        </button>
        <span className="sep" />
        <button
          className="btn ghost"
          onClick={() => {
            if (project.elements.length && !confirm('Start a new project? Unsaved tracing will be lost.')) return;
            replace(defaultProject());
            setSelectedId(null);
            setStep('photo');
          }}
        >
          New
        </button>
        <button
          className="btn ghost"
          title="Load a sample house to see how it works"
          onClick={() => {
            replace(demoWithSketch());
            setSelectedId(null);
            setStep('trace');
            notify('Demo house loaded — explore the tracing, then check steps 4 and 5.', 'success');
          }}
        >
          Demo
        </button>
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>
          Open…
        </button>
        <button className="btn ghost" onClick={save} disabled={!project.photo && !project.elements.length}>
          Save
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) open(f);
            e.target.value = '';
          }}
        />
      </div>
    </header>
  );
}
