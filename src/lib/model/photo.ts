import type { Project } from './types';

/** Work tied to the current photo's pixels, which a different photo would invalidate. */
export function hasPhotoWork(p: Project): boolean {
  return p.elements.length > 0 || p.customCallouts.length > 0 || !!p.calibration.measure;
}

/** The project without its photo and everything traced on it. Address, facts, callout wording and sheet settings stay. */
export function withoutPhoto(p: Project): Project {
  return {
    ...p,
    photo: null,
    straighten: null,
    elements: [],
    levels: [],
    levelsCustomized: false,
    customCallouts: [],
    calibration: { ...p.calibration, mode: p.calibration.mode === 'measure' ? 'auto' : p.calibration.mode, measure: null },
  };
}
