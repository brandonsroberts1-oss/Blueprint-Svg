import { useRef, useState } from 'react';
import { lookupAddress } from '../api';
import { importPhoto } from '../lib/image/imageUtils';
import { demoWithSketch } from '../lib/model/demoPhoto';
import { FACT_LABELS, applyLookup } from '../lib/model/facts';
import type { FactKey } from '../lib/model/types';
import type { PropertyLookup } from '../lib/shared/property';
import { formatFtIn } from '../lib/units';
import { useStore } from '../state/store';
import { useUI } from '../state/ui';

const FACT_KEYS = Object.keys(FACT_LABELS) as FactKey[];

function usePhotoUpload() {
  const { project, update } = useStore();
  const { setStep, notify, setSelectedId } = useUI();
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      notify('Please choose an image file (JPG, PNG or WebP).', 'error');
      return;
    }
    if (project.elements.length && !confirm('Replace the photo? Your current tracing will be cleared.')) return;
    setBusy(true);
    try {
      const photo = await importPhoto(file);
      const { width: W, height: H } = photo;
      update((p) => ({
        ...p,
        photo: null,
        elements: [],
        levels: [],
        levelsCustomized: false,
        calibration: { ...p.calibration, mode: p.calibration.mode === 'measure' ? 'auto' : p.calibration.mode, measure: null },
        straighten: {
          original: photo,
          quad: [
            { x: W * 0.22, y: H * 0.34 },
            { x: W * 0.78, y: H * 0.34 },
            { x: W * 0.78, y: H * 0.78 },
            { x: W * 0.22, y: H * 0.78 },
          ],
          aspect: null,
        },
        groundY: H * 0.85,
      }));
      setSelectedId(null);
      setStep('straighten');
    } catch (e) {
      notify(`Could not read that photo: ${(e as Error).message}. HEIC photos may need converting to JPG first.`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return { upload, busy };
}

export function PhotoPanel() {
  const { project, update } = useStore();
  const { setStep, notify, config } = useUI();
  const { upload, busy } = usePhotoUpload();
  const fileRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(project.property.address);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<PropertyLookup | null>(null);
  const prop = project.property;

  const search = async () => {
    if (address.trim().length < 5) return;
    setLooking(true);
    try {
      const r = await lookupAddress(address.trim());
      setResult(r);
      update((p) => ({ ...p, property: applyLookup(p.property, r) }));
      if (!r.address) {
        const geocoders = r.sources.filter((s) => s.name.includes('geocoder') || s.name.includes('Nominatim'));
        const unreachable = geocoders.length > 0 && geocoders.every((s) => s.status === 'error');
        notify(
          unreachable
            ? 'Could not reach the address services from the server (details below). You can still type the address and facts by hand.'
            : 'Address not found. Check the spelling, or enter the details by hand below.',
          'error',
        );
      }
    } catch (e) {
      notify(`Lookup failed: ${(e as Error).message}`, 'error');
    } finally {
      setLooking(false);
    }
  };

  const setFact = (k: FactKey, v: string) => update((p) => ({ ...p, property: { ...p.property, facts: { ...p.property.facts, [k]: v } } }), { mergeKey: `fact-${k}` });
  const showFact = (k: FactKey, v: boolean) => update((p) => ({ ...p, property: { ...p.property, show: { ...p.property.show, [k]: v } } }));

  return (
    <div className="panel">
      <section>
        <h2>1 · House photo</h2>
        <p className="muted">
          Stand across the street and face the house as squarely as you can. Get the whole front and roof in the frame; mid-day overcast light
          with no cars in front works best.
        </p>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Loading…' : project.straighten ? 'Replace photo…' : 'Choose photo…'}
          </button>
          {project.straighten && (
            <button className="btn" onClick={() => setStep('straighten')}>
              Next: straighten →
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = '';
          }}
        />
      </section>

      <section>
        <h2>2 · Address & public records</h2>
        <p className="muted">Used for the title block and for facts like year built. Optional.</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input className="grow" placeholder="123 Main St, Springfield, IL 62704" value={address} onChange={(e) => setAddress(e.target.value)} />
          <button className="btn" disabled={looking || address.trim().length < 5}>
            {looking ? 'Searching…' : 'Look up'}
          </button>
        </form>
        {!config.recordProviders.length && (
          <p className="hint">
            Free sources give the address, coordinates, elevation and building footprint. For year built, square footage and lot size, add a{' '}
            <a href="https://www.rentcast.io/api" target="_blank" rel="noreferrer">
              RentCast
            </a>{' '}
            or ATTOM API key on the server (see README).
          </p>
        )}
        {result && (
          <ul className="sources">
            {result.sources.map((s) => (
              <li key={s.name} className={s.status}>
                <span className="dot" />
                <div>
                  <div>{s.name}</div>
                  {s.message ? <div className="muted">{s.message}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="card">
          <div className="label">Title block address</div>
          <input value={prop.line1} placeholder="Street (e.g. 1234 Maple Ridge Lane)" onChange={(e) => update((p) => ({ ...p, property: { ...p.property, line1: e.target.value } }), { mergeKey: 'line1' })} />
          <input value={prop.line2} placeholder="City, State ZIP" onChange={(e) => update((p) => ({ ...p, property: { ...p.property, line2: e.target.value } }), { mergeKey: 'line2' })} />
        </div>
        {prop.footprintFacadeFt && (
          <div className="card">
            <div className="label">Building footprint (OpenStreetMap)</div>
            <p>
              Street-facing width ≈ <b>{formatFtIn(prop.footprintFacadeFt)}</b>
              {result?.building ? ` × ${formatFtIn(result.building.depthFt)} deep` : ''}.{' '}
              {result?.building && (
                <a href={result.building.url} target="_blank" rel="noreferrer">
                  View on map
                </a>
              )}
            </p>
            <p className="muted small">You can use this as the scale reference once the walls are traced (step 3 → Scale).</p>
            <p className="muted small">
              Footprint data ©{' '}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                OpenStreetMap contributors
              </a>
              .
            </p>
          </div>
        )}
      </section>

      <section>
        <h2>Facts to print on the sheet</h2>
        <p className="muted small">Tick what should appear under the title. You can type or correct any value.</p>
        <div className="facts">
          {FACT_KEYS.map((k) => (
            <label key={k} className="fact">
              <input type="checkbox" checked={!!prop.show[k]} onChange={(e) => showFact(k, e.target.checked)} />
              <span className="fact-label">{FACT_LABELS[k]}</span>
              <input value={prop.facts[k] ?? ''} placeholder="—" onChange={(e) => setFact(k, e.target.value)} />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

export function PhotoMain() {
  const { project, replace } = useStore();
  const { setStep, notify, setSelectedId } = useUI();
  const { upload, busy } = usePhotoUpload();
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shown = project.straighten?.original ?? project.photo;

  return (
    <div
      className={`dropzone-wrap ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) upload(f);
      }}
    >
      {shown ? (
        <div className="photo-view">
          <img src={shown.dataUrl} alt="House photo" />
          <p className="muted">Drop another photo here to replace it.</p>
        </div>
      ) : (
        <div className="dropzone" onClick={() => fileRef.current?.click()}>
          <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden>
            <path d="M8 54V28L32 10l24 18v26z M22 54V38h12v16 M40 38h9v8h-9z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
          </svg>
          <h1>Drop a photo of the front of the house</h1>
          <p>or click to choose one — JPG, PNG or WebP</p>
          {busy && <p>Loading…</p>}
          <button
            className="btn ghost"
            onClick={(e) => {
              e.stopPropagation();
              replace(demoWithSketch());
              setSelectedId(null);
              setStep('trace');
              notify('Demo house loaded.', 'success');
            }}
          >
            Or explore the demo house
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
