import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnState, HeartRateMonitor, Trainer } from './ble/types';
import { bluetoothAvailable, pairHeartRate, pairTrainer } from './ble/bluetooth';
import { SimulatedHrm, SimulatedTrainer } from './ble/simulated';
import { RideSession } from './app/session';
import type { RideRecord } from './app/recorder';
import { DEFAULT_SETTINGS, deleteOne, deleteRide, getFlag, listAll, listRides, putOne, listWorkouts, loadSettings, saveRide, saveSettings, saveWorkout, setFlag, uid, type Settings, type StoredWorkout } from './storage/db';
import { BUILTIN_WORKOUTS } from './workout/builtin';
import { flatten, formatDuration, plannedStats } from './workout/model';
import { ROUTE_PRESETS, generateRoute, type Route, type RoutePresetId } from './world/route';
import { ROUTE_IMAGES } from './world/routeImages';
import { RideScreen } from './ui/RideScreen';
import { Library } from './ui/Library';
import { Builder } from './ui/Builder';
import { Summary } from './ui/Summary';
import { History } from './ui/History';
import { SettingsPage } from './ui/SettingsPage';
import { WorkoutChart } from './ui/WorkoutChart';
import { distUnit, elevUnit, fmtDist, fmtElev } from './ui/format';
import { DEFAULT_STRAVA, canReadActivities, completeOAuth, initStrava, isConnected, loadStrava, parseOAuthReturn, parseServerReturn, type StravaConfig } from './strava/strava';
import { renameRide, uploadRide } from './strava/uploadRide';
import { sync, type SyncStatus } from './storage/sync';
import { importStravaActivities } from './strava/activities';
import type { PlannedWorkout, StravaActivity, TrainingPlan } from './training/model';
import { reconcile } from './training/calendar';
import { today } from './training/load';
import { Calendar } from './ui/Calendar';
import { computeLevels, ZONE_NAMES } from './training/levels';
import { LevelsCard } from './ui/Levels';
import { adaptSuggestion, type CoachState, type PlanResult } from './training/coach';
import type { AdaptInput } from './training/coachSchema';
import { addDays } from './training/load';
import { newPlanned } from './training/calendar';
import { AdaptReview, PlanBuilder, TodayCard } from './ui/Coach';
import type { Workout } from './workout/model';
import { Fitness } from './ui/Fitness';
import { MobileApp } from './mobile/MobileApp';

const PHONE_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px)';
const DESKTOP_KEY = 'ridebox-force-desktop';
function readForceDesktop() {
  try {
    return localStorage.getItem(DESKTOP_KEY) === '1';
  } catch {
    return false;
  }
}
function writeForceDesktop(on: boolean) {
  try {
    if (on) localStorage.setItem(DESKTOP_KEY, '1');
    else localStorage.removeItem(DESKTOP_KEY);
  } catch {
    /* private mode */
  }
}
/** Phones (and small tablets) get the schedule-only layout. */
function useIsPhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const h = () => setPhone(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return phone;
}

// Strava's OAuth redirect lands here with ?state=…&code=…; read it once (effects can run twice).
let pendingOAuth = parseOAuthReturn(location.search);
// on the private site the Worker runs the sign-in and comes back with ?strava=connected|error
let serverReturn = parseServerReturn(location.search);
if (pendingOAuth || serverReturn) history.replaceState(null, '', location.pathname);

const SYNC_LABEL: Record<SyncStatus, string> = { off: '', syncing: '⟳ Syncing', synced: '✓ Synced', offline: '⚠ Offline', error: '⚠ Sync error' };

