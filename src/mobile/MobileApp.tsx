// Phone layout: a schedule-first app with a bottom tab bar (Calendar, Workouts,
// Progress, More). There's no riding here; rides happen on the desktop site.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import type { RideRecord } from '../app/recorder';
import type { Settings, StoredWorkout } from '../storage/db';
import type { StravaConfig } from '../strava/strava';
import type { SyncStatus } from '../storage/sync';
import { monthWeeks, moveTo, newPlanned, scaleWorkout, weekStart } from '../training/calendar';
import { addDays, dayKey, dayStart, fitnessSeries, formLabel, loadEntries, periodTotals, plannedLoad, today, weeklyTotals, type LoadEntry } from '../training/load';
import type { DayKey, PlannedWorkout, StravaActivity, TrainingPlan } from '../training/model';
import { LEVEL_ZONES, ZONE_NAMES, difficultyLabel, rateWorkout, type LevelEvent, type LevelZone, type Levels } from '../training/levels';
import type { AdaptSuggestion, CoachState } from '../training/coach';
import type { AdaptInput } from '../training/coachSchema';
import { flatten, type Interval, intervalFtpFraction, plannedStats, zoneFor, type Workout } from '../workout/model';
import { WorkoutChart } from '../ui/WorkoutChart';
import { ActualDetail } from '../ui/ActualDetail';
import { MiniChart, useCardStats } from '../ui/CardActual';
import { LEVEL_COLORS } from '../ui/Levels';
import { FitnessChart, RangeSelect, rangeDays, SERIES, WeeklyBars, type FitnessRangeId } from '../ui/FitnessChart';
import { StravaSettings } from '../ui/StravaSettings';
import { RiderLog } from '../ui/RiderLog';
import { PlannedCoach, TodayCard } from '../ui/Coach';
import { ChainTracker } from '../chains/ChainTracker';

export interface MobileAppProps {
  settings: Settings;
  workouts: StoredWorkout[];
  rides: RideRecord[];
  acts: StravaActivity[];
  calendar: PlannedWorkout[];
  plans: TrainingPlan[];
  levels: Levels;
  levelHistory: LevelEvent[];
  strava: StravaConfig;
  syncStatus: SyncStatus;
  syncEmail?: string;
  notice: string;
  error: string;
  onClearMessages: () => void;
  coachOn: boolean;
  coachState: CoachState;
  suggestion: AdaptSuggestion | null;
  onSaveCalendar: (items: PlannedWorkout[]) => void;
  onDeleteCalendar: (ids: string[]) => void;
  onSettingsChange: (s: Settings) => void;
  onStravaChange: (c: StravaConfig) => void;
  /** after a manual Strava import */
  onImported: () => void;
  onBuildPlan: () => void;
  onManagePlans: () => void;
  onAdapt: (input: AdaptInput) => void;
  onDismissSuggestion: () => void;
  onAddToday: (w: Workout, reason: string) => Promise<unknown>;
  onSyncNow: () => void;
  onDesktop: () => void;
}

type MTab = 'calendar' | 'workouts' | 'progress' | 'chains' | 'more';

type Sheet =
  | { kind: 'planned'; id: string }
  | { kind: 'activity'; entry: LoadEntry }
  | { kind: 'library'; w: StoredWorkout }
  | { kind: 'add'; date: DayKey }
  | { kind: 'swap'; id: string }
  | { kind: 'coach' };

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW1 = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const STATUS_LABEL: Record<PlannedWorkout['status'], string> = { planned: 'Planned', done: 'Completed', missed: 'Missed', skipped: 'Skipped' };

/** Main color of a workout: the zone of its hardest sustained interval. */
function workoutColor(w: Workout, ftp: number) {
  const ivs = flatten(w).filter((iv) => !iv.free && iv.duration >= 30);
  if (!ivs.length) return '#5c6b80';
  return zoneFor(Math.max(...ivs.map((iv) => intervalFtpFraction(iv, ftp)))).color;
}

const fmtHm = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : `${m} min`;
};
/** "0:41", "1:30" for stat tiles */
const fmtClock = (sec: number) => {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const longDay = (k: DayKey) => dayStart(k).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
function relDay(k: DayKey, t: DayKey) {
  if (k === t) return 'Today';
  if (k === addDays(t, 1)) return 'Tomorrow';
  if (k === addDays(t, -1)) return 'Yesterday';
  return dayStart(k).toLocaleDateString(undefined, { weekday: 'long' });
}

// ---------- icons ----------

const Icon = {
  calendar: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
  workouts: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20V14h3v6M8.5 20V9h3v11M14 20v-8h3v8M19.5 20V5H21v15" />
    </svg>
  ),
  progress: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l5-5 4 4 8-9" />
      <path d="M15 7h5v5" />
    </svg>
  ),
  chains: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="8.5" width="10" height="7" rx="3.5" />
      <rect x="11.5" y="8.5" width="10" height="7" rx="3.5" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5" />
    </svg>
  ),
  chevL: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  chevR: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 2l1.8 5.6L19.5 9l-5.7 1.6L12 16l-1.8-5.4L4.5 9l5.7-1.4z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
};

// ---------- shared bits ----------

function BottomSheet({ onClose, children, title }: { onClose: () => void; children: ReactNode; title?: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', k);
    };
  }, [onClose]);
  return (
    <div className="m-sheet-bg" onClick={onClose}>
      <div className="m-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-grab" onClick={onClose} />
        <div className="m-sheet-head">
          <div className="m-sheet-title">{title}</div>
          <button className="m-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>
  );
}

function Difficulty({ w, ftp, levels }: { w: Workout; ftp: number; levels: Levels }) {
  const r = rateWorkout(w, ftp);
  const d = difficultyLabel(r, levels);
  if (r.zone === 'recovery' || r.zone === 'test') return <span className={`m-diff ${d.cls}`}>{d.label}</span>;
  return (
    <span className={`m-diff ${d.cls}`}>
      {ZONE_NAMES[r.zone]} {r.level.toFixed(1)} · {d.label}
    </span>
  );
}

function WorkoutCard({ w, ftp, levels, status, tag, onClick }: {
  w: Workout;
  ftp: number;
  levels: Levels;
  status?: PlannedWorkout['status'];
  tag?: string;
  onClick: () => void;
}) {
  const ivs = useMemo(() => flatten(w), [w]);
  const s = useMemo(() => plannedStats(ivs, ftp), [ivs, ftp]);
  return (
    <button className={`m-wcard ${status ? `st-${status}` : ''}`} style={{ borderLeftColor: workoutColor(w, ftp) }} onClick={onClick}>
      <div className="m-wcard-top">
        <span className="m-wcard-name">{w.name}</span>
        {status && status !== 'planned' && <span className={`m-pill pill-${status}`}>{STATUS_LABEL[status]}</span>}
        {tag && <span className="m-pill pill-tag">{tag}</span>}
      </div>
      <div className="m-wcard-meta">
        <span><b>{fmtHm(s.duration)}</b></span>
        <span>TSS <b>{Math.round(s.tss)}</b></span>
        <span>IF <b>{s.if.toFixed(2)}</b></span>
      </div>
      <Difficulty w={w} ftp={ftp} levels={levels} />
      <div className="m-wcard-chart">
        <WorkoutChart intervals={ivs} ftp={ftp} height={44} compact />
      </div>
    </button>
  );
}

