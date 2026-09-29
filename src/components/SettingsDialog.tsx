import { useEffect, useState } from 'react';
import { DEFAULT_MODEL, DEFAULT_SETTINGS, type Settings, clearSettings } from '../lib/settings';
import { useUI } from '../state/ui';

function SecretInput({ value, onChange, placeholder, id }: { value: string; onChange: (v: string) => void; placeholder: string; id: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="row secret">
      <input
        id={id}
        className="grow"
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      <button type="button" className="btn small ghost" onClick={() => setShow(!show)}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

export function SettingsDialog() {
  const { settings, setSettings, settingsOpen, setSettingsOpen, notify } = useUI();
  const [draft, setDraft] = useState<Settings>(settings);

  useEffect(() => {
    if (!settingsOpen) return;
    setDraft(settings);
    const t = window.setTimeout(() => document.getElementById('anthropic-key')?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen, settings, setSettingsOpen]);

  if (!settingsOpen) return null;
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
      <form
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onSubmit={(e) => {
          e.preventDefault();
          setSettings({ ...draft, model: draft.model.trim() || DEFAULT_MODEL });
          setSettingsOpen(false);
          notify('Settings saved.', 'success');
        }}
      >
        <section>
          <h2 id="settings-title">Settings</h2>
          <p className="muted small">
            Everything here is optional and stays in <b>this browser</b>. Keys are never saved in project files or published anywhere; each key is sent
            only to its own service.
          </p>
        </section>

        <section>
          <h3>Tracing with Claude (optional)</h3>
          <label htmlFor="anthropic-key">
            Anthropic API key
            <SecretInput
              id="anthropic-key"
              value={draft.anthropicKey}
              placeholder="sk-ant-…"
              onChange={(anthropicKey) => set({ anthropicKey })}
            />
          </label>
          <p className="muted small">
            Create one at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            . Only needed if you'd rather have Claude trace than the free on-device auto-trace; each trace sends one photo to Claude and is billed to
            your account.
          </p>
          <label>
            Model
            <input value={draft.model} placeholder={DEFAULT_MODEL} onChange={(e) => set({ model: e.target.value })} />
          </label>
        </section>

        <section>
          <h3>Assessor records (optional)</h3>
          <label htmlFor="rentcast-key">
            RentCast API key
            <SecretInput id="rentcast-key" value={draft.rentcastKey} placeholder="Free developer tier at rentcast.io" onChange={(rentcastKey) => set({ rentcastKey })} />
          </label>
          <label htmlFor="attom-key">
            ATTOM API key
            <SecretInput id="attom-key" value={draft.attomKey} placeholder="Used if no RentCast key" onChange={(attomKey) => set({ attomKey })} />
          </label>
          <p className="muted small">
            Adds year built, square footage, lot size, beds/baths and parcel number. Some providers don’t accept requests from web pages; if a lookup
            fails you can still type those facts in step 1.
          </p>
        </section>

        <section>
          <h3>OpenStreetMap</h3>
          <label>
            Contact email (optional)
            <input type="email" value={draft.email} placeholder="you@example.com" onChange={(e) => set({ email: e.target.value })} />
          </label>
          <p className="muted small">Sent with address searches, as the Nominatim usage policy asks for regular use.</p>
        </section>

        <section>
          <label className="check">
            <input type="checkbox" checked={draft.remember} onChange={(e) => set({ remember: e.target.checked })} /> Remember on this device
          </label>
          <p className="muted small">
            Off: keys are forgotten when you close the tab. Don’t save keys on a shared computer. All github.io sites under the same account share browser
            storage, so only publish sites you trust there.
          </p>
          <div className="row wrap">
            <button className="btn primary" type="submit">
              Save
            </button>
            <button className="btn" type="button" onClick={() => setSettingsOpen(false)}>
              Cancel
            </button>
            <button
              className="btn ghost danger"
              type="button"
              onClick={() => {
                clearSettings();
                setSettings({ ...DEFAULT_SETTINGS, remember: draft.remember });
                setDraft({ ...DEFAULT_SETTINGS, remember: draft.remember });
                notify('All keys removed from this browser.', 'info');
              }}
            >
              Forget all keys
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
