import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import type { ElementKind } from '../lib/model/types';
import type { ServerConfig } from '../lib/shared/property';

export type Step = 'photo' | 'straighten' | 'trace' | 'details' | 'export';
export const STEPS: { id: Step; label: string }[] = [
  { id: 'photo', label: 'Photo & address' },
  { id: 'straighten', label: 'Straighten' },
  { id: 'trace', label: 'Trace' },
  { id: 'details', label: 'Callouts & details' },
  { id: 'export', label: 'Size & export' },
];

export type Tool = 'select' | ElementKind | 'ground' | 'measure';

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
  config: ServerConfig;
  setConfig: (c: ServerConfig) => void;
  toasts: Toast[];
  notify: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
  previewMode: 'blueprint' | 'laser';
  setPreviewMode: (m: 'blueprint' | 'laser') => void;
  /** Text of a note waiting to be placed by clicking the sheet preview. */
  pendingNote: string | null;
  setPendingNote: (t: string | null) => void;
}

const Ctx = createContext<UI | null>(null);
let toastId = 0;

export function UIProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<Step>('photo');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [config, setConfig] = useState<ServerConfig>({ ai: false, aiModel: null, recordProviders: [] });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [previewMode, setPreviewMode] = useState<'blueprint' | 'laser'>('blueprint');
  const [pendingNote, setPendingNote] = useState<string | null>(null);
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
    () => ({ step, setStep, selectedId, setSelectedId, tool, setTool, config, setConfig, toasts, notify, dismiss, previewMode, setPreviewMode, pendingNote, setPendingNote }),
    [step, selectedId, tool, config, toasts, notify, dismiss, previewMode, pendingNote],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUI(): UI {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUI outside UIProvider');
  return v;
}
