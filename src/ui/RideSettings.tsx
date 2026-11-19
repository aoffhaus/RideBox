import { useEffect, useRef, useState } from 'react';
import { reactLabel, type Settings } from '../storage/db';

/** Settings the rider can change mid-ride. Add more fields here as needed. */
export type RideSettingsPatch = Partial<Pick<Settings, 'gradeExaggeration' | 'effortReactions' | 'sprintEffect' | 'graphics'>>;

export interface RenderStats {
  fps: number;
  pixelRatio: number;
  ao: boolean;
  level: number;
  levels: number;
}

interface Props {
  settings: Settings;
  /** Called (debounced while dragging) with the changed settings. */
  onChange: (patch: RideSettingsPatch) => void;
  onClose: () => void;
  /** Live frame rate / render resolution from the 3D view. */
  getStats?: () => RenderStats | undefined;
}

const DEBOUNCE_MS = 150;

/** Small in-ride settings popover. Changes apply live without leaving the ride. */
export function RideSettings({ settings, onChange, onClose, getStats }: Props) {
  const [s, setS] = useState<RideSettingsPatch>({
    gradeExaggeration: settings.gradeExaggeration,
    effortReactions: settings.effortReactions,
    sprintEffect: settings.sprintEffect,
    graphics: settings.graphics,
  });
  const [stats, setStats] = useState<RenderStats | undefined>(() => getStats?.());
  const getStatsRef = useRef(getStats);
  getStatsRef.current = getStats;
  useEffect(() => {
    const id = window.setInterval(() => setStats(getStatsRef.current?.()), 500);
    return () => window.clearInterval(id);
  }, []);
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
  const react = s.effortReactions ?? settings.effortReactions;
  const sprint = s.sprintEffect ?? settings.sprintEffect;
  const graphics = s.graphics ?? settings.graphics;
  const fps = stats && stats.fps > 0 ? Math.round(stats.fps) : null;
  const fpsClass = fps == null ? 'muted' : fps >= 55 ? 'fps-good' : fps >= 40 ? 'fps-ok' : 'fps-bad';
  const res = stats ? `${Math.round(stats.pixelRatio * 100)}% resolution${graphics === 'high' && !stats.ao ? ', ambient occlusion off' : ''}${stats.level > 0 ? ' (detail lowered to keep it smooth)' : ''}` : '';
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
        <div className="field">
          <span>
            Frame rate: <b className={`fps ${fpsClass}`}>{fps == null ? 'measuring…' : `${fps} fps`}</b>
          </span>
          {res && <small className="muted">{res}</small>}
        </div>
        <label className="field">
          <span>Graphics quality</span>
          <select value={graphics} onChange={(e) => update({ graphics: e.target.value as Settings['graphics'] })}>
            <option value="high">High (shadows, effects)</option>
            <option value="low">Low (older or slower computers)</option>
          </select>
          <small className="muted">Resolution drops automatically if the frame rate dips. Switch to Low if it&apos;s still choppy.</small>
        </label>
        <label className="field">
          <span>Effort reactions: {reactLabel(react)}</span>
          <input type="range" min={0} max={1.5} step={0.05} value={react} onChange={(e) => update({ effortReactions: Number(e.target.value) })} />
          <small className="muted">Long hard efforts slowly build wind, cloud and colour.</small>
        </label>
        <label className="field">
          <span>Sprint effect: {reactLabel(sprint)}</span>
          <input type="range" min={0} max={1.5} step={0.05} value={sprint} onChange={(e) => update({ sprintEffect: Number(e.target.value) })} />
          <small className="muted">The rush of speed when you sprint: motion blur, a wider view and a flare of glow.</small>
        </label>
      </div>
    </div>
  );
}