/** One number on an agenda card: big value, small caps label. */
function Metric({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div className={`m-tile-m${wide ? ' wide' : ''}`}>
      <div className="m-tile-v">
        {value ?? '--'}
      </div>
      <div className="m-tile-l">{label}</div>
    </div>
  );
}

const STATUS_MARK: Partial<Record<PlannedWorkout['status'], ReactNode>> = {
  done: <span className="m-tile-mark ok" aria-label="Completed">✓</span>,
  missed: <span className="m-tile-mark err" aria-label="Missed">✕</span>,
};

/**
 * Agenda card: chart on the left, name and big numbers on the right, difficulty underneath.
 * Planned workouts show duration / TSS / IF; ridden ones show what happened (time, TSS vs plan,
 * NP, average power, heart rate) over a plan-vs-actual chart.
 */
function AgendaCard({ w, name, kicker, ftp, levels, status, tag, ride, act, tss, onClick }: {
  w?: Workout;
  name: string;
  /** subtitle when there's no workout to rate (unplanned rides) */
  kicker?: string;
  ftp: number;
  levels: Levels;
  status?: PlannedWorkout['status'];
  tag?: string;
  ride?: RideRecord;
  act?: StravaActivity;
  tss?: number;
  onClick: () => void;
}) {
  const ivs = useMemo<Interval[] | undefined>(() => (w ? flatten(w) : undefined), [w]);
  const plan = useMemo(() => (ivs ? plannedStats(ivs, ftp) : null), [ivs, ftp]);
  const ridden = !!(ride || act) && (!w || status === 'done');
  const a = useCardStats(ridden ? ride : undefined, ridden ? act : undefined, ivs, ftp, tss);
  const rating = w ? rateWorkout(w, ftp) : null;
  const diff = rating ? difficultyLabel(rating, levels) : null;
  const sub = rating && rating.zone !== 'recovery' && rating.zone !== 'test' ? `${ZONE_NAMES[rating.zone]} ${rating.level.toFixed(1)}` : kicker;
  const color = w ? workoutColor(w, ftp) : '#6b7686';
  return (
    <button className={`m-tile ${status ? `st-${status}` : ''}${w ? '' : ' unplanned'}`} style={{ borderLeftColor: color }} onClick={onClick}>
      <div className="m-tile-main">
        {(ivs || (ridden && a.series)) && (
          <div className="m-tile-chart">
            {ridden && a.series ? (
              <MiniChart series={a.series} intervals={ivs} ftp={a.rideFtp} height={76} />
            ) : (
              <WorkoutChart intervals={ivs!} ftp={ftp} height={76} compact />
            )}
          </div>
        )}
        <div className="m-tile-info">
          <div className="m-tile-top">
            <span className="m-tile-name">{name}</span>
            {status && STATUS_MARK[status]}
          </div>
          {sub && <div className="m-tile-sub">{sub}</div>}
          <div className="m-tile-metrics">
            {ridden ? (
              <>
                <Metric label="Time" value={a.duration != null ? fmtClock(a.duration) : undefined} />
                <Metric label={plan ? `TSS /${Math.round(plan.tss)}` : 'TSS'} value={a.tss} />
                <Metric label="IF" value={a.intensity != null && Number.isFinite(a.intensity) ? a.intensity.toFixed(2) : undefined} />
                <Metric wide label="Avg/NP W" value={a.avgPower != null || a.np != null ? `${a.avgPower ?? '–'}/${a.np ?? '–'}` : undefined} />
                <Metric wide label="Avg/Max HR" value={a.hr != null ? `${a.hr}${a.maxHr != null ? `/${a.maxHr}` : ''}` : undefined} />
              </>
            ) : plan ? (
              <>
                <Metric label="Time" value={fmtClock(plan.duration)} />
                <Metric label="TSS" value={Math.round(plan.tss)} />
                <Metric label="IF" value={plan.if.toFixed(2)} />
              </>
            ) : null}
          </div>
        </div>
      </div>
      {(diff || tag || (status && status !== 'planned' && status !== 'done' && status !== 'missed') || (a.hits && a.hits.of > 0)) && (
        <div className="m-tile-foot">
          {diff && <span className={`m-diff ${diff.cls}`}>{diff.label}</span>}
          {status === 'skipped' && <span className="m-pill pill-skipped">{STATUS_LABEL[status]}</span>}
          {tag && <span className="m-pill pill-tag">{tag}</span>}
          {a.hits && a.hits.of > 0 && (
            <span className={`verdict ${a.hits.hit === a.hits.of ? 'v-hit' : a.hits.hit >= a.hits.of * 0.7 ? 'v-over' : 'v-under'}`}>
              {a.hits.hit}/{a.hits.of} on target
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="m-stat">
      <div className="m-stat-l">{label}</div>
      <div className="m-stat-v">{value}</div>
      {sub && <div className="m-stat-s">{sub}</div>}
    </div>
  );
}

function useSwipe(onLeft: () => void, onRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const dx = e.changedTouches[0].clientX - s.x;
      const dy = e.changedTouches[0].clientY - s.y;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) onLeft();
      else onRight();
    },
  };
}

// ---------- app ----------

export function MobileApp(p: MobileAppProps) {
  const [tab, setTab] = useState<MTab>('calendar');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState('');
  const ftp = p.settings.ftp;

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const msg = p.error || p.notice;
    if (!msg) return;
    setToast(msg);
    p.onClearMessages();
  }, [p.error, p.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => setSheet(null);
  const planned = sheet?.kind === 'planned' || sheet?.kind === 'swap' ? p.calendar.find((c) => c.id === sheet.id) : undefined;

  return (
    <div className="m-app">
      <main className="m-main">
        {tab === 'calendar' ? (
          <CalendarScreen {...p} onOpen={setSheet} onToast={setToast} />
        ) : tab === 'workouts' ? (
          <WorkoutsScreen workouts={p.workouts} ftp={ftp} levels={p.levels} onOpen={(w) => setSheet({ kind: 'library', w })} />
        ) : tab === 'progress' ? (
          <ProgressScreen {...p} />
        ) : tab === 'chains' ? (
          p.strava.server ? (
            <ChainTracker phone />
          ) : (
            <div className="m-pad">
              <h1 className="m-h1">Chains</h1>
              <p className="muted">The chain tracker runs on your private Cloudflare site. Open RideBox there to use it.</p>
            </div>
          )
        ) : (
          <MoreScreen {...p} onOpenActivity={(entry) => setSheet({ kind: 'activity', entry })} />
        )}
      </main>

      <nav className="m-tabbar">
        {(['calendar', 'workouts', 'progress', 'chains', 'more'] as MTab[]).map((t) => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => {
              setTab(t);
              window.scrollTo({ top: 0 });
            }}
          >
            {Icon[t]}
            <span>{t === 'more' ? 'Account' : t[0].toUpperCase() + t.slice(1)}</span>
          </button>
        ))}
      </nav>

      {toast && (
        <div className="m-toast" onClick={() => setToast('')}>
          {toast}
        </div>
      )}

      {sheet?.kind === 'planned' && planned && (
        <PlannedSheet
          p={planned}
          {...p}
          onClose={close}
          onSwap={() => setSheet({ kind: 'swap', id: planned.id })}
          onToast={setToast}
        />
      )}
      {sheet?.kind === 'activity' && <ActivitySheet entry={sheet.entry} rides={p.rides} acts={p.acts} settings={p.settings} onClose={close} />}
      {sheet?.kind === 'library' && (
        <LibrarySheet
          w={sheet.w}
          ftp={ftp}
          levels={p.levels}
          onClose={close}
          onAdd={(date) => {
            p.onSaveCalendar([newPlanned(sheet.w.workout, date, p.calendar)]);
            setToast(`Added to ${relDay(date, today()).toLowerCase() === 'today' ? 'today' : longDay(date)}`);
            close();
          }}
        />
      )}
      {sheet?.kind === 'add' && (
        <PickerSheet
          title={`Add to ${longDay(sheet.date)}`}
          workouts={p.workouts}
          ftp={ftp}
          levels={p.levels}
          onClose={close}
          onPick={(w) => {
            p.onSaveCalendar([newPlanned(w, sheet.date, p.calendar)]);
            setToast(`Added ${w.name}`);
            close();
          }}
        />
      )}
      {sheet?.kind === 'swap' && planned && (
        <PickerSheet
          title={`Swap ${planned.workout.name}`}
          workouts={p.workouts}
          ftp={ftp}
          levels={p.levels}
          near={plannedStats(flatten(planned.workout), ftp).duration}
          onClose={() => setSheet({ kind: 'planned', id: planned.id })}
          onPick={(w) => {
            p.onSaveCalendar([{ ...planned, workout: w, origin: 'manual' }]);
            setToast(`Swapped to ${w.name}`);
            setSheet({ kind: 'planned', id: planned.id });
          }}
        />
      )}
      {sheet?.kind === 'coach' && (
        <BottomSheet title="Coach" onClose={close}>
          <div className="m-list">
            <button
              className="m-list-item"
              onClick={() => {
                close();
                p.onBuildPlan();
              }}
            >
              <b>{p.plans.some((x) => x.active) ? 'Build a new plan' : 'Build a training plan'}</b>
              <span className="muted small">Goal, event date and the time you have each day.</span>
            </button>
            <button
              className="m-list-item"
              onClick={() => {
                close();
                const active = p.plans.find((x) => x.active);
                const to = addDays(today(), 13);
                p.onAdapt({ reason: 'manual', from: today(), to: active && to > active.end ? active.end : to });
              }}
            >
              <b>Adjust my next two weeks</b>
              <span className="muted small">After missed workouts, illness or a hard week.</span>
            </button>
            {p.plans.length > 0 && (
              <button
                className="m-list-item"
                onClick={() => {
                  close();
                  p.onManagePlans();
                }}
              >
                <b>My plans</b>
                <span className="muted small">Edit, activate or delete a training plan.</span>
              </button>
            )}
          </div>
          <TodayCard
            state={p.coachState}
            canRide={false}
            onRide={() => undefined}
            onAdd={async (w, reason) => {
              await p.onAddToday(w, reason);
              setToast(`Added ${w.name} to today`);
              close();
            }}
          />
        </BottomSheet>
      )}
    </div>
  );
}

