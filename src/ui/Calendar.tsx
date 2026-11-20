import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RideRecord } from '../app/recorder';
import type { Settings, StoredWorkout } from '../storage/db';
import { copyTo, monthWeeks, moveTo, newPlanned, scaleWorkout, weekStart } from '../training/calendar';
import { addDays, dayKey, dayStart, loadEntries, today, type LoadEntry } from '../training/load';
import type { DayKey, PlannedWorkout, StravaActivity, TrainingPlan } from '../training/model';
import { flatten, formatDuration, intervalFtpFraction, plannedStats, zoneFor, type Workout } from '../workout/model';
import { WorkoutChart } from './WorkoutChart';
import { rateWorkout, type Levels } from '../training/levels';
import { LevelBadge } from './Levels';
import { ActualDetail } from './ActualDetail';
import { CardActual } from './CardActual';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PHASE_COLORS: Record<string, string> = { base: '#2f80ed', build: '#27ae60', specialty: '#f2994a', peak: '#f2994a', taper: '#9b8afb', recovery: '#8a8f98', race: '#eb5757' };
const phaseColor = (name: string) => PHASE_COLORS[Object.keys(PHASE_COLORS).find((k) => name.toLowerCase().includes(k)) ?? ''] ?? '#5c6b80';

export interface CalendarProps {
  calendar: PlannedWorkout[];
  plans: TrainingPlan[];
  rides: RideRecord[];
  acts: StravaActivity[];
  workouts: StoredWorkout[];
  settings: Settings;
  levels: Levels;
  /** create or update calendar items */
  onSave: (items: PlannedWorkout[]) => void;
  onDelete: (ids: string[]) => void;
  onRide: (p: PlannedWorkout) => void;
  onOpenRide: (rideId: string) => void;
  /** coach buttons (plan builder, today's recommendation, adaptations) */
  toolbar?: ReactNode;
  /** banner above the grid (pending adaptations) */
  banner?: ReactNode;
}

/** Main color of a workout: the zone of its hardest sustained interval. */
function workoutColor(w: Workout, ftp: number) {
  const ivs = flatten(w).filter((iv) => !iv.free && iv.duration >= 30);
  if (!ivs.length) return '#5c6b80';
  const hardest = Math.max(...ivs.map((iv) => intervalFtpFraction(iv, ftp)));
  return zoneFor(hardest).color;
}

