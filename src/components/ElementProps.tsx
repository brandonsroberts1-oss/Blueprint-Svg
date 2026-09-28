import {
  CHIMNEY_MATERIALS,
  COLUMN_STYLES,
  DOOR_STYLES,
  GARAGE_STYLES,
  GRID_STYLES,
  KIND_INFO,
  ROOF_MATERIALS,
  SIDELIGHTS,
  VENT_SHAPES,
  WALL_MATERIALS,
  WINDOW_STYLES,
} from '../lib/model/defaults';
import type { HouseElement } from '../lib/model/types';
import { useStore } from '../state/store';

type Opt<T extends string> = { id: T; label: string };

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Opt<T>[]; onChange: (v: T) => void }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Num({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <label title={hint}>
      {label}
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0))))} />
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function ElementProps({ el }: { el: HouseElement }) {
  const { update } = useStore();
  const set = (patch: Partial<HouseElement>) => update((p) => ({ ...p, elements: p.elements.map((e) => (e.id === el.id ? ({ ...e, ...patch } as HouseElement) : e)) }), { mergeKey: `props-${el.id}` });

  let fields: React.ReactNode = null;
  switch (el.kind) {
    case 'wall':
      fields = (
        <>
          <Select label="Material" value={el.material} options={WALL_MATERIALS} onChange={(material) => set({ material })} />
          <Num label='Exposure / course (in, 0 = auto)' value={el.exposureIn} min={0} max={24} onChange={(exposureIn) => set({ exposureIn })} />
          <Check label="Corner boards" value={el.cornerBoards} onChange={(cornerBoards) => set({ cornerBoards })} />
          <Check label="Exposed foundation band" value={el.foundation} onChange={(foundation) => set({ foundation })} />
        </>
      );
      break;
    case 'gable':
      fields = (
        <>
          <Select label="Infill material" value={el.material} options={WALL_MATERIALS} onChange={(material) => set({ material })} />
          <Num label="Exposure (in, 0 = auto)" value={el.exposureIn} min={0} max={24} onChange={(exposureIn) => set({ exposureIn })} />
          <Num label="Rake trim width (in)" value={el.rakeIn} min={2} max={24} onChange={(rakeIn) => set({ rakeIn })} />
        </>
      );
      break;
    case 'roof':
      fields = (
        <>
          <Select label="Roofing" value={el.material} options={ROOF_MATERIALS} onChange={(material) => set({ material })} />
          <Check label="Fascia & gutter at eaves" value={el.fascia} onChange={(fascia) => set({ fascia })} />
        </>
      );
      break;
    case 'chimney':
      fields = <Select label="Material" value={el.material} options={CHIMNEY_MATERIALS} onChange={(material) => set({ material })} />;
      break;
    case 'window':
      fields = (
        <>
          <Select label="Style" value={el.style} options={WINDOW_STYLES} onChange={(style) => set({ style })} />
          <Select label="Grilles" value={el.grid} options={GRID_STYLES} onChange={(grid) => set({ grid })} />
          <div className="grid2">
            <Num label="Panes across (0 = auto)" value={el.gridCols} min={0} max={8} onChange={(gridCols) => set({ gridCols })} />
            <Num label="Panes down (0 = auto)" value={el.gridRows} min={0} max={6} onChange={(gridRows) => set({ gridRows })} />
          </div>
          <Num label="Units side by side" value={el.units} min={1} max={8} onChange={(units) => set({ units })} />
          <div className="checks">
            <Check label="Trim" value={el.trim} onChange={(trim) => set({ trim })} />
            <Check label="Sill" value={el.sill} onChange={(sill) => set({ sill })} />
            <Check label="Header" value={el.header} onChange={(header) => set({ header })} />
            <Check label="Shutters" value={el.shutters} onChange={(shutters) => set({ shutters })} />
          </div>
        </>
      );
      break;
    case 'door':
      fields = (
        <>
          <Select label="Style" value={el.style} options={DOOR_STYLES} onChange={(style) => set({ style })} />
          <Select label="Sidelights" value={el.sidelights} options={SIDELIGHTS} onChange={(sidelights) => set({ sidelights })} />
          <div className="checks">
            <Check label="Transom" value={el.transom} onChange={(transom) => set({ transom })} />
            <Check label="Trim" value={el.trim} onChange={(trim) => set({ trim })} />
          </div>
        </>
      );
      break;
    case 'garage':
      fields = (
        <>
          <Select label="Style" value={el.style} options={GARAGE_STYLES} onChange={(style) => set({ style })} />
          <div className="grid2">
            <Num label="Sections" value={el.sections} min={1} max={8} onChange={(sections) => set({ sections })} />
            <Num label="Panels (0 = auto)" value={el.panels} min={0} max={16} onChange={(panels) => set({ panels })} />
          </div>
          <div className="checks">
            <Check label="Windows in top section" value={el.windows} onChange={(windows) => set({ windows })} />
            <Check label="Trim" value={el.trim} onChange={(trim) => set({ trim })} />
          </div>
        </>
      );
      break;
    case 'vent':
      fields = <Select label="Shape" value={el.shape} options={VENT_SHAPES} onChange={(shape) => set({ shape })} />;
      break;
    case 'column':
      fields = <Select label="Style" value={el.style} options={COLUMN_STYLES} onChange={(style) => set({ style })} />;
      break;
    case 'steps':
      fields = <Num label="Risers (0 = auto)" value={el.count} min={0} max={20} onChange={(count) => set({ count })} />;
      break;
    default:
      fields = null;
  }

  return (
    <div className="props">
      <label>
        Name
        <input value={el.name ?? ''} placeholder={KIND_INFO[el.kind].label} onChange={(e) => set({ name: e.target.value })} />
      </label>
      {fields}
    </div>
  );
}