// ---------- calendar ----------

function CalendarScreen(p: MobileAppProps & { onOpen: (s: Sheet) => void; onToast: (s: string) => void }) {
  const t = today();
  const ftp = p.settings.ftp;
  const [selected, setSelected] = useState<DayKey>(t);
  const [monthOpen, setMonthOpen] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState<DayKey>(t);
  const week = weekStart(selected);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  // The agenda is one continuous list of weeks that grows in both directions
  // as you scroll toward either end.
  const [range, setRange] = useState(() => ({ from: addDays(weekStart(t), -14), weeks: 8 }));
  const rangeEnd = addDays(range.from, range.weeks * 7 - 1);
  const agendaDays = useMemo(() => Array.from({ length: range.weeks * 7 }, (_, i) => addDays(range.from, i)), [range]);
  const dayRefs = useRef(new Map<DayKey, HTMLElement>());
  const scrollPending = useRef(false);
  const autoScrolling = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  // When weeks are added above, remember where a day sat so the view doesn't jump.
  const anchor = useRef<{ day: DayKey; top: number } | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<DayKey, PlannedWorkout[]>();
    for (const c of p.calendar) m.set(c.date, [...(m.get(c.date) ?? []), c]);
    for (const list of m.values()) list.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    return m;
  }, [p.calendar]);
  const linked = useMemo(() => new Set(p.calendar.flatMap((c) => [c.rideId, c.stravaId]).filter(Boolean) as string[]), [p.calendar]);
  const entries = useMemo(() => loadEntries(p.rides, p.acts, ftp, p.settings.maxHr), [p.rides, p.acts, ftp, p.settings.maxHr]);
  const actsByDay = useMemo(() => {
    const m = new Map<DayKey, LoadEntry[]>();
    for (const e of entries) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [entries]);
  const ridesById = useMemo(() => new Map(p.rides.map((r) => [r.id, r])), [p.rides]);
  const actsById = useMemo(() => new Map(p.acts.map((x) => [x.id, x])), [p.acts]);
  const tssById = useMemo(() => new Map(entries.map((e) => [e.id, e.tss])), [entries]);
  const activePlan = p.plans.find((x) => x.active);

  const phaseOf = (ws: DayKey) => activePlan?.phases.find((ph) => ph.start <= addDays(ws, 3) && addDays(ws, 3) <= ph.end);
  const weekTotals = (ws: DayKey) => periodTotals(p.calendar, entries, ftp, ws, addDays(ws, 6));

  const go = (d: DayKey, scroll = true) => {
    userScrolled.current = true;
    const ws = weekStart(d);
    if (ws < range.from) {
      captureAnchor();
      setRange({ from: ws, weeks: Math.round((dayStart(rangeEnd).getTime() - dayStart(ws).getTime()) / (7 * 864e5)) + 1 });
    } else if (d > rangeEnd) {
      setRange({ from: range.from, weeks: Math.round((dayStart(ws).getTime() - dayStart(range.from).getTime()) / (7 * 864e5)) + 3 });
    }
    setSelected(d);
    scrollPending.current = scroll;
    if (d === selected && scroll) scrollToDay(d, true);
  };
  const headRef = useRef<HTMLElement>(null);
  const scrollToDay = (d: DayKey, smooth: boolean, center = false) => {
    const el = dayRefs.current.get(d);
    if (!el) return;
    const headH = headRef.current?.getBoundingClientRect().height ?? 0;
    const rect = el.getBoundingClientRect();
    // centered: the day sits in the middle of the space below the header (never above its top edge)
    const space = window.innerHeight - headH;
    const lead = center ? Math.max(12, (space - rect.height) / 2) : 12;
    const top = Math.max(0, rect.top + window.scrollY - headH - lead);
    if (Math.abs(top - window.scrollY) < 2) return;
    // Gliding across months of list is slow; long jumps go straight there.
    if (Math.abs(top - window.scrollY) > window.innerHeight * 3) smooth = false;
    // Don't let the scroll-follow logic below re-select days while we glide past them.
    autoScrolling.current = true;
    let timer = 0;
    const done = () => {
      autoScrolling.current = false;
      window.clearTimeout(timer);
      window.removeEventListener('scrollend', done);
    };
    window.addEventListener('scrollend', done);
    timer = window.setTimeout(done, smooth ? 1500 : 100);
    window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    if (!scrollPending.current) return;
    scrollPending.current = false;
    scrollToDay(selected, true);
  }, [selected, range]); // eslint-disable-line react-hooks/exhaustive-deps
  // Open centered on today, and keep it centered while data (plan, rides,
  // Strava) loads in and shifts the layout, until the person scrolls themselves.
  const userScrolled = useRef(false);
  useEffect(() => {
    const mark = () => {
      userScrolled.current = true;
    };
    const opts = { passive: true } as const;
    window.addEventListener('touchstart', mark, opts);
    window.addEventListener('wheel', mark, opts);
    window.addEventListener('keydown', mark);
    window.addEventListener('mousedown', mark);
    return () => {
      window.removeEventListener('touchstart', mark);
      window.removeEventListener('wheel', mark);
      window.removeEventListener('keydown', mark);
      window.removeEventListener('mousedown', mark);
    };
  }, []);
  useLayoutEffect(() => {
    if (userScrolled.current) return;
    scrollToDay(t, false, true);
  }, [p.calendar, p.rides, p.acts, p.plans, ftp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // one more pass after first paint (fonts, tile heights), still before any touch
    const id = requestAnimationFrame(() => {
      if (!userScrolled.current) scrollToDay(t, false, true);
    });
    return () => cancelAnimationFrame(id);
  }, [p.calendar, p.rides, p.acts, p.plans, ftp]); // eslint-disable-line react-hooks/exhaustive-deps

  const captureAnchor = () => {
    const day = agendaRef.current[0];
    const el = dayRefs.current.get(day);
    anchor.current = el ? { day, top: el.getBoundingClientRect().top } : null;
  };
  // After weeks are added above, shift the scroll by however far the anchor
  // day moved, before the browser paints.
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const el = a && dayRefs.current.get(a.day);
    if (!a || !el) return;
    const delta = el.getBoundingClientRect().top - a.top;
    if (delta) window.scrollBy(0, delta);
  }, [range.from]);
  // We correct the scroll ourselves; the browser's own anchoring would double it.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    return () => {
      root.style.overflowAnchor = prev;
    };
  }, []);

  // Keep the week strip in step with the day at the top of the list.
  const agendaRef = useRef(agendaDays);
  agendaRef.current = agendaDays;
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (autoScrolling.current || !userScrolled.current) return;
        const line = (headRef.current?.getBoundingClientRect().height ?? 0) + 16;
        const top = agendaRef.current.find((d) => (dayRefs.current.get(d)?.getBoundingClientRect().bottom ?? 0) > line);
        if (top) setSelected(top);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Load more weeks as the end of the list comes into view. Re-observing after
  // each load re-checks, so a tall screen keeps filling until it's covered.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) setRange((r) => ({ ...r, weeks: r.weeks + 4 }));
      },
      { rootMargin: '0px 0px 800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [range.weeks]);

  // Same at the top: load earlier weeks as the start of the list comes into view.
  useEffect(() => {
    const el = topSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        captureAnchor();
        setRange((r) => ({ from: addDays(r.from, -28), weeks: r.weeks + 4 }));
      },
      { rootMargin: '1200px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [range.from]); // eslint-disable-line react-hooks/exhaustive-deps

  const swipe = useSwipe(
    () => go(addDays(selected, 7)),
    () => go(addDays(selected, -7)),
  );
  const monthSwipe = useSwipeMonth(setMonthAnchor, monthAnchor);

  const dots = (d: DayKey) => {
    const items = byDay.get(d) ?? [];
    const extra = (actsByDay.get(d) ?? []).filter((e) => !linked.has(e.id));
    return (
      <span className="m-dots">
        {items.slice(0, 3).map((c) => (
          <i key={c.id} className={`st-${c.status}`} style={{ background: c.status === 'done' ? 'var(--ok)' : workoutColor(c.workout, ftp) }} />
        ))}
        {extra.slice(0, 3 - Math.min(3, items.length)).map((e) => (
          <i key={e.id} style={{ background: 'var(--ok)' }} />
        ))}
      </span>
    );
  };

  const weekDivider = (ws: DayKey) => {
    const w = weekTotals(ws);
    const ph = phaseOf(ws);
    const fmt = (k: DayKey) => dayStart(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const current = ws === weekStart(t);
    const showDone = ws <= t;
    return (
      <div className={`m-week-divider${current ? ' current' : ''}`}>
        <div className="m-week-divider-top">
          <span>
            <b>{current ? 'This week' : `${fmt(ws)} – ${fmt(addDays(ws, 6))}`}</b>
            {ph && <span style={{ color: 'var(--accent-2)' }}> · {ph.name}</span>}
          </span>
          <span className="muted small">
            {showDone
              ? `${Math.round(w.doneTss)} / ${Math.round(w.plannedTss)} TSS · ${fmtHm(w.doneSec)} / ${fmtHm(w.plannedSec)}`
              : `${Math.round(w.plannedTss)} TSS · ${fmtHm(w.plannedSec)}`}
            {w.skippedSec > 0 && ` · ${Math.round(w.skippedTss)} TSS skipped`}
          </span>
        </div>
        {current && (
          <>
            <div className="m-bar">
              <div style={{ width: `${w.plannedTss ? Math.min(100, (w.doneTss / w.plannedTss) * 100) : w.doneTss ? 100 : 0}%` }} />
            </div>
            {activePlan && (
              <div className="m-plan">
                <b>{activePlan.name}</b>
                <span className="muted small">
                  {activePlan.eventDate ? `Event ${fmt(activePlan.eventDate)}` : `Until ${fmt(activePlan.end)}`}
                </span>
              </div>
            )}
            {p.suggestion && (
              <div className="m-banner">
                <div>{p.suggestion.text}</div>
                <div className="m-banner-actions">
                  <button className="m-btn primary sm" onClick={() => p.onAdapt({ reason: p.suggestion!.reason, from: p.suggestion!.from, to: p.suggestion!.to })}>
                    {p.suggestion.reason === 'extend' ? 'Plan next weeks' : 'Rearrange'}
                  </button>
                  <button className="m-btn ghost sm" onClick={p.onDismissSuggestion}>Not now</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // ---- press and hold a workout, then drag it to another day ----
  const [drag, setDrag] = useState<{ id: string; from: DayKey; x: number; y: number; target?: DayKey } | null>(null);
  const press = useRef<{ id: string; from: DayKey; sx: number; sy: number; x: number; y: number; target?: DayKey; active: boolean; timer: number } | null>(null);
  const agendaEl = useRef<HTMLDivElement>(null);
  const calRef = useRef(p.calendar);
  calRef.current = p.calendar;
  const saveRef = useRef(p.onSaveCalendar);
  saveRef.current = p.onSaveCalendar;
  const toastRef = useRef(p.onToast);
  toastRef.current = p.onToast;

  const startPress = (c: PlannedWorkout) => (e: TouchEvent) => {
    if (e.touches.length !== 1 || c.status === 'done') return;
    const { clientX: x, clientY: y } = e.touches[0];
    const d = { id: c.id, from: c.date, sx: x, sy: y, x, y, active: false, timer: 0 } as NonNullable<typeof press.current>;
    d.timer = window.setTimeout(() => {
      d.active = true;
      d.target = c.date;
      navigator.vibrate?.(15);
      setDrag({ id: c.id, from: c.date, x: d.x, y: d.y, target: c.date });
    }, 400);
    press.current = d;
  };

  useEffect(() => {
    const el = agendaEl.current;
    if (!el) return;
    let speed = 0;
    let frame = 0;
    const dayAt = (x: number, y: number) => ((document.elementFromPoint(x, y)?.closest('[data-day]') as HTMLElement | null)?.dataset.day as DayKey | undefined);
    const update = () => {
      const d = press.current;
      if (!d?.active) return;
      d.target = dayAt(d.x, d.y) ?? d.target;
      setDrag({ id: d.id, from: d.from, x: d.x, y: d.y, target: d.target });
    };
    // Scroll the list while the finger is held near the top or bottom edge.
    const tick = () => {
      frame = 0;
      if (!speed || !press.current?.active) return;
      window.scrollBy(0, speed);
      update();
      frame = requestAnimationFrame(tick);
    };
    const move = (e: globalThis.TouchEvent) => {
      const d = press.current;
      if (!d) return;
      const { clientX: x, clientY: y } = e.touches[0];
      if (!d.active) {
        // Moving before the hold completes means the finger is scrolling.
        if (Math.hypot(x - d.sx, y - d.sy) > 10) {
          clearTimeout(d.timer);
          press.current = null;
        }
        return;
      }
      e.preventDefault();
      d.x = x;
      d.y = y;
      update();
      const top = (headRef.current?.getBoundingClientRect().bottom ?? 0) + 70;
      const bottom = window.innerHeight - 140;
      speed = y < top ? -Math.min(24, (top - y) / 3) : y > bottom ? Math.min(24, (y - bottom) / 3) : 0;
      if (speed && !frame) frame = requestAnimationFrame(tick);
    };
    const end = (e: globalThis.TouchEvent) => {
      const d = press.current;
      press.current = null;
      speed = 0;
      if (!d) return;
      clearTimeout(d.timer);
      if (!d.active) return;
      e.preventDefault(); // no tap-to-open after a drag
      setDrag(null);
      const c = calRef.current.find((x) => x.id === d.id);
      if (!c || !d.target || d.target === c.date) return;
      saveRef.current([moveTo(c, d.target, calRef.current, today())]);
      toastRef.current(`Moved to ${longDay(d.target)}`);
    };
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end, { passive: false });
    return () => {
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
      cancelAnimationFrame(frame);
    };
  }, []);
  const dragging = drag ? p.calendar.find((c) => c.id === drag.id) : undefined;

  const ma = dayStart(monthAnchor);
  const monthLabel = (monthOpen ? ma : dayStart(addDays(week, 3))).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <>
      <header className="m-head" ref={headRef}>
        <div className="m-head-row">
          <button
            className="m-month-btn"
            onClick={() => {
              setMonthAnchor(selected);
              setMonthOpen(!monthOpen);
            }}
            aria-expanded={monthOpen}
          >
            {monthLabel} <span className={`m-caret ${monthOpen ? 'up' : ''}`}>▾</span>
          </button>
          <div className="m-head-actions">
            {(selected !== t || monthOpen) && (
              <button
                className="m-chip"
                onClick={() => {
                  setMonthOpen(false);
                  go(t);
                }}
              >
                Today
              </button>
            )}
            {p.coachOn && (
              <button className="m-chip accent" onClick={() => p.onOpen({ kind: 'coach' })}>
                {Icon.sparkle} Coach
              </button>
            )}
          </div>
        </div>

        {monthOpen ? (
          <div className="m-month" {...monthSwipe}>
            <div className="m-month-nav">
              <button className="m-icon-btn" aria-label="Previous month" onClick={() => setMonthAnchor(dayKey(new Date(ma.getFullYear(), ma.getMonth() - 1, 1)))}>{Icon.chevL}</button>
              <button className="m-icon-btn" aria-label="Next month" onClick={() => setMonthAnchor(dayKey(new Date(ma.getFullYear(), ma.getMonth() + 1, 1)))}>{Icon.chevR}</button>
            </div>
            <div className="m-month-grid">
              {DOW1.map((d, i) => <div key={i} className="m-dow">{d}</div>)}
              {monthWeeks(ma.getFullYear(), ma.getMonth()).flatMap((w) =>
                Array.from({ length: 7 }, (_, i) => addDays(w, i)).map((d) => (
                  <button
                    key={d}
                    className={`m-mday${d === t ? ' today' : ''}${d === selected ? ' sel' : ''}${dayStart(d).getMonth() !== ma.getMonth() ? ' out' : ''}`}
                    onClick={() => {
                      setMonthOpen(false);
                      go(d);
                    }}
                  >
                    <span className="m-num">{dayStart(d).getDate()}</span>
                    {dots(d)}
                  </button>
                )),
              )}
            </div>
          </div>
        ) : (
          <div className="m-week" {...swipe}>
            <button className="m-icon-btn" aria-label="Previous week" onClick={() => go(addDays(selected, -7))}>{Icon.chevL}</button>
            <div className="m-week-days">
              {days.map((d, i) => (
                <button key={d} className={`m-wday${d === t ? ' today' : ''}${d === selected ? ' sel' : ''}`} onClick={() => go(d)}>
                  <span className="m-dow">{DOW1[i]}</span>
                  <span className="m-num">{dayStart(d).getDate()}</span>
                  {dots(d)}
                </button>
              ))}
            </div>
            <button className="m-icon-btn" aria-label="Next week" onClick={() => go(addDays(selected, 7))}>{Icon.chevR}</button>
          </div>
        )}
      </header>

      <div className={`m-agenda${drag ? ' dragging' : ''}`} ref={agendaEl}>
        <div ref={topSentinelRef} className="m-agenda-more" aria-hidden />
        {agendaDays.map((d, i) => {
          const items = byDay.get(d) ?? [];
          const extra = (actsByDay.get(d) ?? []).filter((e) => !linked.has(e.id));
          const weekHead = i % 7 === 0 ? weekDivider(d) : null;
          return (
            <Fragment key={d}>
            {weekHead}
            <section
              data-day={d}
              className={`m-day${d === t ? ' today' : ''}${d === selected ? ' sel' : ''}${drag?.target === d && d !== drag.from ? ' drop' : ''}`}
              ref={(el) => {
                if (el) dayRefs.current.set(d, el);
                else dayRefs.current.delete(d);
              }}
            >
              <div className="m-day-date-col">
                <span className="m-day-dow">{DOW[(dayStart(d).getDay() + 6) % 7]}</span>
                <span className="m-day-num">{dayStart(d).getDate()}</span>
                <button className="m-icon-btn add" aria-label={`Add a workout on ${longDay(d)}`} onClick={() => p.onOpen({ kind: 'add', date: d })}>
                  {Icon.plus}
                </button>
              </div>
              <div className="m-day-items">
                {items.map((c) => (
                  <div
                    key={c.id}
                    className={`m-drag${drag?.id === c.id ? ' lifted' : ''}`}
                    onTouchStart={startPress(c)}
                    onContextMenu={(e) => c.status !== 'done' && e.preventDefault()}
                  >
                  <AgendaCard
                    w={c.workout}
                    name={c.workout.name}
                    ftp={ftp}
                    levels={p.levels}
                    status={c.status}
                    tag={c.origin === 'adapt' ? 'Adapted' : undefined}
                    ride={c.rideId ? ridesById.get(c.rideId) : undefined}
                    act={c.stravaId ? actsById.get(c.stravaId) : undefined}
                    tss={tssById.get(c.rideId ?? c.stravaId ?? '')}
                    onClick={() => p.onOpen({ kind: 'planned', id: c.id })}
                  />
                  </div>
                ))}
                {extra.map((e) => (
                  <AgendaCard
                    key={e.id}
                    name={e.name}
                    kicker={e.kind === 'strava' ? 'From Strava' : 'RideBox ride'}
                    ftp={ftp}
                    levels={p.levels}
                    ride={e.kind === 'ridebox' ? ridesById.get(e.id) : undefined}
                    act={e.kind === 'strava' ? actsById.get(e.id) : undefined}
                    tss={e.tss}
                    onClick={() => p.onOpen({ kind: 'activity', entry: e })}
                  />
                ))}
                {!items.length && !extra.length && <div className="m-rest">{d < t ? 'No workout' : 'Rest day'}</div>}
              </div>
            </section>
            </Fragment>
          );
        })}
        <div ref={sentinelRef} className="m-agenda-more" aria-hidden />
      </div>
      {drag && dragging && (
        <div className="m-drag-ghost" style={{ left: drag.x, top: drag.y, borderLeftColor: workoutColor(dragging.workout, ftp) }}>
          <b>{dragging.workout.name}</b>
          {drag.target && <span className="muted small">{drag.target === drag.from ? 'Drop on another day' : `→ ${longDay(drag.target)}`}</span>}
        </div>
      )}
    </>
  );
}

function useSwipeMonth(set: (k: DayKey) => void, anchor: DayKey) {
  const a = dayStart(anchor);
  return useSwipe(
    () => set(dayKey(new Date(a.getFullYear(), a.getMonth() + 1, 1))),
    () => set(dayKey(new Date(a.getFullYear(), a.getMonth() - 1, 1))),
  );
}

// ---------- sheets ----------

function PlannedSheet(props: MobileAppProps & { p: PlannedWorkout; onClose: () => void; onSwap: () => void; onToast: (s: string) => void }) {
  const { p, settings, levels, calendar, rides, acts, onSaveCalendar, onDeleteCalendar, onClose, onSwap, onToast } = props;
  const t = today();
  const ivs = useMemo(() => flatten(p.workout), [p.workout]);
  const s = useMemo(() => plannedStats(ivs, settings.ftp), [ivs, settings.ftp]);
  const r = rateWorkout(p.workout, settings.ftp);
  const d = difficultyLabel(r, levels);
  const [note, setNote] = useState(p.note ?? '');
  const ride = rides.find((x) => x.id === p.rideId);
  const act = acts.find((x) => x.id === p.stravaId);
  const save = (next: PlannedWorkout) => onSaveCalendar([next]);
  const move = (date: DayKey) => {
    if (!date || date === p.date) return;
    save(moveTo(p, date, calendar, t));
    onToast(`Moved to ${longDay(date)}`);
  };

  return (
    <BottomSheet
      onClose={onClose}
      title={
        <>
          <div className="m-sheet-kicker">
            {relDay(p.date, t)} · {dayStart(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            {p.phase ? ` · ${p.phase}` : ''}
          </div>
          {p.workout.name}
        </>
      }
    >
      {ride || act ? (
        <ActualDetail ride={ride} act={act} intervals={ivs} settings={settings} compact />
      ) : (
        <>
      <div className="m-stats">
        <Stat label="Duration" value={fmtClock(s.duration)} />
        <Stat label="TSS" value={Math.round(s.tss)} />
        <Stat label="IF" value={s.if.toFixed(2)} />
        <Stat
          label={r.zone === 'recovery' || r.zone === 'test' ? 'Type' : `${ZONE_NAMES[r.zone]}`}
          value={r.zone === 'recovery' || r.zone === 'test' ? ZONE_NAMES[r.zone] : r.level.toFixed(1)}
          sub={<span className={d.cls}>{d.label}</span>}
        />
      </div>
      <div className="m-chart-lg">
        <WorkoutChart intervals={ivs} ftp={settings.ftp} height={120} />
      </div>
        </>
      )}

      <div className={`m-status st-${p.status}`}>
        <span className={`m-pill pill-${p.status}`}>{STATUS_LABEL[p.status]}</span>
        {ride && <span className="small muted">{ride.name}</span>}
        {act && (
          <a className="strava-link small" href={`https://www.strava.com/activities/${act.stravaId}`} target="_blank" rel="noreferrer">
            {act.name} on Strava ↗
          </a>
        )}
      </div>

      {p.workout.description && <p className="m-desc">{p.workout.description}</p>}
      {p.rationale && (
        <div className="m-coach-note">
          <span className="m-coach-ico">{Icon.sparkle}</span>
          <span>{p.rationale}</span>
        </div>
      )}

      {props.coachOn && p.status !== 'done' && (
        <>
          <div className="m-section-label">Coach</div>
          <PlannedCoach
            key={p.id}
            state={props.coachState}
            planned={p}
            btn="m-btn"
            onSwap={(w, reason) => {
              save({ ...p, workout: w, rationale: reason });
              onToast(`Switched to ${w.name}`);
            }}
          />
        </>
      )}

      <div className="m-section-label">Reschedule</div>
      <div className="m-actions">
        <button className="m-btn" onClick={() => move(addDays(p.date, -1))}>−1 day</button>
        <button className="m-btn" onClick={() => move(addDays(p.date, 1))}>+1 day</button>
        <label className="m-btn m-date-btn">
          Pick date
          <input type="date" value={p.date} onChange={(e) => move(e.target.value)} />
        </label>
      </div>

      <div className="m-section-label">Adjust</div>
      <div className="m-actions">
        <button className="m-btn" onClick={() => { save({ ...p, workout: scaleWorkout(p.workout, 0.95) }); onToast('5% easier'); }}>Easier</button>
        <button className="m-btn" onClick={() => { save({ ...p, workout: scaleWorkout(p.workout, 1.05) }); onToast('5% harder'); }}>Harder</button>
        <button className="m-btn" onClick={onSwap}>Swap…</button>
      </div>

      <label className="m-field">
        <span>Note</span>
        <textarea rows={2} value={note} placeholder="Add a note" onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (p.note ?? '') && save({ ...p, note })} />
      </label>

      <div className="m-actions">
        {p.status === 'planned' || p.status === 'missed' ? (
          <button className="m-btn" onClick={() => save({ ...p, status: 'skipped' })}>Skip</button>
        ) : p.status === 'skipped' ? (
          <button className="m-btn" onClick={() => save({ ...p, status: 'planned' })}>Unskip</button>
        ) : (
          <button className="m-btn" onClick={() => save({ ...p, status: 'planned', rideId: undefined, stravaId: undefined })}>Unlink ride</button>
        )}
        <button
          className="m-btn danger"
          onClick={() => {
            if (!confirm(`Remove ${p.workout.name} from your calendar?`)) return;
            onDeleteCalendar([p.id]);
            onToast('Removed');
            onClose();
          }}
        >
          Remove
        </button>
      </div>
      <p className="muted small m-hint">Ride it from RideBox on your computer. It links to this day automatically.</p>
    </BottomSheet>
  );
}

function ActivitySheet({ entry, rides, acts, settings, onClose }: { entry: LoadEntry; rides: RideRecord[]; acts: StravaActivity[]; settings: Settings; onClose: () => void }) {
  const ride = entry.kind === 'ridebox' ? rides.find((r) => r.id === entry.id) : undefined;
  const act = entry.kind === 'strava' ? acts.find((a) => a.id === entry.id) : undefined;
  return (
    <BottomSheet
      onClose={onClose}
      title={
        <>
          <div className="m-sheet-kicker">
            {longDay(entry.date)} · {act ? `${act.sportType}${act.trainer ? ' (trainer)' : ''} · Strava` : 'RideBox'}
            {ride?.workoutName ? ` · ${ride.workoutName}` : ''}
          </div>
          {entry.name}
        </>
      }
    >
      {ride || act ? (
        <ActualDetail ride={ride} act={act} settings={settings} tss={entry.tss} compact />
      ) : (
        <>
          <div className="m-stats">
            <Stat label="Time" value={fmtClock(entry.seconds)} />
            <Stat label="TSS" value={Math.round(entry.tss)} />
          </div>
          <p className="muted">This activity isn&apos;t on this device yet.</p>
        </>
      )}
      {act && (
        <a className="m-btn" href={`https://www.strava.com/activities/${act.stravaId}`} target="_blank" rel="noreferrer">
          View on Strava ↗
        </a>
      )}
    </BottomSheet>
  );
}

function LibrarySheet({ w, ftp, levels, onClose, onAdd }: { w: StoredWorkout; ftp: number; levels: Levels; onClose: () => void; onAdd: (d: DayKey) => void }) {
  const ivs = useMemo(() => flatten(w.workout), [w]);
  const s = plannedStats(ivs, ftp);
  const r = rateWorkout(w.workout, ftp);
  const d = difficultyLabel(r, levels);
  const [date, setDate] = useState(today());
  return (
    <BottomSheet onClose={onClose} title={w.workout.name}>
      <div className="m-stats">
        <Stat label="Duration" value={fmtClock(s.duration)} />
        <Stat label="TSS" value={Math.round(s.tss)} />
        <Stat label="IF" value={s.if.toFixed(2)} />
        <Stat
          label={r.zone === 'recovery' || r.zone === 'test' ? 'Type' : ZONE_NAMES[r.zone]}
          value={r.zone === 'recovery' || r.zone === 'test' ? ZONE_NAMES[r.zone] : r.level.toFixed(1)}
          sub={<span className={d.cls}>{d.label}</span>}
        />
      </div>
      <div className="m-chart-lg">
        <WorkoutChart intervals={ivs} ftp={ftp} height={120} />
      </div>
      {w.workout.description && <p className="m-desc">{w.workout.description}</p>}
      <div className="m-section-label">Schedule it</div>
      <div className="m-actions">
        <button className="m-btn" onClick={() => onAdd(today())}>Today</button>
        <button className="m-btn" onClick={() => onAdd(addDays(today(), 1))}>Tomorrow</button>
      </div>
      <div className="m-actions">
        <input className="m-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        <button className="m-btn primary" disabled={!date} onClick={() => onAdd(date)}>Add to calendar</button>
      </div>
    </BottomSheet>
  );
}

function PickerSheet({ title, workouts, ftp, levels, near, onPick, onClose }: {
  title: string;
  workouts: StoredWorkout[];
  ftp: number;
  levels: Levels;
  /** sort by closeness to this duration (swap) */
  near?: number;
  onPick: (w: Workout) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [zone, setZone] = useState<LevelZone | 'all'>('all');
  const list = useMemo(() => {
    let l = workouts.filter((w) => w.workout.name.toLowerCase().includes(q.toLowerCase()));
    if (zone !== 'all') l = l.filter((w) => rateWorkout(w.workout, ftp).zone === zone);
    if (near != null) {
      const dur = new Map(l.map((w) => [w.id, plannedStats(flatten(w.workout), ftp).duration]));
      l = [...l].sort((a, b) => Math.abs(dur.get(a.id)! - near) - Math.abs(dur.get(b.id)! - near));
    }
    return l;
  }, [workouts, q, zone, near, ftp]);
  return (
    <BottomSheet title={title} onClose={onClose}>
      <input className="m-search" placeholder="Search workouts" value={q} onChange={(e) => setQ(e.target.value)} />
      <ZoneChips zone={zone} onChange={setZone} />
      <div className="m-cards">
        {list.map((w) => (
          <WorkoutCard key={w.id} w={w.workout} ftp={ftp} levels={levels} onClick={() => onPick(w.workout)} />
        ))}
        {!list.length && <p className="muted">No workouts match.</p>}
      </div>
    </BottomSheet>
  );
}

function ZoneChips({ zone, onChange }: { zone: LevelZone | 'all'; onChange: (z: LevelZone | 'all') => void }) {
  return (
    <div className="m-chips">
      <button className={`m-chip ${zone === 'all' ? 'on' : ''}`} onClick={() => onChange('all')}>All</button>
      {LEVEL_ZONES.map((z) => (
        <button key={z} className={`m-chip ${zone === z ? 'on' : ''}`} onClick={() => onChange(z)} style={zone === z ? { background: LEVEL_COLORS[z], borderColor: LEVEL_COLORS[z] } : undefined}>
          {ZONE_NAMES[z]}
        </button>
      ))}
    </div>
  );
}

// ---------- workouts ----------

function WorkoutsScreen({ workouts, ftp, levels, onOpen }: { workouts: StoredWorkout[]; ftp: number; levels: Levels; onOpen: (w: StoredWorkout) => void }) {
  const [q, setQ] = useState('');
  const [zone, setZone] = useState<LevelZone | 'all'>('all');
  const [len, setLen] = useState<'all' | 'short' | 'mid' | 'long'>('all');
  const list = useMemo(
    () =>
      workouts.filter((w) => {
        if (!w.workout.name.toLowerCase().includes(q.toLowerCase())) return false;
        if (zone !== 'all' && rateWorkout(w.workout, ftp).zone !== zone) return false;
        if (len !== 'all') {
          const d = plannedStats(flatten(w.workout), ftp).duration / 60;
          if (len === 'short' && d > 45) return false;
          if (len === 'mid' && (d <= 45 || d > 75)) return false;
          if (len === 'long' && d <= 75) return false;
        }
        return true;
      }),
    [workouts, q, zone, len, ftp],
  );
  return (
    <>
      <header className="m-head static">
        <div className="m-head-row">
          <h1 className="m-h1">Workouts</h1>
          <span className="muted small">{list.length}</span>
        </div>
        <input className="m-search" placeholder="Search workouts" value={q} onChange={(e) => setQ(e.target.value)} />
        <ZoneChips zone={zone} onChange={setZone} />
        <div className="m-chips">
          {([['all', 'Any length'], ['short', '≤ 45 min'], ['mid', '45–75 min'], ['long', '75+ min']] as const).map(([k, l]) => (
            <button key={k} className={`m-chip ${len === k ? 'on' : ''}`} onClick={() => setLen(k)}>{l}</button>
          ))}
        </div>
      </header>
      <div className="m-cards m-pad">
        {list.map((w) => (
          <WorkoutCard key={w.id} w={w.workout} ftp={ftp} levels={levels} onClick={() => onOpen(w)} />
        ))}
        {!list.length && <p className="muted">No workouts match.</p>}
        <p className="muted small m-hint">Import and build workouts from RideBox on your computer.</p>
      </div>
    </>
  );
}

// ---------- progress ----------

function ProgressScreen(p: MobileAppProps) {
  const t = today();
  const { settings } = p;
  const entries = useMemo(() => loadEntries(p.rides, p.acts, settings.ftp, settings.maxHr), [p.rides, p.acts, settings.ftp, settings.maxHr]);
  const planned = useMemo(() => plannedLoad(p.calendar, settings.ftp), [p.calendar, settings.ftp]);
  const [range, setRange] = useState<FitnessRangeId>('3m');
  const days = rangeDays(range);
  const series = useMemo(() => {
    const all = fitnessSeries(entries, planned, addDays(t, -days - 365), addDays(t, 14), t);
    return all.slice(all.length - (days + 1 + 14));
  }, [entries, planned, t, days]);
  const weeks = useMemo(() => weeklyTotals(entries, addDays(t, -days), t), [entries, t, days]);
  const now = series.find((d) => d.date === t) ?? series[series.length - 1];
  const recent = p.levelHistory.filter((h) => h.after !== h.before).slice(-4).reverse();

  return (
    <>
      <header className="m-head">
        <div className="m-head-row">
          <h1 className="m-h1">Progress</h1>
        </div>
      </header>
      <div className="m-pad">
        <div className="m-section-label">Progression levels</div>
        <div className="m-card">
          {LEVEL_ZONES.map((z) => {
            const v = p.levels[z];
            return (
              <div className="m-level" key={z}>
                <span className="m-level-name">{ZONE_NAMES[z]}</span>
                <span className="m-level-track">
                  <span style={{ width: `${((v ?? 0) / 10) * 100}%`, background: LEVEL_COLORS[z] }} />
                </span>
                <span className="m-level-val" style={{ color: v == null ? 'var(--muted)' : LEVEL_COLORS[z] }}>{v == null ? '–' : v.toFixed(1)}</span>
              </div>
            );
          })}
          {recent.length > 0 && (
            <div className="m-level-recent">
              {recent.map((h, i) => (
                <div key={i} className="small">
                  <span className={h.after > (h.before ?? 0) ? 'ok' : 'muted'}>{h.before == null ? '●' : h.after > h.before ? '▲' : '▼'}</span> {ZONE_NAMES[h.zone]} {h.after.toFixed(1)}
                  <span className="muted"> · {h.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="m-section-label">Fitness</div>
        <div className="m-stats four">
          <Stat label="Fitness" value={<span style={{ color: SERIES.ctl }}>{Math.round(now?.ctl ?? 0)}</span>} sub="CTL" />
          <Stat label="Fatigue" value={<span style={{ color: SERIES.atl }}>{Math.round(now?.atl ?? 0)}</span>} sub="ATL" />
          <Stat label="Form" value={<span style={{ color: SERIES.tsb }}>{Math.round(now?.tsb ?? 0)}</span>} sub={formLabel(now?.tsb ?? 0)} />
          <Stat label="FTP" value={<>{settings.ftp}<small className="m-stat-unit"> W</small></>} sub={`${settings.riderKg > 0 ? (settings.ftp / settings.riderKg).toFixed(2) : '–'} W/kg`} />
        </div>
        <div className="m-card">
          <div className="row space">
            <div className="small muted">Dashed is your plan</div>
            <RangeSelect value={range} onChange={setRange} />
          </div>
          <FitnessChart days={series} height={190} />
        </div>
        <div className="m-card">
          <div className="small muted">Weekly TSS</div>
          <WeeklyBars weeks={weeks} />
        </div>
        <RiderLog settings={settings} today={t} onChange={p.onSettingsChange} />
      </div>
    </>
  );
}

// ---------- account ----------

function MoreScreen(p: MobileAppProps & { onOpenActivity: (e: LoadEntry) => void }) {
  const { settings } = p;
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const imperial = s.units === 'imperial';
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const entries = useMemo(() => loadEntries(p.rides, p.acts, settings.ftp, settings.maxHr).slice(-15).reverse(), [p.rides, p.acts, settings.ftp, settings.maxHr]);
  const SYNC: Record<SyncStatus, string> = { off: 'This device only', syncing: 'Syncing…', synced: 'Synced', offline: 'Offline', error: 'Sync error' };

  return (
    <>
      <header className="m-head">
        <div className="m-head-row">
          <h1 className="m-h1">Account</h1>
          <button className={`m-chip sync-${p.syncStatus}`} onClick={p.onSyncNow}>{SYNC[p.syncStatus]}</button>
        </div>
      </header>
      <div className="m-pad">
        {p.syncEmail && <p className="muted small">Signed in as {p.syncEmail}</p>}
        <div className="m-section-label">Rider</div>
        <div className="m-card m-form">
          <label className="m-row-field">
            <span>FTP</span>
            <span><input type="number" inputMode="numeric" value={s.ftp} onChange={(e) => setS({ ...s, ftp: Number(e.target.value) })} /> W</span>
          </label>
          <label className="m-row-field">
            <span>Weight</span>
            <span>
              <input
                type="number"
                inputMode="decimal"
                value={imperial ? Math.round(s.riderKg * 2.20462) : Math.round(s.riderKg * 10) / 10}
                onChange={(e) => setS({ ...s, riderKg: imperial ? Number(e.target.value) / 2.20462 : Number(e.target.value) })}
              />{' '}
              {imperial ? 'lb' : 'kg'}
            </span>
          </label>
          <label className="m-row-field">
            <span>Max heart rate</span>
            <span><input type="number" inputMode="numeric" value={s.maxHr} onChange={(e) => setS({ ...s, maxHr: Number(e.target.value) })} /> bpm</span>
          </label>
          <label className="m-row-field">
            <span>Units</span>
            <select value={s.units} onChange={(e) => setS({ ...s, units: e.target.value as Settings['units'] })}>
              <option value="imperial">Imperial</option>
              <option value="metric">Metric</option>
            </select>
          </label>
          {dirty && (
            <div className="m-actions">
              <button className="m-btn" onClick={() => setS(settings)}>Cancel</button>
              <button className="m-btn primary" onClick={() => p.onSettingsChange(s)}>Save</button>
            </div>
          )}
        </div>

        <div className="m-section-label">Recent activities</div>
        <div className="m-card m-list flush">
          {entries.map((e) => (
            <button key={e.id} className="m-list-item row-item" onClick={() => p.onOpenActivity(e)}>
              <span>
                <b>{e.name}</b>
                <span className="muted small"> {dayStart(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {e.kind === 'strava' ? 'Strava' : 'RideBox'}</span>
              </span>
              <span className="muted small nowrap">{fmtHm(e.seconds)} · {Math.round(e.tss)}</span>
            </button>
          ))}
          {!entries.length && <p className="muted small" style={{ padding: 12 }}>No activities yet.</p>}
        </div>

        <div className="m-section-label">Strava</div>
        <div className="m-card m-strava">
          <StravaSettings config={p.strava} onChange={p.onStravaChange} onImported={p.onImported} />
        </div>

        <button className="m-btn block ghost" onClick={p.onDesktop}>Open the full desktop site</button>
      </div>
    </>
  );
}