type Tab = 'ride' | 'calendar' | 'workouts' | 'fitness' | 'history' | 'settings';
const TABS: Tab[] = ['ride', 'calendar', 'workouts', 'fitness', 'history', 'settings'];

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
  const [acts, setActs] = useState<StravaActivity[]>([]);
  const [calendar, setCalendar] = useState<PlannedWorkout[]>([]);
  const [plans, setPlans] = useState<TrainingPlan[]>([]);
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
  const [pairHelp, setPairHelp] = useState<'trainer' | 'hrm' | null>(null);
  const [livePower, setLivePower] = useState<number | null>(null);
  const [liveHr, setLiveHr] = useState<number | null>(null);
  const [strava, setStrava] = useState<StravaConfig>(DEFAULT_STRAVA);
  const [notice, setNotice] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('off');
  const [planBuilder, setPlanBuilder] = useState(false);
  const [adapt, setAdapt] = useState<AdaptInput | null>(null);
  const [lastReview, setLastReview] = useState<string | undefined>();
  const isPhone = useIsPhone();
  const [forceDesktop, setForceDesktop] = useState(readForceDesktop);

  const refresh = useCallback(async () => {
    setWorkouts(await listWorkouts());
    const rs = await listRides();
    const as = await listAll<StravaActivity>('strava_acts');
    let cal = await listAll<PlannedWorkout>('calendar');
    // link finished rides to planned workouts, mark unridden past days missed
    const s = await loadSettings();
    const changed = reconcile(cal, rs, as, (p) => plannedStats(flatten(p.workout), s.ftp).duration, today());
    if (changed.length) {
      for (const c of changed) await putOne('calendar', c);
      const byId = new Map(changed.map((c) => [c.id, c]));
      cal = cal.map((c) => byId.get(c.id) ?? c);
    }
    setRides(rs);
    setActs(as);
    setCalendar(cal);
    setPlans(await listAll<TrainingPlan>('plans'));
    setLastReview((await getFlag('coach-last-review')) as string | undefined);
  }, []);

  // today's planned workout is the default pick on the Ride tab
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !calendar.length) return;
    preselected.current = true;
    const first = calendar.filter((c) => c.date === today() && c.status === 'planned').sort((x, y) => (x.order ?? 0) - (y.order ?? 0))[0];
    if (first) setSelected((cur) => (cur === 'free' ? `cal:${first.id}` : cur));
  }, [calendar]);

  const saveCalendar = useCallback(async (items: PlannedWorkout[]) => {
    const byId = new Map(items.map((c) => [c.id, c]));
    setCalendar((cal) => [...cal.filter((c) => !byId.has(c.id)), ...items]);
    for (const c of items) await putOne('calendar', c);
  }, []);
  const deleteCalendar = useCallback(async (ids: string[]) => {
    setCalendar((cal) => cal.filter((c) => !ids.includes(c.id)));
    for (const id of ids) await deleteOne('calendar', id);
  }, []);

  useEffect(() => sync.onStatus(setSyncStatus), []);
  useEffect(
    () =>
      sync.onRemoteChange(async () => {
        // another browser changed something: reload what's on screen
        setSettings(await loadSettings());
        setStrava(await loadStrava());
        await refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    (async () => {
      // pull from the private backend first so this browser starts from the shared data
      await sync.start();
      await initStrava();
      setSettings(await loadSettings());
      let sc = await loadStrava();
      setStrava(sc);
      const sret = serverReturn;
      serverReturn = null;
      if (sret) {
        setTab('settings');
        if ('error' in sret) setError(`Strava: ${sret.error}`);
        else setNotice(`Strava connected${sc.athleteName ? ` as ${sc.athleteName}` : ''}. Upload rides from their summary page.`);
      }
      // returning from Strava's authorization page?
      const ret = pendingOAuth;
      pendingOAuth = null;
      if (ret) {
        setTab('settings');
        try {
          if ('error' in ret) throw new Error(ret.error);
          sc = await completeOAuth(sc, ret);
          setStrava(sc);
          setNotice(`Strava connected${sc.athleteName ? ` as ${sc.athleteName}` : ''}. Upload rides from their summary page.`);
        } catch (e) {
          setError(`Strava: ${(e as Error).message}`);
        }
      }
      if (!(await getFlag('seeded-v1'))) {
        let t = Date.now() - BUILTIN_WORKOUTS.length;
        for (const w of BUILTIN_WORKOUTS) await saveWorkout({ id: uid(), workout: w, source: 'builtin', createdAt: t++ });
        await setFlag('seeded-v1', true);
      }
      await refresh();
      // pick up new Strava activities in the background
      if (canReadActivities(sc)) {
        importStravaActivities()
          .then((n) => (n ? refresh() : undefined))
          .catch((e) => console.warn('Strava import', e));
      }
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
  const { levels, history: levelHistory } = useMemo(
    () => computeLevels(rides, acts, calendar, workouts.map((w) => w.workout), settings.ftp),
    [rides, acts, calendar, workouts, settings.ftp],
  );
  // the coach runs in the private Worker, so it's only offered when the site is served from there
  const coachOn = syncStatus !== 'off';
  const coachState: CoachState = useMemo(
    () => ({ settings, rides, acts, calendar, plans, library: workouts.map((w) => w.workout), levels, today: today() }),
    [settings, rides, acts, calendar, plans, workouts, levels],
  );
  const activePlan = plans.find((p) => p.active);
  const suggestion = coachOn ? adaptSuggestion(activePlan, calendar, today(), lastReview) : null;

  async function applyPlan(res: PlanResult, replace?: TrainingPlan) {
    if (replace) {
      await putOne('plans', { ...replace, active: false });
      const stale = calendar.filter((c) => c.planId === replace.id && c.status === 'planned' && c.date >= res.plan.start).map((c) => c.id);
      await deleteCalendar(stale);
    }
    await putOne('plans', res.plan);
    setPlans((ps) => [...ps.filter((p) => p.id !== replace?.id && p.id !== res.plan.id), ...(replace ? [{ ...replace, active: false }] : []), res.plan]);
    await saveCalendar(res.items);
    await markReviewed();
    setNotice(`Added “${res.plan.name}” to your calendar.`);
    setTab('calendar');
  }
  async function markReviewed() {
    await setFlag('coach-last-review', today());
    setLastReview(today());
  }
  async function applyAdapt(save: PlannedWorkout[], remove: string[]) {
    if (save.length) await saveCalendar(save);
    if (remove.length) await deleteCalendar(remove);
    await markReviewed();
  }
  async function addToday(w: Workout, reason: string) {
    const item = newPlanned(w, today(), calendar, { origin: 'recommend', rationale: reason });
    await saveCalendar([item]);
    return item;
  }

  const routes = useMemo(() => ROUTE_PRESETS.map((p) => ({ p, r: generateRoute(p.id, 1) })), []);

  /** Closing the picker without choosing a device: Chrome reports "User cancelled". */
  const isCancel = (e: unknown) => (e as Error).name === 'NotFoundError' && /cancel/i.test((e as Error).message);

  async function connectTrainer(showAll = false) {
    setError('');
    setPairHelp(null);
    try {
      trainer?.disconnect();
      const t = await pairTrainer(() => settings.riderKg, setTrainerState, showAll);
      setTrainer(t);
    } catch (e) {
      if (isCancel(e)) setPairHelp('trainer');
      else setError(`Trainer: ${(e as Error).message}`);
      setTrainerState(trainer ? trainerState : 'disconnected');
    }
  }
  async function connectHrm(showAll = false) {
    setError('');
    setPairHelp(null);
    try {
      hrm?.disconnect();
      const h = await pairHeartRate(setHrmState, showAll);
      setHrm(h);
    } catch (e) {
      if (isCancel(e)) setPairHelp('hrm');
      else setError(`Heart rate: ${(e as Error).message}`);
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
    const planned = workoutId.startsWith('cal:') ? calendar.find((c) => `cal:${c.id}` === workoutId) : undefined;
    const sw = workouts.find((w) => w.id === workoutId);
    const s = new RideSession({
      trainer,
      hrm,
      settings,
      workout: planned?.workout ?? sw?.workout,
      routePreset: route,
      routeSeed: 1,
    });
    setSession(s);
  }

  /** Uploads in the background, keeping the History list and open Summary in sync. */
  const showRide = useCallback((r: RideRecord) => {
    setSummary((cur) => (cur && cur.id === r.id ? r : cur));
    setRides((rs) => rs.map((x) => (x.id === r.id ? r : x)));
  }, []);
  const sendToStrava = useCallback((ride: RideRecord, opts: { hidden: boolean }) => void uploadRide(ride, opts, showRide), [showRide]);
  const rename = useCallback(
    async (ride: RideRecord, name: string) => {
      const res = await renameRide(ride, name);
      showRide(res.ride);
      return res.stravaError;
    },
    [showRide],
  );
  const removeRide = useCallback(
    async (ride: RideRecord) => {
      await deleteRide(ride.id);
      setSummary(null);
      void refresh();
    },
    [refresh],
  );

  async function endRide() {
    if (!session) return;
    const rec = session.finish();
    if (rec.samples.length > 10) {
      await saveRide(rec);
      setSummary(rec);
      // ridden from the calendar: link it to that workout
      const planned = calendar.find((c) => `cal:${c.id}` === selected);
      if (planned) await saveCalendar([{ ...planned, status: 'done', rideId: rec.id }]);
    }
    setSession(null);
    void refresh();
    setTab('history');
  }

  async function updateSettings(s: Settings) {
    setSettings(s);
    await saveSettings(s);
  }

  const coachOverlays = (
    <>
      {planBuilder && <PlanBuilder state={coachState} onApply={applyPlan} onClose={() => setPlanBuilder(false)} />}
      {adapt && <AdaptReview state={coachState} input={adapt} onApply={applyAdapt} onClose={() => setAdapt(null)} />}
    </>
  );

  if (isPhone && !forceDesktop && !session) {
    return (
      <>
        <MobileApp
          settings={settings}
          workouts={workouts}
          rides={rides}
          acts={acts}
          calendar={calendar}
          plans={plans}
          levels={levels}
          levelHistory={levelHistory}
          strava={strava}
          syncStatus={syncStatus}
          syncEmail={sync.email || undefined}
          notice={notice}
          error={error}
          onClearMessages={() => {
            setNotice('');
            setError('');
          }}
          coachOn={coachOn}
          coachState={coachState}
          suggestion={suggestion}
          onSaveCalendar={saveCalendar}
          onDeleteCalendar={deleteCalendar}
          onSettingsChange={updateSettings}
          onStravaChange={setStrava}
          onBuildPlan={() => setPlanBuilder(true)}
          onAdapt={setAdapt}
          onDismissSuggestion={() => void markReviewed()}
          onAddToday={addToday}
          onSyncNow={() => void sync.syncNow()}
          onDesktop={() => {
            writeForceDesktop(true);
            setForceDesktop(true);
          }}
        />
        {coachOverlays}
      </>
    );
  }

  if (session) return <RideScreen session={session} settings={settings} onEnd={endRide} onSettingsChange={updateSettings} />;

  const todays = calendar.filter((c) => c.date === today() && c.status === 'planned').sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  const selPlanned = calendar.find((c) => `cal:${c.id}` === selected);
  const sel = selPlanned ? { id: selected, workout: selPlanned.workout } : workouts.find((w) => w.id === selected);
  const selIv = sel ? flatten(sel.workout) : [];
  const selStats = sel ? plannedStats(selIv, settings.ftp) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🚴 RideBox</div>
        <nav>
          {TABS.map((t) => (
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
            <button onClick={() => connectTrainer()} disabled={!bluetoothAvailable()}>{trainer && trainer.kind !== 'simulated' ? 'Reconnect' : 'Connect trainer'}</button>
          </span>
          <span className="device">
            <StatusDot s={hrmState} /> {hrm ? hrm.name : 'No HRM'}
            {hrm && liveHr != null && <b> {liveHr} bpm</b>}
            <button onClick={() => connectHrm()} disabled={!bluetoothAvailable()}>{hrm && !(hrm instanceof SimulatedHrm) ? 'Reconnect' : 'Connect HRM'}</button>
          </span>
          <button className="ghost" onClick={useSimulator} title="Try the app without hardware">Simulator</button>
          {isPhone && (
            <button
              className="ghost"
              onClick={() => {
                writeForceDesktop(false);
                setForceDesktop(false);
              }}
            >
              Phone layout
            </button>
          )}
          {syncStatus !== 'off' && (
            <span className={`sync sync-${syncStatus}`} title={`Synced across browsers${sync.email ? ` as ${sync.email}` : ''}`} onClick={() => void sync.syncNow()}>
              {SYNC_LABEL[syncStatus]}
            </span>
          )}
        </div>
      </header>

      {!bluetoothAvailable() && (
        <div className="banner">This browser doesn&apos;t support Web Bluetooth. Open RideBox in <b>Chrome</b> (or Edge) on your Mac. The simulator still works here.</div>
      )}
      {pairHelp && (
        <div className="banner">
          <b>Didn&apos;t see your {pairHelp === 'trainer' ? 'trainer' : 'heart-rate strap'}?</b>
          <ul className="pair-help">
            {pairHelp === 'trainer' ? (
              <li>Wake the trainer by pedaling for a few seconds (the KICKR Core&apos;s light should blink blue).</li>
            ) : (
              <li>Put the strap on (or wet the sensor pads) so it wakes up and starts advertising.</li>
            )}
            <li>
              Close Zwift, the Wahoo app, TrainerRoad and anything else that might be connected, and turn off Bluetooth on
              your phone/watch for a moment. Most sensors stop showing up once another app has them.
            </li>
            <li>On your Mac: System Settings → Privacy &amp; Security → Bluetooth → make sure Google Chrome is on.</li>
          </ul>
          <button onClick={() => (pairHelp === 'trainer' ? connectTrainer(true) : connectHrm(true))}>Show all nearby Bluetooth devices</button>{' '}
          <button className="ghost" onClick={() => setPairHelp(null)}>Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="banner" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
      {error && (
        <div className="banner err" onClick={() => setError('')}>
          {error}
        </div>
      )}

      {summary ? (
        <Summary
          ride={summary}
          settings={settings}
          stravaConnected={isConnected(strava)}
          onStravaUpload={sendToStrava}
          onRename={rename}
          onDelete={removeRide}
          onClose={() => setSummary(null)}
          onFeel={async (r, feel) => {
            const next = { ...r, feel };
            await saveRide(next);
            showRide(next);
          }}
        >
          {(() => {
            const ev = levelHistory.find((h) => h.name === summary.name && h.date === today() && h.after !== h.before);
            return ev ? (
              <div className="banner">
                {ev.before == null ? `${ZONE_NAMES[ev.zone]} level set to ` : `${ev.after > ev.before ? '⬆' : '⬇'} ${ZONE_NAMES[ev.zone]} level ${ev.before.toFixed(1)} → `}
                <b>{ev.after.toFixed(1)}</b>
              </div>
            ) : null;
          })()}
          {coachOn && activePlan && summary.startTime > Date.now() - 2 * 86_400_000 && (
            <div className="card row space">
              <span className="muted small">Let the coach adjust your next two weeks based on this ride.</span>
              <button onClick={() => setAdapt({ reason: 'after_ride', from: today(), to: addDays(today(), 13) })}>Review my plan</button>
            </div>
          )}
        </Summary>
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
          {coachOn && (
            <TodayCard
              state={coachState}
              onRide={async (w, reason) => {
                const item = await addToday(w, reason);
                setSelected(`cal:${item.id}`);
              }}
              onAdd={async (w, reason) => {
                await addToday(w, reason);
                setNotice(`Added ${w.name} to today.`);
              }}
            />
          )}
          <h2>Workout</h2>
          <div className="row">
            <select className="grow" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="free">Free ride (no workout, SIM mode)</option>
              {(todays.length > 0 || (selPlanned && !todays.includes(selPlanned))) && (
                <optgroup label="From your calendar">
                  {[...todays, ...(selPlanned && !todays.includes(selPlanned) ? [selPlanned] : [])].map((c) => (
                    <option key={c.id} value={`cal:${c.id}`}>
                      {c.date === today() ? 'Today: ' : `${c.date}: `}
                      {c.workout.name} ({formatDuration(plannedStats(flatten(c.workout), settings.ftp).duration)})
                    </option>
                  ))}
                </optgroup>
              )}
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
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  className={`route-card ${route === p.id ? 'selected' : ''}`}
                  onClick={() => setRoute(p.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      setRoute(p.id);
                    }
                  }}
                >
                  <img className="route-thumb" src={ROUTE_IMAGES[p.id]} alt="" loading="lazy" />
                  <div className="card-title">{p.name}</div>
                  <div className="muted small">
                    {fmtDist(r.length, settings)} {distUnit(settings)} · {fmtElev(r.totalClimb, settings)} {elevUnit(settings)} · {p.description}
                  </div>
                  <RouteProfile r={r} />
                  {route === p.id && (
                    <button
                      className="primary route-ride"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRide();
                      }}
                      disabled={!trainer}
                    >
                      {trainer ? 'Ride ▶' : 'Connect a trainer to ride'}
                    </button>
                  )}
                </div>
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
      ) : tab === 'calendar' ? (
        <Calendar
          calendar={calendar}
          plans={plans}
          rides={rides}
          acts={acts}
          workouts={workouts}
          settings={settings}
          levels={levels}
          onSave={saveCalendar}
          onDelete={deleteCalendar}
          onRide={(p) => {
            setSelected(`cal:${p.id}`);
            setTab('ride');
          }}
          onOpenRide={(id) => {
            const r = rides.find((x) => x.id === id);
            if (r) setSummary(r);
          }}
          toolbar={
            coachOn ? (
              <>
                <button onClick={() => setPlanBuilder(true)}>{activePlan ? 'New plan' : 'Build a plan'}</button>
                <button onClick={() => setAdapt({ reason: 'manual', from: today(), to: activePlan && addDays(today(), 13) > activePlan.end ? activePlan.end : addDays(today(), 13) })}>
                  Adjust with coach
                </button>
              </>
            ) : (
              <span className="muted small" title="The Claude coach runs on your private Cloudflare site">Coach: available on your private site</span>
            )
          }
          banner={
            <>
              {activePlan && (
                <div className="plan-bar">
                  <b>{activePlan.name}</b>
                  <span className="muted small">
                    {activePlan.goal}
                    {activePlan.eventDate ? ` · event ${activePlan.eventDate}` : ''} · until {activePlan.end}
                  </span>
                </div>
              )}
              {suggestion && (
                <div className="banner row space">
                  <span>{suggestion.text}</span>
                  <span className="row">
                    <button className="primary" onClick={() => setAdapt({ reason: suggestion.reason, from: suggestion.from, to: suggestion.to })}>
                      {suggestion.reason === 'extend' ? 'Plan next weeks' : 'Rearrange'}
                    </button>
                    <button className="ghost" onClick={() => void markReviewed()}>Not now</button>
                  </span>
                </div>
              )}
            </>
          }
        />
      ) : tab === 'fitness' ? (
        <Fitness rides={rides} acts={acts} calendar={calendar} settings={settings} strava={strava} onSettingsChange={updateSettings} onImported={refresh}>
          <LevelsCard levels={levels} history={levelHistory} />
        </Fitness>
      ) : tab === 'history' ? (
        <History rides={rides} settings={settings} stravaConnected={isConnected(strava)} onOpen={setSummary} onChange={refresh} />
      ) : (
        <SettingsPage
          settings={settings}
          onSave={updateSettings}
          strava={strava}
          onStravaChange={setStrava}
        />
      )}
      {coachOverlays}
    </div>
  );
}