export function Calendar(props: CalendarProps) {
  const { calendar, plans, rides, acts, workouts, settings, levels, onSave, onDelete, onRide, onOpenRide } = props;
  const t = today();
  const [view, setView] = useState<'month' | 'week'>(() => (window.innerWidth < 700 ? 'week' : 'month'));
  const [anchor, setAnchor] = useState<DayKey>(t);
  const [open, setOpen] = useState<string | null>(null);
  const [picker, setPicker] = useState<DayKey | null>(null);
  const [dragOver, setDragOver] = useState<DayKey | null>(null);
  const [moving, setMoving] = useState<string | null>(null); // click-to-move (keyboard / touch)
  const [openAct, setOpenAct] = useState<LoadEntry | null>(null);

  const a = dayStart(anchor);
  const weeks = view === 'month' ? monthWeeks(a.getFullYear(), a.getMonth()) : [weekStart(anchor)];
  const byDay = useMemo(() => {
    const m = new Map<DayKey, PlannedWorkout[]>();
    for (const p of calendar) m.set(p.date, [...(m.get(p.date) ?? []), p]);
    for (const list of m.values()) list.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    return m;
  }, [calendar]);
  const linked = useMemo(() => new Set(calendar.flatMap((p) => [p.rideId, p.stravaId]).filter(Boolean) as string[]), [calendar]);
  const entries = useMemo(() => loadEntries(rides, acts, settings.ftp, settings.maxHr), [rides, acts, settings.ftp, settings.maxHr]);
  const actsByDay = useMemo(() => {
    const m = new Map<DayKey, LoadEntry[]>();
    for (const e of entries) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [entries]);
  const stats = useMemo(() => new Map(calendar.map((p) => [p.id, plannedStats(flatten(p.workout), settings.ftp)])), [calendar, settings.ftp]);
  const intervalsById = useMemo(() => new Map(calendar.map((p) => [p.id, flatten(p.workout)])), [calendar]);
  const ridesById = useMemo(() => new Map(rides.map((r) => [r.id, r])), [rides]);
  const actsById = useMemo(() => new Map(acts.map((x) => [x.id, x])), [acts]);
  const tssById = useMemo(() => new Map(entries.map((e) => [e.id, e.tss])), [entries]);
  const activePlan = plans.find((p) => p.active);
  const phaseOn = (k: DayKey) => activePlan?.phases.find((ph) => ph.start <= k && k <= ph.end);

  const shift = (n: number) => {
    if (view === 'week') setAnchor(addDays(anchor, 7 * n));
    else setAnchor(dayKey(new Date(a.getFullYear(), a.getMonth() + n, 1)));
  };
  const title =
    view === 'month'
      ? a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : `${dayStart(weeks[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${dayStart(addDays(weeks[0], 6)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  function drop(date: DayKey, id: string, copy: boolean) {
    const p = calendar.find((x) => x.id === id);
    if (!p) return;
    if (copy) onSave([copyTo(p, date, calendar)]);
    else if (p.date !== date) onSave([moveTo(p, date, calendar, t)]);
  }

  const selected = calendar.find((p) => p.id === open) ?? null;

  return (
    <div className="page wide">
      <div className="cal-toolbar">
        <div className="row">
          <button onClick={() => shift(-1)} aria-label="Previous">◀</button>
          <button onClick={() => setAnchor(t)}>Today</button>
          <button onClick={() => shift(1)} aria-label="Next">▶</button>
          <h2 className="cal-title">{title}</h2>
        </div>
        <div className="row">
          {props.toolbar}
          <div className="seg">
            <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>Month</button>
            <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>Week</button>
          </div>
        </div>
      </div>
      {props.banner}
      {moving && (
        <div className="banner">
          Pick a day for <b>{calendar.find((p) => p.id === moving)?.workout.name}</b>.{' '}
          <button className="ghost" onClick={() => setMoving(null)}>Cancel</button>
        </div>
      )}

      <div className={`cal cal-view-${view}`}>
        <div className="cal-head">
          {DOW.map((d) => <div key={d}>{d}</div>)}
          <div>Week</div>
        </div>
        {weeks.map((w) => {
          const days = Array.from({ length: 7 }, (_, i) => addDays(w, i));
          let plannedTss = 0;
          let plannedSec = 0;
          let doneTss = 0;
          let doneSec = 0;
          for (const d of days) {
            for (const p of byDay.get(d) ?? []) {
              const s = stats.get(p.id)!;
              plannedTss += s.tss;
              plannedSec += s.duration;
            }
            for (const e of actsByDay.get(d) ?? []) {
              doneTss += e.tss;
              doneSec += e.seconds;
            }
          }
          const ph = phaseOn(addDays(w, 3));
          return (
            <div className="cal-row" key={w}>
              {days.map((d) => {
                const items = byDay.get(d) ?? [];
                const extra = (actsByDay.get(d) ?? []).filter((e) => !linked.has(e.id));
                const out = view === 'month' && dayStart(d).getMonth() !== a.getMonth();
                const phase = phaseOn(d);
                return (
                  <div
                    key={d}
                    className={`cal-day${d === t ? ' today' : ''}${out ? ' out' : ''}${dragOver === d ? ' over' : ''}${moving ? ' pickable' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
                      setDragOver(d);
                    }}
                    onDragLeave={() => setDragOver((x) => (x === d ? null : x))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(null);
                      const id = e.dataTransfer.getData('text/ridebox-planned');
                      if (id) drop(d, id, e.altKey);
                    }}
                    onClick={() => {
                      if (!moving) return;
                      drop(d, moving, false);
                      setMoving(null);
                    }}
                  >
                    {phase && <div className="cal-phase" style={{ background: phaseColor(phase.name) }} title={`${phase.name}: ${phase.focus}`} />}
                    <div className="cal-date">
                      <span className="cal-dow">{DOW[(dayStart(d).getDay() + 6) % 7]} </span>
                      {dayStart(d).getDate()}
                      <button className="cal-add" title="Add a workout" onClick={(e) => { e.stopPropagation(); setPicker(d); }}>+</button>
                    </div>
                    {items.map((p) => {
                      const s = stats.get(p.id)!;
                      const ride = p.rideId ? ridesById.get(p.rideId) : undefined;
                      const act = p.stravaId ? actsById.get(p.stravaId) : undefined;
                      const ridden = p.status === 'done' && (ride || act);
                      return (
                        <div
                          key={p.id}
                          className={`cal-card status-${p.status}`}
                          style={{ borderLeftColor: workoutColor(p.workout, settings.ftp) }}
                          draggable
                          tabIndex={0}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/ridebox-planned', p.id);
                            e.dataTransfer.effectAllowed = 'copyMove';
                          }}
                          onClick={(e) => {
                            if (moving) return;
                            e.stopPropagation();
                            setOpen(p.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setOpen(p.id);
                            if (e.key === 'm') setMoving(p.id);
                            if (e.key === 'Delete' || e.key === 'Backspace') onDelete([p.id]);
                          }}
                          title={p.rationale ?? p.workout.description ?? ''}
                        >
                          <div className="cal-card-name">
                            {p.status === 'done' ? '✓ ' : p.status === 'missed' ? '✕ ' : p.status === 'skipped' ? '⤼ ' : ''}
                            {p.workout.name}
                          </div>
                          {ridden ? (
                            <CardActual
                              ride={ride}
                              act={act}
                              intervals={intervalsById.get(p.id)}
                              ftp={settings.ftp}
                              tss={tssById.get(ride?.id ?? act?.id ?? '')}
                              plannedTss={s.tss}
                              chart={view === 'week'}
                            />
                          ) : (
                            <>
                              <div className="cal-card-meta">
                                {formatDuration(s.duration)} · TSS {Math.round(s.tss)}
                                {p.origin === 'adapt' && <span className="tag">adapted</span>}
                              </div>
                              <div className="cal-card-meta">
                                <LevelBadge rating={rateWorkout(p.workout, settings.ftp)} levels={levels} compact={view === 'month'} />
                              </div>
                              {view === 'week' && <WorkoutChart intervals={intervalsById.get(p.id)!} ftp={settings.ftp} height={36} />}
                            </>
                          )}
                        </div>
                      );
                    })}
                    {extra.map((e) => (
                      <div
                        key={e.id}
                        className="cal-card activity"
                        onClick={(ev) => {
                          if (moving) return;
                          ev.stopPropagation();
                          setOpenAct(e);
                        }}
                        title={e.kind === 'strava' ? 'From Strava' : 'RideBox ride'}
                      >
                        <div className="cal-card-name">{e.kind === 'strava' ? '◆ ' : '● '}{e.name}</div>
                        <CardActual
                          ride={e.kind === 'ridebox' ? ridesById.get(e.id) : undefined}
                          act={e.kind === 'strava' ? actsById.get(e.id) : undefined}
                          ftp={settings.ftp}
                          tss={e.tss}
                          chart={view === 'week'}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
              <div className="cal-week">
                {ph && <div className="cal-week-phase" style={{ color: phaseColor(ph.name) }}>{ph.name}</div>}
                <div className="muted">Planned</div>
                <div className="nowrap">{Math.round(plannedTss)} TSS · {(plannedSec / 3600).toFixed(1)} h</div>
                <div className="muted">Done</div>
                <div className="nowrap">{Math.round(doneTss)} TSS · {(doneSec / 3600).toFixed(1)} h</div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">
        Drag workouts to move them (hold <kbd>Alt</kbd>/<kbd>⌥</kbd> while dropping to copy). Keyboard: focus a workout and press <kbd>M</kbd> to move,{' '}
        <kbd>Delete</kbd> to remove. ◆ = from Strava, ● = RideBox ride not on the plan.
      </p>

      {selected && (
        <WorkoutDetail
          p={selected}
          settings={settings}
          levels={levels}
          ride={rides.find((r) => r.id === selected.rideId)}
          act={acts.find((x) => x.id === selected.stravaId)}
          onClose={() => setOpen(null)}
          onSave={(p) => onSave([p])}
          onDelete={() => {
            onDelete([selected.id]);
            setOpen(null);
          }}
          onRide={() => onRide(selected)}
          onMove={() => {
            setMoving(selected.id);
            setOpen(null);
          }}
          onOpenRide={onOpenRide}
          todayKey={t}
          calendar={calendar}
        />
      )}
      {openAct && (
        <ActivityModal
          entry={openAct}
          ride={rides.find((r) => r.id === openAct.id)}
          act={acts.find((x) => x.id === openAct.id)}
          settings={settings}
          onOpenRide={onOpenRide}
          onClose={() => setOpenAct(null)}
        />
      )}
      {picker && (
        <WorkoutPicker
          date={picker}
          workouts={workouts}
          ftp={settings.ftp}
          levels={levels}
          onPick={(w) => {
            onSave([newPlanned(w, picker, calendar)]);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row space">
          <h3>{title}</h3>
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function WorkoutDetail({ p, settings, levels, ride, act, onClose, onSave, onDelete, onRide, onMove, onOpenRide, todayKey, calendar }: {
  p: PlannedWorkout;
  settings: Settings;
  levels: Levels;
  ride?: RideRecord;
  act?: StravaActivity;
  onClose: () => void;
  onSave: (p: PlannedWorkout) => void;
  onDelete: () => void;
  onRide: () => void;
  onMove: () => void;
  onOpenRide: (id: string) => void;
  todayKey: DayKey;
  calendar: PlannedWorkout[];
}) {
  const ivs = flatten(p.workout);
  const s = plannedStats(ivs, settings.ftp);
  const [note, setNote] = useState(p.note ?? '');
  return (
    <Modal title={p.workout.name} onClose={onClose}>
      <div className="muted small">
        {dayStart(p.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · {formatDuration(s.duration)} · TSS {Math.round(s.tss)} · IF{' '}
        {s.if.toFixed(2)}
        {p.phase ? ` · ${p.phase}` : ''} · <LevelBadge rating={rateWorkout(p.workout, settings.ftp)} levels={levels} />
      </div>
      {ride || act ? <ActualDetail ride={ride} act={act} intervals={ivs} settings={settings} /> : <WorkoutChart intervals={ivs} ftp={settings.ftp} height={110} />}
      {p.workout.description && <p className="desc">{p.workout.description}</p>}
      {p.rationale && (
        <p className="small">
          <b>Coach:</b> {p.rationale}
        </p>
      )}
      <div className="small">
        Status: <b>{p.status}</b>
        {ride && (
          <>
            {' '}· <button className="link" onClick={() => onOpenRide(ride.id)}>{ride.name}</button> ({Math.round(ride.summary.tss)} TSS)
          </>
        )}
        {act && <> · Strava: {act.name}</>}
      </div>
      <label className="field">
        <span>Note</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (p.note ?? '') && onSave({ ...p, note })} />
      </label>
      <div className="row wrap">
        {p.status !== 'done' && <button className="primary" onClick={onRide}>Ride now ▶</button>}
        <button onClick={() => onSave({ ...p, workout: scaleWorkout(p.workout, 0.95) })} title="Work intervals 5% lower">Easier</button>
        <button onClick={() => onSave({ ...p, workout: scaleWorkout(p.workout, 1.05) })} title="Work intervals 5% higher">Harder</button>
        <button onClick={onMove}>Move…</button>
        <input
          type="date"
          aria-label="Move to date"
          value={p.date}
          onChange={(e) => e.target.value && onSave(moveTo(p, e.target.value, calendar, todayKey))}
        />
        {p.status === 'planned' || p.status === 'missed' ? (
          <button onClick={() => onSave({ ...p, status: 'skipped' })}>Skip</button>
        ) : p.status === 'skipped' ? (
          <button onClick={() => onSave({ ...p, status: 'planned' })}>Unskip</button>
        ) : (
          <button onClick={() => onSave({ ...p, status: 'planned', rideId: undefined, stravaId: undefined })}>Unlink ride</button>
        )}
        <button className="danger" onClick={onDelete}>Remove</button>
      </div>
    </Modal>
  );
}

/** A ride that wasn't on the plan: its stats and power / HR / cadence. */
function ActivityModal({ entry, ride, act, settings, onOpenRide, onClose }: {
  entry: LoadEntry;
  ride?: RideRecord;
  act?: StravaActivity;
  settings: Settings;
  onOpenRide: (id: string) => void;
  onClose: () => void;
}) {
  const when = ride?.startTime ?? act?.start;
  return (
    <Modal title={entry.name} onClose={onClose}>
      <div className="muted small">
        {when ? new Date(when).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : entry.date}
        {act ? ` · ${act.sportType}${act.trainer ? ' (trainer)' : ''} · from Strava` : ride ? ` · ${ride.routeName}` : ''}
        {ride?.workoutName ? ` · ${ride.workoutName}` : ''}
      </div>
      <ActualDetail ride={ride} act={act} settings={settings} tss={entry.tss} />
      <div className="row">
        {ride && <button onClick={() => { onClose(); onOpenRide(ride.id); }}>Open ride page</button>}
        {act && <a className="strava-link" href={`https://www.strava.com/activities/${act.stravaId}`} target="_blank" rel="noreferrer">View on Strava ↗</a>}
      </div>
    </Modal>
  );
}

function WorkoutPicker({ date, workouts, ftp, levels, onPick, onClose }: {
  levels: Levels;
  date: DayKey;
  workouts: StoredWorkout[];
  ftp: number;
  onPick: (w: Workout) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const list = workouts.filter((w) => w.workout.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title={`Add to ${dayStart(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`} onClose={onClose}>
      <input autoFocus placeholder="Search workouts" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        {list.map((w) => {
          const ivs = flatten(w.workout);
          const s = plannedStats(ivs, ftp);
          return (
            <button key={w.id} className="picker-item" onClick={() => onPick(w.workout)}>
              <div className="row space">
                <b>{w.workout.name}</b>
                <span className="muted small">
                  {formatDuration(s.duration)} · TSS {Math.round(s.tss)} · <LevelBadge rating={rateWorkout(w.workout, ftp)} levels={levels} />
                </span>
              </div>
              <WorkoutChart intervals={ivs} ftp={ftp} height={30} />
            </button>
          );
        })}
        {!list.length && <p className="muted">No workouts match.</p>}
      </div>
    </Modal>
  );
}
