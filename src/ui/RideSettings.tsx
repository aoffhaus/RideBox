import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../storage/db';

/** Settings the rider can change mid-ride. Add more fields here as needed. */
export type RideSettingsPatch = Partial<Pick<Settings, 'gradeExaggeration'>>;

interface Props {
  settings: Settings;
  /** Called (debounced while dragging) with the changed settings. */
  onChange: (patch: RideSettingsPatch) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 150;

/** Small in-ride settings popover. Changes apply live without leaving the ride. */
export function RideSettings({ settings, onChange, onClose }: Props) {
  const [s, setS] = useState<RideSettingsPatch>({ gradeExaggeration: settings.gradeExaggeration });
  const pending = useRef<RideSettingsPatch>({});
  const timer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) onChangeRef.current(patch);
  };
  const update = (patch: RideSettingsPatch) => {
    setS((prev) => ({ ...prev, ...patch }));
    pending.current = { ...pending.current, ...patch };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, DEBOUNCE_MS);
  };
  // apply anything still pending when the popover closes
  useEffect(() => flush, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const k = s.gradeExaggeration ?? settings.gradeExaggeration;
  return (
    <div className="ride-settings panel" role="dialog" aria-label="Ride settings">
      <div className="ride-settings-head">
        <span className="panel-title">Ride settings</span>
        <button className="ride-settings-close" onClick={onClose} aria-label="Close settings">
          ✕
        </button>
      </div>
      <div className="ride-settings-fields">
        <label className="field">
          <span>Grade exaggeration: {k.toFixed(1)}×</span>
          <input type="range" min={1} max={3} step={0.1} value={k} onChange={(e) => update({ gradeExaggeration: Number(e.target.value) })} />
          <small className="muted">Makes hills look steeper on screen, like Zwift. Visual only: resistance, speed and the grade readout stay true.</small>
        </label>
      </div>
    </div>
  );
}
