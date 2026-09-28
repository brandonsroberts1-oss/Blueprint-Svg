import type { Vec } from '../geometry/vec';
import { createElement, defaultProject } from './defaults';
import type { HouseElement, Project } from './types';

/** Pixels per foot and ground line of the demo's virtual "photo". */
const PPF = 20;
const GROUND = 820;
const OX = 60;

const P = (x: number, y: number): Vec => ({ x: OX + x * PPF, y: GROUND - y * PPF });
const R = (x0: number, y0: number, x1: number, y1: number) => ({
  x: OX + x0 * PPF,
  y: GROUND - y1 * PPF,
  w: (x1 - x0) * PPF,
  h: (y1 - y0) * PPF,
});

/**
 * A two-story house with a front-gabled garage, a tall front gable, a covered
 * porch and a stone wainscot — similar to a typical builder elevation.
 */
export function demoProject(): Project {
  const p = defaultProject();
  const els: HouseElement[] = [];
  const add = (el: HouseElement, patch: Record<string, unknown> = {}) => {
    els.push({ ...el, ...patch } as HouseElement);
  };

  // Back to front.
  add(createElement('wall', [P(21, 0), P(47, 0), P(47, 20), P(21, 20)]), { name: 'Main house' });
  add(createElement('wall', [P(0, 0), P(21, 0), P(21, 10.6), P(0, 10.6)]), { name: 'Garage wing' });
  add(createElement('roof', [P(20.2, 19.6), P(47.8, 19.6), P(47.8, 28.6), P(20.2, 28.6)]), { name: 'Main roof' });
  add(createElement('gable', [P(-0.9, 10.6), P(21.9, 10.6), P(10.5, 19.4)]), { name: 'Garage gable', material: 'lap' });
  add(createElement('gable', [P(22.2, 19.6), P(38.8, 19.6), P(30.5, 30.4)]), { name: 'Front gable', material: 'shake' });
  add(createElement('gable', [P(38.2, 19.6), P(47.8, 19.6), P(43, 25.4)]), { name: 'Right gable', material: 'lap' });
  add(createElement('wall', [P(0, 0), P(47, 0), P(47, 3), P(0, 3)]), { name: 'Stone wainscot', material: 'stone', cornerBoards: false, foundation: false });
  add(createElement('roof', [P(27.4, 9.8), P(47.6, 9.8), P(47.6, 12.3), P(27.4, 12.3)]), { name: 'Porch roof', material: 'metal' });

  add(createElement('garage', R(2.4, 0, 18.6, 7.45)), { windows: true });
  add(createElement('window', R(8.2, 12.2, 12.8, 15.4)), { style: 'picture', grid: 'full', gridCols: 4, gridRows: 2, name: 'Garage gable window' });
  add(createElement('vent', R(29.2, 25.6, 31.8, 28.2)), { shape: 'half-round' });
  add(createElement('window', R(24.2, 12.6, 27.8, 17.6)), {});
  add(createElement('window', R(33.2, 12.6, 36.8, 17.6)), {});
  add(createElement('window', R(41.2, 12.6, 44.8, 17.6)), {});
  add(createElement('window', R(22.6, 3.4, 26.6, 8.6)), { units: 1, shutters: false });
  add(createElement('door', R(31.4, 1.33, 36.6, 9.1)), { style: 'craftsman', sidelights: 'right' });
  add(createElement('window', R(39.5, 3.4, 44.5, 8.6)), { units: 2 });
  add(createElement('light', R(30.3, 5.6, 30.9, 7.0)));
  add(createElement('column', R(27.6, 1.33, 28.5, 9.8)), { style: 'tapered' });
  add(createElement('column', R(46.5, 1.33, 47.4, 9.8)), { style: 'tapered' });
  add(createElement('steps', R(31.2, 0, 36.8, 1.33)));

  p.elements = els;
  p.groundY = GROUND;
  p.calibration = { mode: 'measure', measure: { a: P(2.4, 0), b: P(18.6, 0), lengthFt: 16.2 }, facadeWidthFt: null };
  p.property = {
    ...p.property,
    address: '1234 Maple Ridge Lane, Springfield, IL 62704',
    line1: '1234 Maple Ridge Lane',
    line2: 'Springfield, IL 62704',
    facts: { yearBuilt: 'Built 2004', livingArea: '2,640 sq ft', bedsBaths: '4 bed / 2.5 bath', lotSize: 'Lot 0.31 ac' },
    show: { yearBuilt: true, livingArea: true, bedsBaths: true, lotSize: true },
    stories: 2,
  };
  p.annotations = { ...p.annotations, elevationTag: 'C', projectName: 'The Anderson Residence' };
  return p;
}

/** Size of the demo's virtual photo canvas in pixels. */
export const DEMO_CANVAS = { width: OX * 2 + 48 * PPF, height: GROUND + 80 };
