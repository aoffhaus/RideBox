// Phone layout: a schedule-first app with a bottom tab bar (Calendar, Workouts,
// Progress, More). There's no riding here; rides happen on the desktop site.

import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import type { RideRecord } from '../app/recorder';
import type { Settings, StoredWorkout } from '../storage/db';
import type { StravaConfig } from '../strava/strava';
import type { SyncStatus } from '../storage/sync';
import { monthWeeks, moveTo, newPlanned, scaleWorkout, weekStart } from '../training/calendar';
import { addDays, dayKey, dayStart, estimateFtp, fitnessSeries, formLabel, loadEntries, plannedLoad, today, weeklyTotals, type LoadEntry } from '../training/load';
import type { DayKey, PlannedWorkout, StravaActivity, TrainingPlan } from '../training/model';
import { LEVEL_ZONES, ZONE_NAMES, difficultyLabel, rateWorkout, type LevelEvent, type LevelZone, type Levels } from '../training/levels';
import type { AdaptSuggestion, CoachState } from '../training/coach';
import type { AdaptInput } from '../training/coachSchema';
import { flatten, formatDuration, intervalFtpFraction, plannedStats, zoneFor, type Workout } from '../workout/model';
import { WorkoutChart } from '../ui/WorkoutChart';
import { LEVEL_COLORS } from '../ui/Levels';
import { FitnessChart, SERIES, WeeklyBars } from '../ui/FitnessChart';
import { StravaSettings } from '../ui/StravaSettings';
import { TodayCard } from '../ui/Coach';
import { distUnit, fmtDist, r0 } from '../ui/format';

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
  onBuildPlan: () => void;
  onManagePlans: () => void;
  onAdapt: (input: AdaptInput) => void;
  onDismissSuggestion: () => void;
  onAddToday: (w: Workout, reason: string) => Promise<unknown>;
  onSyncNow: () => void;
  onDesktop: () => void;
}

type MTab = 'calendar' | 'workouts' | 'progress' | 'more';

