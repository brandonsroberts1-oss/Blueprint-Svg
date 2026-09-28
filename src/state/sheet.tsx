import { createContext, type ReactNode, useContext, useDeferredValue, useMemo } from 'react';
import { buildSheet, type SheetResult } from '../lib/render/sheet';
import { useStore } from './store';

const Ctx = createContext<SheetResult | null>(null);

/** Builds the sheet from a deferred copy of the project so typing and dragging stay responsive. */
export function SheetProvider({ children }: { children: ReactNode }) {
  const { project } = useStore();
  const deferred = useDeferredValue(project);
  const sheet = useMemo(() => buildSheet(deferred), [deferred]);
  return <Ctx.Provider value={sheet}>{children}</Ctx.Provider>;
}

export function useSheet(): SheetResult {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSheet outside SheetProvider');
  return s;
}
