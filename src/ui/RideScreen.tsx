import { useCallback, useEffect, useRef, useState } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import { WorldView } from '../world/scene';
import type { CameraMode } from '../world/camera';
import { WorkoutChart } from './WorkoutChart';
import { intervalFtpFraction, toWatts, zoneFor } from '../workout/model';
import type { Settings } from '../storage/db';
import { r0 } from './format';
import { SimulatedTrainer } from '../ble/simulated';
import { ElevationProfile } from './ElevationProfile';
import { MiniMap } from './MiniMap';
import { RideSettings, type RideSettingsPatch } from './RideSettings';
import { RideHud } from './RideHud';

interface Props {
  session: RideSession;
  settings: Settings;
  onEnd: () => void;
  /** Persist settings changed from the in-ride settings popover. */
  onSettingsChange?: (s: Settings) => void;
}

export function RideScreen({ session, settings, onEnd, onSettingsChange }: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<WorldView | null>(null);
  const [snap, setSnap] = useState<Snapshot>(() => session.snapshot());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const getStats = useCallback(() => worldRef.current?.stats, []);
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const chartH = winH < 720 ? 76 : 110;
  // refs so the key handler (bound once) sees current modal state
  const modalRef = useRef({ help: false, end: false, settings: false });
  modalRef.current = { help: showHelp, end: confirmEnd, settings: showSettings };
  const engine = session.engine;
  const ftp = settings.ftp;

  // In-ride settings: apply visuals live, then persist like the Settings page.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const camModeRef = useRef<CameraMode>('chase');

  useEffect(() => {
    // dev aid: ?d=4500 starts the ride 4.5 km into the lap (handy for checking scenery)
    const d0 = Number(new URLSearchParams(window.location.search).get('d'));
    if (d0 > 0 && session.distance === 0) session.distance = d0;
    session.start();
    const id = window.setInterval(() => setSnap(session.snapshot()), 200);
    return () => {
      window.clearInterval(id);
      session.stop();
    };
  }, [session]);

  // The 3D view; rebuilt when the graphics quality changes (the ride keeps going).
  useEffect(() => {
    const cur = settingsRef.current;
    const view = new WorldView(viewRef.current!, session, settings.graphics, cur.gradeExaggeration);
    worldRef.current = view;
    view.setEffortReactions(cur.effortReactions);
    view.setSprintEffect(cur.sprintEffect);
    view.setCamera(camModeRef.current);
    return () => {
      camModeRef.current = view.cameraMode;
      worldRef.current = null;
      view.dispose();
    };
  }, [session, settings.graphics]);
  const applyRideSettings = useCallback(
    (patch: RideSettingsPatch) => {
      if (patch.gradeExaggeration != null) worldRef.current?.setGradeExaggeration(patch.gradeExaggeration);
      if (patch.effortReactions != null) worldRef.current?.setEffortReactions(patch.effortReactions);
      if (patch.sprintEffect != null) worldRef.current?.setSprintEffect(patch.sprintEffect);
      // a graphics change rebuilds the view via the effect above once the setting is saved
      onSettingsChange?.({ ...settingsRef.current, ...patch });
    },
    [onSettingsChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const sim = session.trainer instanceof SimulatedTrainer ? session.trainer : null;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          session.togglePause();
          break;
        case 'ArrowRight':
          session.skipInterval();
          break;
        case '+':
        case '=':
        case 'ArrowUp':
          e.preventDefault();
          session.adjustIntensity(1);
          break;
        case '-':
        case '_':
        case 'ArrowDown':
          e.preventDefault();
          session.adjustIntensity(-1);
          break;
        case 'e':
        case 'E':
          session.toggleErg();
          break;
        case 'l':
        case 'L':
          session.extendInterval(60);
          break;
        case 'k':
        case 'K':
          session.manualLap();
          break;
        case ']':
          if (sim) sim.manualPower += 10;
          break;
        case '[':
          if (sim) sim.manualPower = Math.max(0, sim.manualPower - 10);
          break;
        case '1':
        case '2':
        case '3':
          worldRef.current?.setCamera((['chase', 'close', 'first'] as CameraMode[])[Number(e.key) - 1]);
          break;
        case 'Escape':
          if (modalRef.current.settings) break; // the settings panel closes itself
          if (modalRef.current.help) setShowHelp(false);
          else setConfirmEnd(!modalRef.current.end);
          break;
        case '?':
          setShowHelp((h) => !h);
          break;
      }
      setSnap(session.snapshot());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const st = snap.workout;
  const iv = st?.interval;
  const ivColor = iv ? (iv.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(iv, ftp)).color) : '#9aa4b2';
  const k = (st?.intensity ?? 100) / 100;
  const ivDesc = (x: typeof iv) =>
    !x
      ? ''
      : x.free
        ? 'Free ride'
        : x.powerStart === x.powerEnd
          ? `${Math.round(toWatts(x.powerStart, x.unit, ftp) * k)} W`
          : `${Math.round(toWatts(x.powerStart, x.unit, ftp) * k)}→${Math.round(toWatts(x.powerEnd, x.unit, ftp) * k)} W`;

  return (
    <div className="ride" style={{ ['--chart-h' as string]: `${engine ? chartH : -24}px` }}>
      <div ref={viewRef} className="ride-view" />

      {/* Top centre: the main ride HUD card */}
      <div className="hud-top">
        <RideHud session={session} settings={settings} snap={snap} />
      </div>

      {/* Left: workout info */}
      <div className="hud-left panel">
        <div className="panel-title">{engine ? engine.workout.name : 'Free ride'}</div>
        <div className="row-badges">
          <span className={`badge ${snap.mode === 'erg' ? 'badge-erg' : 'badge-sim'}`}>{snap.mode === 'erg' ? 'ERG' : 'SIM'}</span>
          {engine && <span className="badge">Intensity {st?.intensity ?? 100}%</span>}
          {snap.paused && <span className="badge badge-warn">{snap.autoPaused ? 'Paused, pedal to resume' : 'Paused'}</span>}
          {!snap.started && <span className="badge badge-warn">Start pedaling to begin</span>}
        </div>
        {iv && (
          <div className="iv-now" style={{ borderColor: ivColor }}>
            <div className="iv-label">{iv.label ?? (iv.free ? 'Free ride' : zoneFor(intervalFtpFraction(iv, ftp)).name)}</div>
            <div className="iv-target">{ivDesc(iv)}{!iv.free && ` · ${Math.round(intervalFtpFraction(iv, ftp) * 100 * k)}% FTP`}</div>
          </div>
        )}
        {snap.intervalStats && (
          <table className="iv-stats">
            <tbody>
              <tr><td>Avg power</td><td>{r0(snap.intervalStats.avgPower)} W</td></tr>
              <tr><td>Avg HR</td><td>{r0(snap.intervalStats.avgHr)} bpm</td></tr>
              <tr><td>Avg cadence</td><td>{r0(snap.intervalStats.avgCadence)} rpm</td></tr>
            </tbody>
          </table>
        )}
        {st?.finished && <div className="iv-done">Workout complete 🎉 Keep riding to cool down, or End ride.</div>}
      </div>

      {st?.cue && <div className="cue">{st.cue}</div>}

      {/* Right column: map, controls, road ahead — stacked so they can never overlap */}
      <div className="hud-right" style={{ bottom: engine ? chartH + 32 : 12 }}>
        <MiniMap session={session} settings={settings} snap={snap} />

        <div className="hud-controls">
          <button className="span2" onClick={() => session.togglePause()}>{snap.paused && !snap.autoPaused ? '▶ Resume' : '⏸ Pause'}</button>
          {engine && (
            <>
              <button onClick={() => session.adjustIntensity(-1)} title="Intensity −1% (− key)">−1%</button>
              <button onClick={() => session.adjustIntensity(1)} title="Intensity +1% (+ key)">+1%</button>
              <button onClick={() => session.toggleErg()} title="E key">{snap.ergOn ? 'ERG on' : 'ERG off'}</button>
              <button onClick={() => session.extendInterval(60)} title="L key">+1 min</button>
              <button onClick={() => session.skipInterval()} title="→ key">Skip ⏭</button>
            </>
          )}
          <button onClick={() => setShowSettings((v) => !v)} title="Ride settings" aria-label="Ride settings" aria-expanded={showSettings}>⚙ Settings</button>
          <button onClick={() => setShowHelp((h) => !h)} title="Keyboard shortcuts">? Keys</button>
          <button className="danger span2" onClick={() => setConfirmEnd(true)} title="Esc key">End ride</button>
        </div>

        <div className="hud-elev">
          <ElevationProfile route={session.route} distance={snap.distance} settings={settings} />
        </div>
      </div>

      {engine && (
        <div className="hud-bottom">
          <WorkoutChart
            intervals={engine.intervals}
            ftp={ftp}
            height={chartH}
            elapsed={st?.elapsed}
            samples={session.samples}
            maxHr={settings.maxHr}
            currentIndex={st?.index}
            intensity={st?.intensity}
          />
        </div>
      )}

      {showSettings && <RideSettings settings={settings} onChange={applyRideSettings} onClose={closeSettings} getStats={getStats} />}

      {showHelp && (
        <div className="modal-bg" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <table className="keys">
              <tbody>
                <tr><td>Space</td><td>Pause / resume</td></tr>
                <tr><td>Esc</td><td>End ride (asks to confirm)</td></tr>
                <tr><td>1 / 2 / 3</td><td>Camera: chase (default) / close chase / first person</td></tr>
                <tr><td>+ / − (or ↑ / ↓)</td><td>Intensity ±1%</td></tr>
                <tr><td>→</td><td>Skip to next interval</td></tr>
                <tr><td>L</td><td>Extend current interval by 1 min</td></tr>
                <tr><td>E</td><td>Toggle ERG (off = SIM/slope mode, you control power)</td></tr>
                <tr><td>K</td><td>Manual lap (free ride)</td></tr>
                <tr><td>[ / ]</td><td>Simulated trainer power −/+10 W</td></tr>
              </tbody>
            </table>
            <button onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </div>
      )}

      {confirmEnd && (
        <div className="modal-bg">
          <div className="modal">
            <h3>End ride?</h3>
            <p>Your ride will be saved and you can download the .fit file.</p>
            <div className="row">
              <button onClick={() => setConfirmEnd(false)}>Keep riding</button>
              <button className="primary" onClick={onEnd}>End &amp; save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
