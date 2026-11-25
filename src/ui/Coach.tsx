import { useEffect, useRef, useState } from 'react';
import { askCoach, buildContext, planFromOutput, reviewAdaptation, todayOptions, type CoachState, type PlanResult, type ReviewedChange, type TodayOption } from '../training/coach';
import { WEEKDAYS, type AdaptInput, type AdaptOutput, type CoachEvent, type PlanInput, type PlanOutput, type TodayInput, type TodayOutput, type Weekday } from '../training/coachSchema';
import { addDays, dayStart } from '../training/load';
import type { PlannedWorkout, TrainingPlan } from '../training/model';
import { weekStart } from '../training/calendar';
import { rateWorkout } from '../training/levels';
import { flatten, formatDuration, intervalFtpFraction, plannedStats, zoneFor, type Workout } from '../workout/model';
import { Modal } from './Calendar';
import { WorkoutChart, intervalPowerText } from './WorkoutChart';

// ---------- running a coach request ----------

function useCoach() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [thinking, setThinking] = useState('');
  const [tokens, setTokens] = useState(0);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  async function run<T>(fn: (onEvent: (e: CoachEvent) => void, signal: AbortSignal) => Promise<T>): Promise<T | null> {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setStatus('Sending your training data to the coach…');
    setThinking('');
    setTokens(0);
    setError('');
    try {
      return await fn((e) => {
        if (e.type === 'status') setStatus(e.text);
        else if (e.type === 'thinking') setThinking((t) => t + e.text);
        else if (e.type === 'progress') setTokens(e.outputTokens);
      }, ac.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      return null;
    } finally {
      if (abort.current === ac) setRunning(false);
    }
  }
  const cancel = () => {
    abort.current?.abort();
    setRunning(false);
  };
  return { running, status, thinking, tokens, error, run, cancel };
}

function CoachProgress({ c }: { c: ReturnType<typeof useCoach> }) {
  const [open, setOpen] = useState(false);
  if (!c.running && !c.error) return null;
  if (c.error) return <div className="banner err">{c.error}</div>;
  return (
    <div className="coach-progress">
      <div className="row space">
        <div className="row">
          <span className="spinner" aria-hidden /> <b>{c.status}</b>
          {c.tokens > 0 && <span className="muted small">~{c.tokens.toLocaleString()} tokens written</span>}
        </div>
        <button className="ghost" onClick={c.cancel}>Cancel</button>
      </div>
      {c.thinking && (
        <div className="small">
          <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} the coach&apos;s reasoning</button>
          {open && <pre className="coach-thinking">{c.thinking}</pre>}
        </div>
      )}
      <div className="muted small">Plans can take a few minutes. You can keep this open while the coach works.</div>
    </div>
  );
}

