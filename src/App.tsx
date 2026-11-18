import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnState, HeartRateMonitor, Trainer } from './ble/types';
import { bluetoothAvailable, pairHeartRate, pairTrainer } from './ble/bluetooth';
import { SimulatedHrm, SimulatedTrainer } from './ble/simulated';
import { RideSession } from './app/session';
import type { RideRecord } from './app/recorder';
import { DEFAULT_SETTINGS, getFlag, listRides, listWorkouts, loadSettings, saveRide, saveSettings, saveWorkout, setFlag, uid, type Settings, type StoredWorkout } from './storage/db';
import { BUILTIN_WORKOUTS } from './workout/builtin';
import { flatten, formatDuration, plannedStats } from './workout/model';
import { ROUTE_PRESETS, generateRoute, type Route, type RoutePresetId } from './world/route';
import { RideScreen } from './ui/RideScreen';
import { Library } from './ui/Library';
import { Builder } from './ui/Builder';
import { Summary } from './ui/Summary';
import { History } from './ui/History';
import { SettingsPage } from './ui/SettingsPage';
import { WorkoutChart } from './ui/WorkoutChart';
import { distUnit, elevUnit, fmtDist, fmtElev } from './ui/format';

type Tab = 'ride' | 'workouts' | 'history' | 'settings';

function StatusDot({ s }: { s: ConnState }) {
  return <span className={`dot dot-${s}`} title={s} />;
}

