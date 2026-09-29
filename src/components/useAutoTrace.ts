import { useCallback } from 'react';
import { autoTracePhoto, wallHintFrom } from '../lib/autotrace/client';
import type { Rect } from '../lib/autotrace/house';
import { KIND_INFO } from '../lib/model/defaults';
import { elementsFromAnalysis } from '../lib/model/fromAnalysis';
import type { ElementKind, Photo } from '../lib/model/types';
import { useStore } from '../state/store';
import { useUI } from '../state/ui';

/** Run the free on-device auto-trace and put the result into the project. */
export function useAutoTrace() {
  const { project, update } = useStore();
  const { autoTrace, setAutoTrace, notify, setSelectedId } = useUI();

  const start = useCallback(
    async (opts: { photo?: Photo; wallHint?: Rect | null; confirmReplace?: boolean } = {}) => {
      const photo = opts.photo ?? project.photo;
      if (!photo || autoTrace) return;
      if (opts.confirmReplace !== false && project.elements.length && !confirm('Replace your current tracing with a new auto-trace? (You can undo with ↶.)')) return;
      setAutoTrace({ message: 'Starting…', fraction: 0 });
      try {
        const hint = opts.wallHint !== undefined ? opts.wallHint : wallHintFrom(project.straighten);
        const job = await autoTracePhoto(photo, hint, (message, fraction) => setAutoTrace({ message, fraction }));
        if (!job.analysis.houseFound || !job.analysis.elements.length) {
          notify(`${job.analysis.notes || 'No house found.'} Try straightening the photo so the house fills more of it, or trace by hand.`, 'error');
          return;
        }
        const t = elementsFromAnalysis(job.analysis, 1 / job.scale, 1 / job.scale, photo.width, photo.height);
        update((p) =>
          p.photo?.dataUrl !== photo.dataUrl
            ? p
            : { ...p, elements: t.elements, groundY: t.groundY, levelsCustomized: false, property: { ...p.property, stories: p.property.stories ?? t.stories } },
        );
        setSelectedId(null);
        const counts = new Map<ElementKind, number>();
        for (const e of t.elements) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
        const found = [...counts]
          .filter(([k]) => ['window', 'door', 'garage', 'roof', 'gable'].includes(k))
          .map(([k, n]) => `${n} ${(n === 1 ? KIND_INFO[k].label : KIND_INFO[k].plural).toLowerCase()}`)
          .join(', ');
        notify(`Auto-traced in ${(job.ms / 1000).toFixed(1)} s${found ? `: ${found}` : ''}. ${job.analysis.notes} Drag any corner to fine-tune.`.trim(), 'success');
      } catch (e) {
        notify(`Auto-trace failed: ${(e as Error).message}`, 'error');
      } finally {
        setAutoTrace(null);
      }
    },
    [project.photo, project.elements.length, project.straighten, autoTrace, setAutoTrace, update, notify, setSelectedId],
  );

  return { running: autoTrace, start };
}