/** Full details of a suggested workout: stats, chart and interval list. */
function SuggestionDetail({ w, ftp, reason, onClose, children }: { w: Workout; ftp: number; reason?: string; onClose: () => void; children?: React.ReactNode }) {
  const ivs = flatten(w);
  const s = plannedStats(ivs, ftp);
  const r = rateWorkout(w, ftp);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop coach-detail-bg" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={w.name} onClick={(e) => e.stopPropagation()}>
        <div className="row space">
          <h3>{w.name}</h3>
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="muted small">
          {formatDuration(s.duration)} · TSS {Math.round(s.tss)} · IF {s.if.toFixed(2)} · {r.zone === 'recovery' || r.zone === 'test' ? r.zone : `${r.zone} L${r.level.toFixed(1)}`} · FTP {ftp} W
        </div>
        <WorkoutChart intervals={ivs} ftp={ftp} height={120} />
        {reason && <div className="small">{reason}</div>}
        {w.description && <div className="muted small">{w.description}</div>}
        <div className="table-scroll">
          <table className="interval-table">
            <thead>
              <tr><th>#</th><th>Start</th><th>Duration</th><th>Target</th><th></th></tr>
            </thead>
            <tbody>
              {ivs.map((iv, i) => (
                <tr key={i}>
                  <td>
                    <span className="zone-dot" style={{ background: iv.free ? '#5b6573' : zoneFor(intervalFtpFraction(iv, ftp)).color }} />
                    {i + 1}
                  </td>
                  <td>{formatDuration(iv.start)}</td>
                  <td>{formatDuration(iv.duration)}</td>
                  <td>{intervalPowerText(iv, ftp)}</td>
                  <td className="muted">{iv.label ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {children && <div className="row wrap">{children}</div>}
      </div>
    </div>
  );
}

function WorkoutLine({ w, ftp, extra, reason, actions }: {
  w: Workout;
  ftp: number;
  extra?: React.ReactNode;
  /** with `actions`, the card opens a details view when clicked */
  reason?: string;
  actions?: React.ReactNode;
}) {
  const ivs = flatten(w);
  const s = plannedStats(ivs, ftp);
  const [open, setOpen] = useState(false);
  const clickable = actions !== undefined;
  return (
    <div
      className={`coach-workout${clickable ? ' clickable' : ''}`}
      title={clickable ? 'Click for full workout details' : undefined}
      onClick={clickable ? (e) => { if (!(e.target as HTMLElement).closest('button, a, input, select, textarea')) setOpen(true); } : undefined}
    >
      <div className="row space">
        <b>{w.name}</b>
        <span className="muted small">
          {formatDuration(s.duration)} · TSS {Math.round(s.tss)} · IF {s.if.toFixed(2)}
        </span>
      </div>
      <WorkoutChart intervals={ivs} ftp={ftp} height={34} />
      {extra}
      {clickable && (
        <div className="row wrap">
          {actions}
          <button className="link small" onClick={() => setOpen(true)}>Details</button>
        </div>
      )}
      {open && <SuggestionDetail w={w} ftp={ftp} reason={reason} onClose={() => setOpen(false)}>{actions}</SuggestionDetail>}
    </div>
  );
}

const fmtDay = (k: string) => dayStart(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// ---------- plan builder ----------

const EVENT_TYPES = ['Gran fondo / century', 'Road race', 'Criterium', 'Gravel race', 'Time trial', 'Climbing event', 'Stage race / tour', 'General fitness', 'Raise my FTP'];
const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export function PlanBuilder({ state, onApply, onClose }: {
  state: CoachState;
  onApply: (r: PlanResult, replace?: TrainingPlan) => Promise<void>;
  onClose: () => void;
}) {
  const c = useCoach();
  const active = state.plans.find((p) => p.active);
  const prev = active?.input;
  const nextMonday = weekStart(addDays(state.today, 7));
  const [goal, setGoal] = useState(prev?.goal ?? '');
  const [eventType, setEventType] = useState(prev?.eventType ?? EVENT_TYPES[0]);
  const [eventDate, setEventDate] = useState(prev?.eventDate ?? '');
  const [startDate, setStartDate] = useState(state.today < nextMonday ? addDays(nextMonday, -7) < state.today ? state.today : addDays(nextMonday, -7) : nextMonday);
  const [weeks, setWeeks] = useState(12);
  const [hours, setHours] = useState(prev?.weeklyHours ?? 6);
  const [days, setDays] = useState<Record<Weekday, number>>(prev?.days ?? { mon: 0, tue: 60, wed: 60, thu: 60, fri: 0, sat: 120, sun: 90 });
  const [experience, setExperience] = useState<PlanInput['experience']>(prev?.experience ?? 'some');
  const [notes, setNotes] = useState(prev?.notes ?? '');
  const [result, setResult] = useState<{ out: PlanOutput; res: PlanResult } | null>(null);
  const [applying, setApplying] = useState(false);

  const endDate = eventDate && eventDate > startDate ? eventDate : addDays(startDate, weeks * 7 - 1);
  const totalWeeks = Math.ceil((dayStart(endDate).getTime() - dayStart(startDate).getTime()) / (7 * 86_400_000));

  async function generate() {
    const input: PlanInput = {
      goal: goal.trim() || eventType,
      eventType,
      eventDate: eventDate || undefined,
      startDate,
      endDate,
      weeklyHours: hours,
      days,
      experience,
      notes: notes.trim() || undefined,
      detailUntil: addDays(startDate, 20) < endDate ? addDays(startDate, 20) : endDate,
    };
    const out = await c.run((onEvent, signal) => askCoach<PlanOutput>({ kind: 'plan', context: buildContext(state), input }, onEvent, signal));
    if (out) setResult({ out, res: planFromOutput(out, input, state.library, state.calendar) });
  }

  return (
    <Modal title="Build a training plan" onClose={onClose}>
      {!result ? (
        <>
          <p className="muted small">
            The coach builds a plan around your goal, schedule, fitness and progression levels. It writes the first three weeks in detail, then fills
            in later weeks as you train, adjusting to how your rides go.
          </p>
          <div className="fields two">
            <label className="field">
              <span>Goal</span>
              <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Finish the Mt. Diablo fondo strong" />
            </label>
            <label className="field">
              <span>Type</span>
              <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
                {EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Event date (optional)</span>
              <input type="date" value={eventDate} min={addDays(startDate, 14)} onChange={(e) => setEventDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Start</span>
              <input type="date" value={startDate} min={state.today} onChange={(e) => e.target.value && setStartDate(e.target.value)} />
            </label>
            {!eventDate && (
              <label className="field">
                <span>Length</span>
                <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
                  {[4, 6, 8, 10, 12, 16, 20, 24].map((n) => <option key={n} value={n}>{n} weeks</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span>Hours per week: {hours}</span>
              <input type="range" min={2} max={20} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
            </label>
            <label className="field">
              <span>Experience</span>
              <select value={experience} onChange={(e) => setExperience(e.target.value as PlanInput['experience'])}>
                <option value="new">New to structured training</option>
                <option value="some">Some structured training</option>
                <option value="experienced">Experienced</option>
              </select>
            </label>
          </div>
          <div className="field">
            <span>Minutes available each day (0 = rest)</span>
            <div className="day-mins">
              {WEEKDAYS.map((d) => (
                <label key={d}>
                  <span>{DAY_LABEL[d]}</span>
                  <input type="number" min={0} max={480} step={15} value={days[d]} onChange={(e) => setDays({ ...days, [d]: Math.max(0, Number(e.target.value)) })} />
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Anything else the coach should know</span>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. outdoor group ride most Saturdays, knee niggle, prefer shorter intervals" />
          </label>
          <div className="muted small">
            {totalWeeks} weeks, {fmtDay(startDate)} – {fmtDay(endDate)}.
            {active ? ` This replaces your current plan, “${active.name}” (its future workouts are removed; done ones stay).` : ''}
          </div>
          <CoachProgress c={c} />
          <div className="row">
            <button className="primary" disabled={c.running} onClick={generate}>
              {c.running ? 'Building…' : 'Build my plan'}
            </button>
            <button className="ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <h3 style={{ margin: 0 }}>{result.res.plan.name}</h3>
          <p>{result.out.summary}</p>
          <div className="phase-strip">
            {result.out.phases.map((p) => (
              <div key={p.start} className="phase-chip">
                <b>{p.name}</b>
                <span className="muted small">
                  {fmtDay(p.start)} – {fmtDay(p.end)}
                </span>
                <span className="small">{p.focus}</span>
              </div>
            ))}
          </div>
          <div className="table-scroll">
            <table className="laps">
              <thead>
                <tr><th>Week of</th><th>Focus</th><th>TSS</th><th>Hours</th><th>Workouts</th></tr>
              </thead>
              <tbody>
                {result.out.weeks.map((w) => {
                  const n = result.res.items.filter((i) => i.date >= w.start && i.date < addDays(w.start, 7)).length;
                  return (
                    <tr key={w.start}>
                      <td>{fmtDay(w.start)}</td>
                      <td>{w.focus}{w.notes ? <div className="muted small">{w.notes}</div> : null}</td>
                      <td>{w.target_tss}</td>
                      <td>{w.target_hours}</td>
                      <td>{n || <span className="muted">later</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details>
            <summary>{result.res.items.length} workouts in the first weeks</summary>
            {result.res.items.map((i) => (
              <WorkoutLine key={i.id} w={i.workout} ftp={state.settings.ftp} extra={<div className="muted small">{fmtDay(i.date)} · {i.rationale}</div>} />
            ))}
          </details>
          {result.res.problems.length > 0 && (
            <div className="banner">
              {result.res.problems.map((p, i) => <div key={i} className="small">{p}</div>)}
            </div>
          )}
          <div className="row">
            <button
              className="primary"
              disabled={applying || !result.res.items.length}
              onClick={async () => {
                setApplying(true);
                await onApply(result.res, active);
                setApplying(false);
                onClose();
              }}
            >
              Add plan to calendar
            </button>
            <button onClick={() => setResult(null)}>Change inputs</button>
            <button className="ghost" onClick={onClose}>Discard</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------- adaptations ----------

const OP_LABEL = { replace: 'Swap', move: 'Move', remove: 'Remove', add: 'Add' } as const;

export function AdaptReview({ state, input, onApply, onClose }: {
  state: CoachState;
  input: AdaptInput;
  onApply: (save: PlannedWorkout[], remove: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const c = useCoach();
  const [summary, setSummary] = useState('');
  const [changes, setChanges] = useState<ReviewedChange[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState(input.note ?? '');
  const started = useRef(false);
  const plan = state.plans.find((p) => p.active);

  async function ask() {
    const req: AdaptInput = { ...input, note: note.trim() || undefined, days: input.days ?? plan?.input?.days };
    const out = await c.run((onEvent, signal) => askCoach<AdaptOutput>({ kind: 'adapt', context: buildContext(state), input: req }, onEvent, signal));
    if (!out) return;
    const reviewed = reviewAdaptation(out, state.calendar, state.library, input.from, input.to, plan?.id);
    setSummary(out.summary);
    setChanges(reviewed);
    setPicked(new Set(reviewed.map((r, i) => (r.problem ? -1 : i)).filter((i) => i >= 0)));
  }
  // asked from a banner or after a ride: start right away
  useEffect(() => {
    if (started.current || input.reason === 'manual') return;
    started.current = true;
    void ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = input.reason === 'extend' ? 'Plan the next two weeks' : 'Adjust upcoming workouts';
  return (
    <Modal title={title} onClose={onClose}>
      <div className="muted small">
        {fmtDay(input.from)} – {fmtDay(input.to)}. The coach looks at your recent rides, how they felt, fatigue and levels. Nothing changes until you
        accept.
      </div>
      {!changes && !c.running && (
        <>
          <label className="field">
            <span>Anything to tell the coach? (optional)</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. traveling Thu–Sat, legs feel heavy, want more climbing" />
          </label>
          <div className="row">
            <button className="primary" onClick={ask}>Ask the coach</button>
            <button className="ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
      <CoachProgress c={c} />
      {changes && (
        <>
          <p>{summary}</p>
          {!changes.length && <p className="muted">No changes needed.</p>}
          <div className="adapt-list">
            {changes.map((r, i) => (
              <label key={i} className={`adapt-item${r.problem ? ' bad' : ''}`}>
                <input
                  type="checkbox"
                  disabled={!!r.problem}
                  checked={picked.has(i)}
                  onChange={(e) => {
                    const s = new Set(picked);
                    if (e.target.checked) s.add(i);
                    else s.delete(i);
                    setPicked(s);
                  }}
                />
                <div className="grow">
                  <div>
                    <span className="tag">{OP_LABEL[r.change.op]}</span>{' '}
                    {r.change.op === 'move' && r.before && r.after && (
                      <>
                        <b>{r.before.workout.name}</b> {fmtDay(r.before.date)} → {fmtDay(r.after.date)}
                      </>
                    )}
                    {r.change.op === 'remove' && r.before && (
                      <>
                        <b>{r.before.workout.name}</b> on {fmtDay(r.before.date)}
                      </>
                    )}
                    {r.change.op === 'replace' && r.before && (
                      <>
                        <s>{r.before.workout.name}</s> → <b>{r.after?.workout.name ?? '?'}</b> on {fmtDay(r.after?.date ?? r.before.date)}
                      </>
                    )}
                    {r.change.op === 'add' && r.after && (
                      <>
                        <b>{r.after.workout.name}</b> on {fmtDay(r.after.date)}
                      </>
                    )}
                  </div>
                  <div className="muted small">{r.change.reason}</div>
                  {r.problem && <div className="small strava-error">Can&apos;t apply: {r.problem}</div>}
                  {r.after && r.change.op !== 'move' && <WorkoutChart intervals={flatten(r.after.workout)} ftp={state.settings.ftp} height={30} />}
                </div>
              </label>
            ))}
          </div>
          <div className="row">
            {changes.length > 0 && (
              <button
                className="primary"
                disabled={!picked.size}
                onClick={async () => {
                  const chosen = changes.filter((_, i) => picked.has(i));
                  await onApply(
                    chosen.filter((r) => r.after).map((r) => r.after!),
                    chosen.filter((r) => r.change.op === 'remove' && r.before).map((r) => r.before!.id),
                  );
                  onClose();
                }}
              >
                Accept {picked.size === changes.length ? 'all' : `${picked.size}`}
              </button>
            )}
            <button className="ghost" onClick={async () => { await onApply([], []); onClose(); }}>
              {changes.length ? 'Dismiss' : 'Close'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------- today ----------

const FEELS = ['Wrecked', 'Tired', 'OK', 'Good', 'Great'];

export function TodayCard({ state, onRide, onAdd, canRide = true }: {
  state: CoachState;
  /** false on the phone layout, which only schedules */
  canRide?: boolean;
  onRide: (w: Workout, reason: string) => void;
  onAdd: (w: Workout, reason: string) => void;
}) {
  const c = useCoach();
  const [minutes, setMinutes] = useState(60);
  const [feel, setFeel] = useState(3);
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState<{ summary: string; options: TodayOption[] } | null>(null);
  const [open, setOpen] = useState(false);

  async function ask() {
    const out = await c.run((onEvent, signal) => askCoach<TodayOutput>({ kind: 'today', context: buildContext(state), input: { minutes, feel, note: note.trim() || undefined } }, onEvent, signal));
    if (out) setAnswer({ summary: out.summary, options: todayOptions(out, state.library).options });
  }

  if (!open) {
    return (
      <div className="card coach-today">
        <div className="row space">
          <div>
            <div className="card-title">Not sure what to ride?</div>
            <div className="muted small">Tell the coach how much time you have and how you feel.</div>
          </div>
          <button onClick={() => setOpen(true)}>Ask the coach</button>
        </div>
      </div>
    );
  }
  return (
    <div className="card coach-today">
      <div className="card-title">What should I ride today?</div>
      <div className="row">
        <label className="field">
          <span>Time</span>
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[30, 45, 60, 75, 90, 120, 150, 180].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
        <div className="field">
          <span>How do you feel?</span>
          <div className="seg">
            {FEELS.map((f, i) => (
              <button key={f} className={feel === i + 1 ? 'active' : ''} onClick={() => setFeel(i + 1)}>{f}</button>
            ))}
          </div>
        </div>
      </div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else? (optional: e.g. racing Sunday, want something fun)" />
      <CoachProgress c={c} />
      <div className="row">
        <button className="primary" disabled={c.running} onClick={ask}>{answer ? 'Ask again' : 'Recommend'}</button>
        <button className="ghost" onClick={() => setOpen(false)}>Close</button>
      </div>
      {answer && (
        <>
          <p>{answer.summary}</p>
          {answer.options.map((o, i) => (
            <WorkoutLine
              key={i}
              w={o.workout}
              ftp={state.settings.ftp}
              reason={o.reason}
              extra={<div className="muted small">{o.reason}</div>}
              actions={
                <>
                  {canRide && <button className="primary" onClick={() => onRide(o.workout, o.reason)}>Ride this</button>}
                  <button className={canRide ? '' : 'primary'} onClick={() => onAdd(o.workout, o.reason)}>Add to today</button>
                </>
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

// ---------- a planned calendar workout ----------

const TIMES = [30, 45, 60, 75, 90, 120, 150, 180];

/**
 * Coach help for one calendar workout: three alternatives for that day, or a
 * recommendation after telling the coach how you feel. Nothing is asked until
 * the rider clicks. "Use this" swaps the workout in place on the calendar.
 */
export function PlannedCoach({ state, planned, onSwap, btn = '' }: {
  state: CoachState;
  planned: PlannedWorkout;
  onSwap: (w: Workout, reason: string) => void;
  /** extra class for buttons (the phone layout uses m-btn) */
  btn?: string;
}) {
  const c = useCoach();
  const ftp = state.settings.ftp;
  const st = plannedStats(flatten(planned.workout), ftp);
  const plannedMin = Math.round(st.duration / 60);
  const nearest = TIMES.reduce((a, b) => (Math.abs(b - plannedMin) < Math.abs(a - plannedMin) ? b : a));
  const [mode, setMode] = useState<'closed' | 'options' | 'feel'>('closed');
  const [minutes, setMinutes] = useState(nearest);
  const [feel, setFeel] = useState(3);
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState<{ summary: string; options: TodayOption[]; problems: string[] } | null>(null);

  async function ask(input: TodayInput) {
    setAnswer(null);
    const r = rateWorkout(planned.workout, ftp);
    const full: TodayInput = {
      ...input,
      date: planned.date,
      planned: { name: planned.workout.name, zone: r.zone, level: r.level, minutes: plannedMin, tss: Math.round(st.tss), rationale: planned.rationale || undefined },
    };
    const out = await c.run((onEvent, signal) => askCoach<TodayOutput>({ kind: 'today', context: buildContext(state), input: full }, onEvent, signal));
    if (out) setAnswer({ summary: out.summary, ...todayOptions(out, state.library) });
  }

  const showOptions = () => {
    setMode('options');
    const seen = mode === 'options' && answer ? answer.options.map((o) => o.workout.name) : [];
    void ask({ minutes: plannedMin, alternatives: true, note: seen.length ? `Already suggested, offer different ones: ${seen.join(', ')}` : undefined });
  };

  return (
    <div className="planned-coach">
      <div className="row wrap">
        <button className={`${btn} ${mode === 'options' ? 'active' : ''}`} disabled={c.running} onClick={showOptions}>
          {mode === 'options' && answer ? 'Show 3 more options' : 'Show 3 other options'}
        </button>
        <button className={`${btn} ${mode === 'feel' ? 'active' : ''}`} disabled={c.running} onClick={() => { setMode(mode === 'feel' ? 'closed' : 'feel'); setAnswer(null); }}>
          Tell the coach how you feel
        </button>
      </div>
      {mode === 'feel' && (
        <div className="planned-coach-form">
          <div className="row wrap">
            <label className="field">
              <span>Time</span>
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {TIMES.map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </label>
            <div className="field">
              <span>How do you feel?</span>
              <div className="seg">
                {FEELS.map((f, i) => (
                  <button key={f} className={feel === i + 1 ? 'active' : ''} onClick={() => setFeel(i + 1)}>{f}</button>
                ))}
              </div>
            </div>
          </div>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell the coach more, e.g. legs heavy from yesterday, slept badly, want something short and hard" />
          <div className="row">
            <button className={`primary ${btn}`} disabled={c.running} onClick={() => ask({ minutes, feel, note: note.trim() || undefined })}>
              {answer ? 'Ask again' : 'Ask the coach'}
            </button>
          </div>
        </div>
      )}
      <CoachProgress c={c} />
      {answer && mode !== 'closed' && (
        <>
          <p className="small">{answer.summary}</p>
          {answer.options.map((o, i) => (
            <WorkoutLine
              key={i}
              w={o.workout}
              ftp={ftp}
              reason={o.reason}
              extra={<div className="muted small">{o.reason}</div>}
              actions={<button className={`primary ${btn}`} onClick={() => onSwap(o.workout, o.reason)}>Use this instead</button>}
            />
          ))}
          {answer.problems.length > 0 && <div className="muted small">Skipped {answer.problems.length} option{answer.problems.length === 1 ? '' : 's'} that didn&apos;t check out: {answer.problems.join(' ')}</div>}
        </>
      )}
    </div>
  );
}