type Sheet =
  | { kind: 'planned'; id: string }
  | { kind: 'activity'; entry: LoadEntry }
  | { kind: 'library'; w: StoredWorkout }
  | { kind: 'add'; date: DayKey }
  | { kind: 'swap'; id: string }
  | { kind: 'coach' };

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
          <CalendarScreen {...p} onOpen={setSheet} />
        ) : tab === 'workouts' ? (
          <WorkoutsScreen workouts={p.workouts} ftp={ftp} levels={p.levels} onOpen={(w) => setSheet({ kind: 'library', w })} />
        ) : tab === 'progress' ? (
          <ProgressScreen {...p} />
        ) : (
          <MoreScreen {...p} onOpenActivity={(entry) => setSheet({ kind: 'activity', entry })} />
        )}
      </main>

      <nav className="m-tabbar">
        {(['calendar', 'workouts', 'progress', 'more'] as MTab[]).map((t) => (
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
      {sheet?.kind === 'activity' && <ActivitySheet entry={sheet.entry} rides={p.rides} settings={p.settings} onClose={close} />}
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

function CalendarScreen(p: MobileAppProps & { onOpen: (s: Sheet) => void }) {
  const t = today();
  const ftp = p.settings.ftp;
  const [selected, setSelected] = useState<DayKey>(t);
  const [monthOpen, setMonthOpen] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState<DayKey>(t);
  const week = weekStart(selected);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const dayRefs = useRef(new Map<DayKey, HTMLElement>());
  const scrollPending = useRef(false);

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
  const stats = useMemo(() => new Map(p.calendar.map((c) => [c.id, plannedStats(flatten(c.workout), ftp)])), [p.calendar, ftp]);
  const activePlan = p.plans.find((x) => x.active);
  const phase = activePlan?.phases.find((ph) => ph.start <= addDays(week, 3) && addDays(week, 3) <= ph.end);

  let plannedTss = 0;
  let plannedSec = 0;
  let doneTss = 0;
  let doneSec = 0;
  for (const d of days) {
    for (const c of byDay.get(d) ?? []) {
      if (c.status === 'skipped') continue;
      plannedTss += stats.get(c.id)!.tss;
      plannedSec += stats.get(c.id)!.duration;
    }
    for (const e of actsByDay.get(d) ?? []) {
      doneTss += e.tss;
      doneSec += e.seconds;
    }
  }

  const go = (d: DayKey, scroll = true) => {
    setSelected(d);
    scrollPending.current = scroll;
  };
  const headRef = useRef<HTMLElement>(null);
  const scrollToDay = (d: DayKey, smooth: boolean) => {
    const el = dayRefs.current.get(d);
    if (!el) return;
    const off = (headRef.current?.getBoundingClientRect().height ?? 0) + 12;
    window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - off), behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    if (!scrollPending.current) return;
    scrollPending.current = false;
    scrollToDay(selected, true);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  // open on today
  useEffect(() => {
    if (t !== week) scrollToDay(t, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const swipe = useSwipe(
    () => go(addDays(selected, 7), false),
    () => go(addDays(selected, -7), false),
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
            <button className="m-icon-btn" aria-label="Previous week" onClick={() => go(addDays(selected, -7), false)}>{Icon.chevL}</button>
            <div className="m-week-days">
              {days.map((d, i) => (
                <button key={d} className={`m-wday${d === t ? ' today' : ''}${d === selected ? ' sel' : ''}`} onClick={() => go(d)}>
                  <span className="m-dow">{DOW1[i]}</span>
                  <span className="m-num">{dayStart(d).getDate()}</span>
                  {dots(d)}
                </button>
              ))}
            </div>
            <button className="m-icon-btn" aria-label="Next week" onClick={() => go(addDays(selected, 7), false)}>{Icon.chevR}</button>
          </div>
        )}
      </header>

      <section className="m-weeksum">
        <div className="m-weeksum-top">
          <span>
            {phase ? <b style={{ color: 'var(--accent-2)' }}>{phase.name}</b> : <b>This week</b>}
            {week !== weekStart(t) && <span className="muted"> · {dayStart(week).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
          </span>
          <span className="muted small">
            {Math.round(doneTss)} / {Math.round(plannedTss)} TSS · {fmtHm(doneSec)} / {fmtHm(plannedSec)}
          </span>
        </div>
        <div className="m-bar">
          <div style={{ width: `${plannedTss ? Math.min(100, (doneTss / plannedTss) * 100) : doneTss ? 100 : 0}%` }} />
        </div>
      </section>

      {activePlan && (
        <div className="m-plan">
          <b>{activePlan.name}</b>
          <span className="muted small">
            {activePlan.eventDate ? `Event ${dayStart(activePlan.eventDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : `Until ${dayStart(activePlan.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
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

      <div className="m-agenda">
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          const extra = (actsByDay.get(d) ?? []).filter((e) => !linked.has(e.id));
          return (
            <section
              key={d}
              className={`m-day${d === t ? ' today' : ''}${d === selected ? ' sel' : ''}`}
              ref={(el) => {
                if (el) dayRefs.current.set(d, el);
                else dayRefs.current.delete(d);
              }}
            >
              <div className="m-day-head">
                <div>
                  <span className="m-day-rel">{relDay(d, t)}</span>
                  <span className="m-day-date">{dayStart(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                </div>
                <button className="m-icon-btn add" aria-label={`Add a workout on ${longDay(d)}`} onClick={() => p.onOpen({ kind: 'add', date: d })}>
                  {Icon.plus}
                </button>
              </div>
              {items.map((c) => (
                <WorkoutCard
                  key={c.id}
                  w={c.workout}
                  ftp={ftp}
                  levels={p.levels}
                  status={c.status}
                  tag={c.origin === 'adapt' ? 'Adapted' : undefined}
                  onClick={() => p.onOpen({ kind: 'planned', id: c.id })}
                />
              ))}
              {extra.map((e) => (
                <button key={e.id} className="m-acard" onClick={() => p.onOpen({ kind: 'activity', entry: e })}>
                  <span className="m-acard-ico">{e.kind === 'strava' ? '◆' : '●'}</span>
                  <span className="m-acard-name">{e.name}</span>
                  <span className="muted small">
                    {fmtHm(e.seconds)} · {Math.round(e.tss)} TSS
                  </span>
                </button>
              ))}
              {!items.length && !extra.length && <div className="m-rest">{d < t ? 'No workout' : 'Rest day'}</div>}
            </section>
          );
        })}
      </div>
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

      <div className={`m-status st-${p.status}`}>
        <span className={`m-pill pill-${p.status}`}>{STATUS_LABEL[p.status]}</span>
        {ride && (
          <span className="small">
            {ride.name} · {formatDuration(ride.summary.duration)} · {Math.round(ride.summary.tss)} TSS · {r0(ride.summary.np)} W NP
          </span>
        )}
        {act && <span className="small">Strava: {act.name}</span>}
      </div>

      {p.workout.description && <p className="m-desc">{p.workout.description}</p>}
      {p.rationale && (
        <div className="m-coach-note">
          <span className="m-coach-ico">{Icon.sparkle}</span>
          <span>{p.rationale}</span>
        </div>
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

function ActivitySheet({ entry, rides, settings, onClose }: { entry: LoadEntry; rides: RideRecord[]; settings: Settings; onClose: () => void }) {
  const ride = entry.kind === 'ridebox' ? rides.find((r) => r.id === entry.id) : undefined;
  return (
    <BottomSheet
      onClose={onClose}
      title={
        <>
          <div className="m-sheet-kicker">{longDay(entry.date)} · {entry.kind === 'strava' ? 'Strava' : 'RideBox'}</div>
          {entry.name}
        </>
      }
    >
      <div className="m-stats">
        <Stat label="Time" value={fmtClock(entry.seconds)} />
        <Stat label="TSS" value={Math.round(entry.tss)} sub={entry.source === 'estimate' ? 'estimated' : entry.source === 'hr' ? 'from HR' : undefined} />
        {ride && <Stat label="NP" value={`${r0(ride.summary.np)} W`} />}
        {ride && <Stat label="Avg power" value={`${r0(ride.summary.avgPower)} W`} />}
        {ride?.summary.avgHr != null && <Stat label="Avg HR" value={r0(ride.summary.avgHr)} />}
        {ride && <Stat label="Distance" value={`${fmtDist(ride.summary.distance, settings)} ${distUnit(settings)}`} />}
      </div>
      {!ride && entry.kind === 'ridebox' && <p className="muted">This ride isn&apos;t on this device yet.</p>}
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
  const series = useMemo(() => {
    const all = fitnessSeries(entries, planned, addDays(t, -42 - 365), addDays(t, 14), t);
    return all.slice(all.length - (42 + 1 + 14));
  }, [entries, planned, t]);
  const weeks = useMemo(() => weeklyTotals(entries, addDays(t, -55), t), [entries, t]);
  const est = useMemo(() => estimateFtp(p.rides), [p.rides]);
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
          <Stat label="FTP" value={settings.ftp} sub={est && Math.abs(est.ftp - settings.ftp) >= 3 ? `est. ${est.ftp}` : 'W'} />
        </div>
        {est && Math.abs(est.ftp - settings.ftp) >= 3 && (
          <button className="m-btn block" onClick={() => p.onSettingsChange({ ...settings, ftp: est.ftp })}>
            Use estimated FTP {est.ftp} W
          </button>
        )}
        <div className="m-card">
          <div className="small muted">Last 6 weeks · dashed is your plan</div>
          <FitnessChart days={series} height={190} />
        </div>
        <div className="m-card">
          <div className="small muted">Weekly TSS</div>
          <WeeklyBars weeks={weeks} />
        </div>
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
          <StravaSettings config={p.strava} onChange={p.onStravaChange} />
        </div>

        <button className="m-btn block ghost" onClick={p.onDesktop}>Open the full desktop site</button>
      </div>
    </>
  );
}
