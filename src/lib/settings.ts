/**
 * Per-browser settings: API keys the user brings themselves. Stored only in this
 * browser (never in project files or the published site) and sent only to the
 * service each key belongs to.
 */
export interface Settings {
  anthropicKey: string;
  model: string;
  rentcastKey: string;
  attomKey: string;
  /** Optional contact email passed to OpenStreetMap Nominatim, per its usage policy. */
  email: string;
  /** Keep keys after the tab closes (localStorage) instead of for this session only. */
  remember: boolean;
}

export const DEFAULT_MODEL = 'claude-opus-5';

export const DEFAULT_SETTINGS: Settings = {
  anthropicKey: '',
  model: DEFAULT_MODEL,
  rentcastKey: '',
  attomKey: '',
  email: '',
  remember: true,
};

const KEY = 'blueprint-engraver:settings';

function read(storage: Storage | undefined): Partial<Settings> | null {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
  } catch {
    return null;
  }
}

export function loadSettings(): Settings {
  const s = read(globalThis.sessionStorage) ?? read(globalThis.localStorage) ?? {};
  return { ...DEFAULT_SETTINGS, ...s, model: s.model?.trim() || DEFAULT_MODEL };
}

export function saveSettings(s: Settings): void {
  const json = JSON.stringify(s);
  try {
    if (s.remember) {
      globalThis.localStorage?.setItem(KEY, json);
      globalThis.sessionStorage?.removeItem(KEY);
    } else {
      globalThis.sessionStorage?.setItem(KEY, json);
      globalThis.localStorage?.removeItem(KEY);
    }
  } catch {
    /* storage unavailable (private mode) — settings last for this page load only */
  }
}

export function clearSettings(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function recordProviders(s: Pick<Settings, 'rentcastKey' | 'attomKey'>): string[] {
  const out: string[] = [];
  if (s.rentcastKey.trim()) out.push('RentCast');
  if (s.attomKey.trim()) out.push('ATTOM');
  return out;
}