function RouteProfile({ r }: { r: Route }) {
  const n = r.y.length;
  let min = Infinity;
  let max = -Infinity;
  for (const y of r.y) {
    min = Math.min(min, y);
    max = Math.max(max, y);
  }
  const H = 40;
  const span = Math.max(30, max - min);
  let d = `M0,${H}`;
  for (let i = 0; i < n; i += Math.ceil(n / 200)) d += ` L${((i / n) * 200).toFixed(1)},${(H - ((r.y[i] - min) / span) * (H - 4)).toFixed(1)}`;
  d += ` L200,${H} Z`;
  return (
    <svg viewBox={`0 0 200 ${H}`} preserveAspectRatio="none" className="route-profile">
      <path d={d} fill="rgba(111,160,74,0.7)" stroke="#9fd17a" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>('ride');
  const [workouts, setWorkouts] = useState<StoredWorkout[]>([]);
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [trainer, setTrainer] = useState<Trainer | null>(null);
  const [trainerState, setTrainerState] = useState<ConnState>('disconnected');
  const [hrm, setHrm] = useState<HeartRateMonitor | null>(null);
  const [hrmState, setHrmState] = useState<ConnState>('disconnected');
  const [selected, setSelected] = useState<string>('free');
  const [route, setRoute] = useState<RoutePresetId>('rolling');
  const [session, setSession] = useState<RideSession | null>(null);
  const [summary, setSummary] = useState<RideRecord | null>(null);
  const [editing, setEditing] = useState<StoredWorkout | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [livePower, setLivePower] = useState<number | null>(null);
  const [liveHr, setLiveHr] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setWorkouts(await listWorkouts());
    setRides(await listRides());
  }, []);

  useEffect(() => {
    (async () => {
      setSettings(await loadSettings());
      if (!(await getFlag('seeded-v1'))) {
        let t = Date.now() - BUILTIN_WORKOUTS.length;
        for (const w of BUILTIN_WORKOUTS) await saveWorkout({ id: uid(), workout: w, source: 'builtin', createdAt: t++ });
        await setFlag('seeded-v1', true);
      }
      await refresh();
    })();
  }, [refresh]);

  // live readouts on the home screen
  useEffect(() => {
    if (!trainer || session) return;
    const h = (d: { power: number }) => setLivePower(d.power);
    trainer.onData = h;
    return () => {
      // only detach our own handler (a ride session may have installed its own)
      if (trainer.onData === h) trainer.onData = undefined;
    };
  }, [trainer, session]);
  useEffect(() => {
    if (!hrm || session) return;
    const h = (b: number) => setLiveHr(b);
    hrm.onHeartRate = h;
    return () => {
      if (hrm.onHeartRate === h) hrm.onHeartRate = undefined;
    };
  }, [hrm, session]);
  const routes = useMemo(() => ROUTE_PRESETS.map((p) => ({ p, r: generateRoute(p.id, 1) })), []);

  async function connectTrainer() {
    setError('');
    try {
      trainer?.disconnect();
      const t = await pairTrainer(() => settings.riderKg, setTrainerState);
      setTrainer(t);
    } catch (e) {
      if ((e as Error).name !== 'NotFoundError') setError(`Trainer: ${(e as Error).message}`);
      setTrainerState(trainer ? trainerState : 'disconnected');
    }
  }
  async function connectHrm() {
    setError('');
    try {
      hrm?.disconnect();
      const h = await pairHeartRate(setHrmState);
      setHrm(h);
    } catch (e) {
      if ((e as Error).name !== 'NotFoundError') setError(`Heart rate: ${(e as Error).message}`);
    }
  }
  function useSimulator() {
    trainer?.disconnect();
    hrm?.disconnect();
    const t = new SimulatedTrainer();
    t.onState = setTrainerState;
    const h = new SimulatedHrm(t);
    h.onState = setHrmState;
    setTrainer(t);
    setHrm(h);
  }

  function startRide(workoutId = selected) {
    if (!trainer) {
      setError('Connect your trainer (or use the simulator) first.');
      setTab('ride');
      return;
    }
    const sw = workouts.find((w) => w.id === workoutId);
    const s = new RideSession({
      trainer,
      hrm,
      settings,
      workout: sw?.workout,
      routePreset: route,
      routeSeed: 1,
    });
    setSession(s);
  }

  async function endRide() {
    if (!session) return;
    const rec = session.finish();
    if (rec.samples.length > 10) {
      await saveRide(rec);
      setSummary(rec);
    }
    setSession(null);
    void refresh();
    setTab('history');
  }

  async function updateSettings(s: Settings) {
    setSettings(s);
    await saveSettings(s);
  }

  if (session) return <RideScreen session={session} settings={settings} onEnd={endRide} onSettingsChange={updateSettings} />;

  const sel = workouts.find((w) => w.id === selected);
  const selIv = sel ? flatten(sel.workout) : [];
  const selStats = sel ? plannedStats(selIv, settings.ftp) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🚴 RideBox</div>
        <nav>
          {(['ride', 'workouts', 'history', 'settings'] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t && !summary && editing === undefined ? 'active' : ''}
              onClick={() => {
                setTab(t);
                setSummary(null);
                setEditing(undefined);
              }}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <div className="devices">
          <span className="device">
            <StatusDot s={trainerState} /> {trainer ? trainer.name : 'No trainer'}
            {trainer && livePower != null && <b> {livePower} W</b>}
            <button onClick={connectTrainer} disabled={!bluetoothAvailable()}>{trainer && trainer.kind !== 'simulated' ? 'Reconnect' : 'Connect trainer'}</button>
          </span>
          <span className="device">
            <StatusDot s={hrmState} /> {hrm ? hrm.name : 'No HRM'}
            {hrm && liveHr != null && <b> {liveHr} bpm</b>}
            <button onClick={connectHrm} disabled={!bluetoothAvailable()}>{hrm && !(hrm instanceof SimulatedHrm) ? 'Reconnect' : 'Connect HRM'}</button>
          </span>
          <button className="ghost" onClick={useSimulator} title="Try the app without hardware">Simulator</button>
        </div>
      </header>

      {!bluetoothAvailable() && (
        <div className="banner">This browser doesn&apos;t support Web Bluetooth. Open RideBox in <b>Chrome</b> (or Edge) on your Mac. The simulator still works here.</div>
      )}
      {error && (
        <div className="banner err" onClick={() => setError('')}>
          {error}
        </div>
      )}

      {summary ? (
        <Summary ride={summary} settings={settings} onClose={() => setSummary(null)} />
      ) : editing !== undefined ? (
        <Builder
          initial={editing}
          ftp={settings.ftp}
          onDone={() => {
            setEditing(undefined);
            void refresh();
          }}
        />
      ) : tab === 'ride' ? (
        <div className="page">
          <h2>Workout</h2>
          <div className="row">
            <select className="grow" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="free">Free ride (no workout, SIM mode)</option>
              {workouts.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.workout.name} ({formatDuration(plannedStats(flatten(w.workout), settings.ftp).duration)})
                </option>
              ))}
            </select>
            <button onClick={() => setTab('workouts')}>Manage workouts</button>
          </div>
          {sel && selStats && (
            <div className="card">
              <div className="muted small">
                {formatDuration(selStats.duration)} · TSS {Math.round(selStats.tss)} · IF {selStats.if.toFixed(2)} · FTP {settings.ftp} W
              </div>
              <WorkoutChart intervals={selIv} ftp={settings.ftp} height={90} />
              {sel.workout.description && <div className="muted small desc">{sel.workout.description}</div>}
            </div>
          )}

          <h2>Route</h2>
          <div className="route-grid">
            {routes.map(({ p, r }) => {
              return (
                <button key={p.id} className={`route-card ${route === p.id ? 'selected' : ''}`} onClick={() => setRoute(p.id)}>
                  <div className="card-title">{p.name}</div>
                  <div className="muted small">
                    {fmtDist(r.length, settings)} {distUnit(settings)} · {fmtElev(r.totalClimb, settings)} {elevUnit(settings)} · {p.description}
                  </div>
                  <RouteProfile r={r} />
                </button>
              );
            })}
          </div>

          <div className="start-row">
            <button className="primary big" onClick={() => startRide()} disabled={!trainer}>
              {trainer ? 'Start ride ▶' : 'Connect a trainer to start'}
            </button>
            {!trainer && <span className="muted small">No hardware handy? Click <b>Simulator</b> at the top right to try it.</span>}
          </div>
        </div>
      ) : tab === 'workouts' ? (
        <Library
          workouts={workouts}
          ftp={settings.ftp}
          onChange={refresh}
          onEdit={(w) => setEditing(w)}
          onRide={(w) => {
            setSelected(w.id);
            setTab('ride');
          }}
        />
      ) : tab === 'history' ? (
        <History rides={rides} settings={settings} onOpen={setSummary} onChange={refresh} />
      ) : (
        <SettingsPage
          settings={settings}
          onSave={updateSettings}
        />
      )}
    </div>
  );
}
