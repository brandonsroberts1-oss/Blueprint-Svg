import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import type { ElementKind } from '../lib/model/types';
import { type Settings, loadSettings, saveSettings } from '../lib/settings';

export type Step = 'photo' | 'straighten' | 'trace' | 'details' | 'export';
export const STEPS: { id: Step; label: string; short: string }[] = [
  { id: 'photo', label: 'Photo & address', short: 'Photo' },
  { id: 'straighten', label: 'Straighten', short: 'Straighten' },
  { id: 'trace', label: 'Trace', short: 'Trace' },
  { id: 'details', label: 'Callouts & details', short: 'Details' },
  { id: 'export', label: 'Size & export', short: 'Export' },
];

export type Tool = 'select' | ElementKind | 'ground' | 'measure';

/** Progress of a running on-device auto-trace (null when idle). */
export interface AutoTraceProgress {
  message: string;
  fraction: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

interface UI {
  step: Step;
  setStep: (s: Step) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  /** API keys and preferences stored in this browser. */
  settings: Settings;
  setSettings: (s: Settings) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  toasts: Toast[];
  notify: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
  previewMode: 'blueprint' | 'laser';
  setPreviewMode: (m: 'blueprint' | 'laser') => void;
  /** Text of a note waiting to be placed by clicking the sheet preview. */
  pendingNote: string | null;
  setPendingNote: (t: string | null) => void;
  autoTrace: AutoTraceProgress | null;
  setAutoTrace: (p: AutoTraceProgress | null) => void;
}

const Ctx = createContext<UI | null>(null);
let toastId = 0;

export function UIProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<Step>('photo');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const setSettings = useCallback((s: Settings) => {
    saveSettings(s);
    setSettingsState(s);
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [previewMode, setPreviewMode] = useState<'blueprint' | 'laser'>('blueprint');
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [autoTrace, setAutoTrace] = useState<AutoTraceProgress | null>(null);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback(
    (text: string, kind: Toast['kind'] = 'info') => {
      const id = ++toastId;
      setToasts((t) => [...t.slice(-3), { id, text, kind }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 5000);
    },
    [dismiss],
  );
  const value = useMemo(
    () => ({
      step,
      setStep,
      selectedId,
      setSelectedId,
      tool,
      setTool,
      settings,
      setSettings,
      settingsOpen,
      setSettingsOpen,
      toasts,
      notify,
      dismiss,
      previewMode,
      setPreviewMode,
      pendingNote,
      setPendingNote,
      autoTrace,
      setAutoTrace,
    }),
    [step, selectedId, tool, settings, setSettings, settingsOpen, toasts, notify, dismiss, previewMode, pendingNote, autoTrace],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUI(): UI {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUI outside UIProvider');
  return v;
}
