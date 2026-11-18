import { useEffect, useRef, useState } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import { WorldView } from '../world/scene';
import type { CameraMode } from '../world/camera';
import { WorkoutChart } from './WorkoutChart';
import { formatDuration, intervalFtpFraction, toWatts, zoneFor } from '../workout/model';
import type { Settings } from '../storage/db';
import { distUnit, elevUnit, fmtDist, fmtElev, fmtSpeed, hrZoneColor, r0, speedUnit } from './format';
import { SimulatedTrainer } from '../ble/simulated';
import { ElevationProfile, gradeColor } from './ElevationProfile';
import { MiniMap } from './MiniMap';
import { IntervalHero } from './IntervalHero';

interface Props {
  session: RideSession;
  settings: Settings;
  onEnd: () => void;
}

function Tile({ label, value, unit, sub, color, big }: { label: string; value: string; unit?: string; sub?: React.ReactNode; color?: string; big?: boolean }) {
  return (
    <div className={`tile ${big ? 'tile-big' : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value" style={{ color }}>
        {value}
        {unit && <span className="tile-unit">{unit}</span>}
      </div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function RideScreen({ session, settings, onEnd }: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<WorldView | null>(null);
  const [snap, setSnap] = useState<Snapshot>(() => session.snapshot());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const engine = session.engine;
  const ftp = settings.ftp;

  useEffect(() => {
    const view = new WorldView(viewRef.current!, session, settings.graphics, settings.gradeExaggeration);
    worldRef.current = view;
    session.start();
    const id = window.setInterval(() => setSnap(session.snapshot()), 200);
    return () => {
      window.clearInterval(id);
      session.stop();
      view.dispose();
    };
  }, [session]);

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
  const target = st?.targetWatts ?? null;
  const p3 = snap.power3s;
  const diff = target ? p3 - target : 0;
  const compliance = !target ? undefined : Math.abs(diff) <= target * 0.05 ? '#27ae60' : diff > 0 ? '#f2994a' : '#2f80ed';
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
    <div className="ride">
      <div ref={viewRef} className="ride-view" />

      {/* Top: metric tiles either side of the interval hero */}
      <div className="hud-top">
        <div className="tiles tiles-l">
          <Tile big label="POWER 3s" value={r0(p3)} unit="W" color={compliance} sub={target != null ? <>target <b>{target}</b> W</> : snap.mode === 'sim' ? `SIM ${(snap.grade * 100).toFixed(1)}%` : ''} />
          <Tile big label="HEART RATE" value={r0(snap.hr)} unit="bpm" color={hrZoneColor(snap.hr, settings.maxHr)} sub={snap.hr ? `${Math.round((snap.hr / settings.maxHr) * 100)}% max` : 'no HRM'} />
          <Tile big label="CADENCE" value={r0(snap.cadence)} unit="rpm" sub={iv?.cadence ? `target ${iv.cadence}` : ''} />
        </div>
        <div className="hud-hero">
          <IntervalHero session={session} settings={settings} snap={snap} />
        </div>
        <div className="tiles tiles-r">
          <Tile label="ELAPSED" value={formatDuration(snap.elapsed)} sub={st && !st.finished ? `${formatDuration(st.totalRemaining)} left` : ''} />
          <Tile label="SPEED" value={fmtSpeed(snap.speed, settings)} unit={speedUnit(settings)} sub={`${fmtDist(snap.distance, settings)} ${distUnit(settings)}`} />
          <Tile label="GRADE" value={(snap.grade * 100).toFixed(1)} unit="%" color={gradeColor(snap.grade)} sub={`${fmtElev(snap.altitude, settings)} ${elevUnit(settings)}`} />
        </div>
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

      <div className="hud-map">
        <MiniMap session={session} settings={settings} snap={snap} />
      </div>

      <div className={`hud-elev ${engine ? '' : 'no-chart'}`}>
        <ElevationProfile route={session.route} distance={snap.distance} settings={settings} />
      </div>

      {/* Controls */}
      <div className="hud-controls">
        <button onClick={() => session.togglePause()}>{snap.paused && !snap.autoPaused ? '▶ Resume' : '⏸ Pause'}</button>
        {engine && (
          <>
            <button onClick={() => session.adjustIntensity(-1)} title="Intensity −1% (− key)">−1%</button>
            <button onClick={() => session.adjustIntensity(1)} title="Intensity +1% (+ key)">+1%</button>
            <button onClick={() => session.toggleErg()} title="E key">{snap.ergOn ? 'ERG on' : 'ERG off'}</button>
            <button onClick={() => session.extendInterval(60)} title="L key">+1 min</button>
            <button onClick={() => session.skipInterval()} title="→ key">Skip ⏭</button>
          </>
        )}
        <button onClick={() => setShowHelp((h) => !h)}>?</button>
        <button className="danger" onClick={() => setConfirmEnd(true)}>End ride</button>
      </div>

      {engine && (
        <div className="hud-bottom">
          <WorkoutChart
            intervals={engine.intervals}
            ftp={ftp}
            height={110}
            elapsed={st?.elapsed}
            samples={session.samples}
            maxHr={settings.maxHr}
            currentIndex={st?.index}
            intensity={st?.intensity}
          />
        </div>
      )}

      {showHelp && (
        <div className="modal-bg" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <table className="keys">
              <tbody>
                <tr><td>Space</td><td>Pause / resume</td></tr>
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
