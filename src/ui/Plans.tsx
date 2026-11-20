import { useState } from 'react';
import { WEEKDAYS, type Weekday } from '../training/coachSchema';
import { dayStart } from '../training/load';
import type { PlanPhase, PlannedWorkout, TrainingPlan } from '../training/model';
import { normalizePlan, outsideDates, setActive, upcomingOf } from '../training/plans';
import { Modal } from './Calendar';

const fmtDay = (k: string) => dayStart(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function PlanManager({ plans, calendar, initial, onSave, onDelete, onClose }: {
  plans: TrainingPlan[];
  calendar: PlannedWorkout[];
  /** open straight into this plan's editor */
  initial?: string;
  /** save changed plans and remove these calendar items */
  onSave: (plans: TrainingPlan[], removeIds: string[]) => Promise<void>;
  onDelete: (plan: TrainingPlan, removeIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(initial ?? null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [keepWorkouts, setKeepWorkouts] = useState(false);
  const [busy, setBusy] = useState(false);

  const plan = plans.find((p) => p.id === editing);
  if (plan) {
    return (
      <PlanEditor
        plan={plan}
        calendar={calendar}
        onCancel={() => (initial ? onClose() : setEditing(null))}
        onSave={async (p, remove) => {
          await onSave([p], remove);
          if (initial) onClose();
          else setEditing(null);
        }}
      />
    );
  }

  const sorted = [...plans].sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Training plans" onClose={onClose}>
      {!sorted.length && <p className="muted">No plans yet.</p>}
      <div className="plan-list">
        {sorted.map((p) => {
          const upcoming = upcomingOf(p, calendar);
          return (
            <div key={p.id} className={`plan-item${p.active ? ' active' : ''}`}>
              <div className="row space">
                <div>
                  <b>{p.name}</b> {p.active && <span className="tag">Active</span>}
                  <div className="muted small">
                    {fmtDay(p.start)} – {fmtDay(p.end)} · {plural(upcoming.length, 'upcoming workout')}
                  </div>
                  {p.goal && <div className="small">{p.goal}</div>}
                </div>
              </div>
              {confirmDelete === p.id ? (
                <div className="plan-confirm">
                  <div>Delete “{p.name}”?</div>
                  {upcoming.length > 0 && (
                    <label className="row small">
                      <input type="checkbox" checked={keepWorkouts} onChange={(e) => setKeepWorkouts(e.target.checked)} />
                      Keep its {plural(upcoming.length, 'upcoming workout')} on the calendar
                    </label>
                  )}
                  <div className="muted small">Workouts you&apos;ve already ridden stay in your history.</div>
                  <div className="row">
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => run(async () => {
                        await onDelete(p, keepWorkouts ? [] : upcoming.map((c) => c.id));
                        setConfirmDelete(null);
                      })}
                    >
                      Delete plan
                    </button>
                    <button className="ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <button onClick={() => setEditing(p.id)}>Edit</button>
                  {p.active ? (
                    <button className="ghost" disabled={busy} onClick={() => run(() => onSave(setActive(plans, null), []))}>Deactivate</button>
                  ) : (
                    <button className="ghost" disabled={busy} onClick={() => run(() => onSave(setActive(plans, p.id), []))}>Make active</button>
                  )}
                  <button
                    className="ghost danger-text"
                    onClick={() => {
                      setKeepWorkouts(false);
                      setConfirmDelete(p.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function PlanEditor({ plan, calendar, onSave, onCancel }: {
  plan: TrainingPlan;
  calendar: PlannedWorkout[];
  onSave: (p: TrainingPlan, removeIds: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const [goal, setGoal] = useState(plan.goal);
  const [eventDate, setEventDate] = useState(plan.eventDate ?? '');
  const [start, setStart] = useState(plan.start);
  const [end, setEnd] = useState(plan.end);
  const [notes, setNotes] = useState(plan.notes ?? '');
  const [phases, setPhases] = useState<PlanPhase[]>(plan.phases);
  const [hours, setHours] = useState(plan.input?.weeklyHours);
  const [days, setDays] = useState(plan.input?.days);
  const [coachNotes, setCoachNotes] = useState(plan.input?.notes ?? '');
  const [removeOutside, setRemoveOutside] = useState(true);
  const [saving, setSaving] = useState(false);

  const draft = normalizePlan({
    ...plan,
    name: name.trim() || plan.name,
    goal: goal.trim(),
    eventDate: eventDate || undefined,
    start,
    end,
    notes: notes.trim() || undefined,
    phases,
    input: plan.input && { ...plan.input, weeklyHours: hours ?? plan.input.weeklyHours, days: days ?? plan.input.days, notes: coachNotes.trim() || undefined },
  });
  const outside = outsideDates(draft, calendar);
  const invalid = !start || !end || end < start;
  const setPhase = (i: number, patch: Partial<PlanPhase>) => setPhases(phases.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Modal title="Edit plan" onClose={onCancel}>
      <div className="fields two">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Goal</span>
          <input value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <label className="field">
          <span>Start</span>
          <input type="date" value={start} max={end} onChange={(e) => e.target.value && setStart(e.target.value)} />
        </label>
        <label className="field">
          <span>End</span>
          <input type="date" value={end} min={start} onChange={(e) => e.target.value && setEnd(e.target.value)} />
        </label>
        <label className="field">
          <span>Event date (optional)</span>
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </label>
        {hours !== undefined && (
          <label className="field">
            <span>Hours per week: {hours}</span>
            <input type="range" min={2} max={20} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </label>
        )}
      </div>
      {days && (
        <div className="field">
          <span>Minutes available each day (0 = rest). The coach uses these when it plans the next weeks.</span>
          <div className="day-mins">
            {WEEKDAYS.map((d) => (
              <label key={d}>
                <span>{DAY_LABEL[d]}</span>
                <input type="number" min={0} max={480} step={15} value={days[d]} onChange={(e) => setDays({ ...days, [d]: Math.max(0, Number(e.target.value)) })} />
              </label>
            ))}
          </div>
        </div>
      )}
      {plan.input && (
        <label className="field">
          <span>Notes for the coach</span>
          <textarea rows={2} value={coachNotes} onChange={(e) => setCoachNotes(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Plan notes</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div className="field">
        <span>Phases</span>
        {phases.map((p, i) => (
          <div key={i} className="phase-edit">
            <input value={p.name} onChange={(e) => setPhase(i, { name: e.target.value })} aria-label="Phase name" />
            <input type="date" value={p.start} onChange={(e) => e.target.value && setPhase(i, { start: e.target.value })} aria-label="Phase start" />
            <input type="date" value={p.end} onChange={(e) => e.target.value && setPhase(i, { end: e.target.value })} aria-label="Phase end" />
            <input className="grow" value={p.focus} onChange={(e) => setPhase(i, { focus: e.target.value })} aria-label="Phase focus" placeholder="Focus" />
            <button className="ghost icon" onClick={() => setPhases(phases.filter((_, j) => j !== i))} aria-label="Remove phase">✕</button>
          </div>
        ))}
        <div>
          <button
            className="ghost"
            onClick={() => {
              const last = phases[phases.length - 1];
              setPhases([...phases, { name: 'New phase', start: last && last.end < end ? last.end : start, end, focus: '' }]);
            }}
          >
            + Add phase
          </button>
        </div>
      </div>

      {outside.length > 0 && (
        <label className="banner row small">
          <input type="checkbox" checked={removeOutside} onChange={(e) => setRemoveOutside(e.target.checked)} />
          Remove {plural(outside.length, 'planned workout')} that now fall outside the plan&apos;s dates
        </label>
      )}
      {invalid && <div className="banner err small">The end date must be on or after the start.</div>}
      <div className="row">
        <button
          className="primary"
          disabled={invalid || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(draft, removeOutside ? outside.map((c) => c.id) : []);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save changes
        </button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}
