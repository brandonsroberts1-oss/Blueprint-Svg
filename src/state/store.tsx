import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { defaultProject } from '../lib/model/defaults';
import type { Project } from '../lib/model/types';
import { idbGet, idbSet } from './idb';

interface HistoryState {
  project: Project;
  past: Project[];
  future: Project[];
  mergeKey: string | null;
  mergeAt: number;
}

type Action =
  | { type: 'update'; fn: (p: Project) => Project; mergeKey?: string; record?: boolean }
  | { type: 'replace'; project: Project; record?: boolean }
  | { type: 'undo' }
  | { type: 'redo' };

const LIMIT = 80;

function reducer(state: HistoryState, action: Action): HistoryState {
  switch (action.type) {
    case 'update': {
      const next = action.fn(state.project);
      if (next === state.project) return state;
      if (action.record === false) return { ...state, project: next };
      const now = Date.now();
      const merge = action.mergeKey && action.mergeKey === state.mergeKey && now - state.mergeAt < 1200;
      return {
        project: next,
        past: merge ? state.past : [...state.past.slice(-LIMIT), state.project],
        future: [],
        mergeKey: action.mergeKey ?? null,
        mergeAt: now,
      };
    }
    case 'replace':
      return {
        project: action.project,
        past: action.record === false ? [] : [...state.past.slice(-LIMIT), state.project],
        future: [],
        mergeKey: null,
        mergeAt: 0,
      };
    case 'undo': {
      if (!state.past.length) return state;
      const prev = state.past[state.past.length - 1];
      return { project: prev, past: state.past.slice(0, -1), future: [state.project, ...state.future], mergeKey: null, mergeAt: 0 };
    }
    case 'redo': {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { project: next, past: [...state.past, state.project], future: rest, mergeKey: null, mergeAt: 0 };
    }
  }
}

export interface Store {
  project: Project;
  /** Apply a change. Calls with the same `mergeKey` in quick succession share one undo step (drags). */
  update: (fn: (p: Project) => Project, opts?: { mergeKey?: string; record?: boolean }) => void;
  replace: (project: Project, opts?: { record?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const Ctx = createContext<Store | null>(null);

const AUTOSAVE_KEY = 'blueprint-engraver:project';

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, null, () => ({ project: defaultProject(), past: [], future: [], mergeKey: null, mergeAt: 0 }));
  const update = useCallback<Store['update']>((fn, opts) => dispatch({ type: 'update', fn, ...opts }), []);
  const replace = useCallback<Store['replace']>((project, opts) => dispatch({ type: 'replace', project, ...opts }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  // Debounced autosave to IndexedDB (photos are too large for localStorage).
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      idbSet(AUTOSAVE_KEY, state.project).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer.current);
  }, [state.project]);

  const value = useMemo<Store>(
    () => ({ project: state.project, update, replace, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 }),
    [state, update, replace, undo, redo],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside ProjectProvider');
  return s;
}

export async function loadAutosave(): Promise<Project | null> {
  try {
    const p = await idbGet<Project>(AUTOSAVE_KEY);
    return p && p.version === 1 ? migrate(p) : null;
  } catch {
    return null;
  }
}

/** Fill in fields added after a project was saved and drop retired ones. */
export function migrate(p: Project): Project {
  const d = defaultProject();
  const annotations = { ...d.annotations, ...p.annotations };
  delete (annotations as { showPitch?: boolean }).showPitch; // roof pitch symbols were removed
  return {
    ...d,
    ...p,
    calibration: { ...d.calibration, ...p.calibration },
    annotations,
    property: { ...d.property, ...p.property, hints: { ...(p.property?.hints ?? {}) } },
    layout: { ...d.layout, ...p.layout },
    calloutOverrides: p.calloutOverrides ?? {},
    customCallouts: p.customCallouts ?? [],
    levels: p.levels ?? [],
  };
}
