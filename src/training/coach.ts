// Talks to the Claude coach (worker/coach.ts): builds the training context it
// sees, streams its progress, and turns its answers into calendar changes,
// validating every workout before anything is saved.

import type { RideRecord } from '../app/recorder';
import { uid, type Settings } from '../storage/types';
import { parseText } from '../workout/parsers';
import { flatten, plannedStats, type Workout } from '../workout/model';
import { newPlanned } from './calendar';
import type { AdaptChange, AdaptOutput, CoachContext, CoachEvent, CoachRequest, PlanInput, PlanOutput, TodayOutput, WorkoutChoice } from './coachSchema';
import { ftpOn } from './ftp';
import { addDays, dayKey, estimateFtp, fitnessSeries, loadEntries, plannedLoad, weeklyTotals } from './load';
import { activityOutcome, computeLevels, rateWorkout, rideOutcome, stravaWorkout, type Levels } from './levels';
import type { DayKey, PlannedWorkout, StravaActivity, TrainingPlan } from './model';

export interface CoachState {
  settings: Settings;
  rides: RideRecord[];
  acts: StravaActivity[];
  calendar: PlannedWorkout[];
  plans: TrainingPlan[];
  library: Workout[];
  levels?: Levels;
  today: DayKey;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The compact picture of the rider's training that goes with every coach request. */
export function buildContext(s: CoachState, upcomingDays = 21): CoachContext {
  const { settings, today } = s;
  const levels = s.levels ?? computeLevels(s.rides, s.acts, s.calendar, s.library, settings.ftp, Date.now(), (t) => ftpOn(settings, dayKey(t))).levels;
  const entries = loadEntries(s.rides, s.acts, settings.ftp, settings.maxHr);
  const series = fitnessSeries(entries, plannedLoad(s.calendar, settings.ftp), addDays(today, -400), today, today);
  const now = series[series.length - 1];
  const weekAgo = series[series.length - 8] ?? series[0];
  const byRide = new Map(s.calendar.filter((p) => p.rideId).map((p) => [p.rideId!, p.workout]));
  const byName = new Map(s.library.map((w) => [w.name, w]));
  const ridesById = new Map(s.rides.map((r) => [r.id, r]));
  const actsById = new Map(s.acts.map((a) => [a.id, a]));
  const recent = entries
    .filter((e) => e.date >= addDays(today, -14))
    .map((e) => {
      const base = { date: e.date, name: e.name, source: e.kind, minutes: Math.round(e.seconds / 60), tss: Math.round(e.tss) };
      const act = e.kind === 'strava' ? actsById.get(e.id) : undefined;
      const aw = act ? stravaWorkout(act, s.calendar, s.library) : undefined;
      const actFtp = act ? ftpOn(settings, e.date) : settings.ftp;
      const ao = act && aw ? activityOutcome(act, aw, actFtp) : undefined;
      if (aw && ao) {
        const rating = rateWorkout(aw, actFtp);
        return { ...base, zone: rating.zone, level: rating.level, outcome: ao.outcome, compliance: r1(ao.compliance) };
      }
      const ride = e.kind === 'ridebox' ? ridesById.get(e.id) : undefined;
      const w = ride ? (byRide.get(ride.id) ?? (ride.workoutName ? byName.get(ride.workoutName) : undefined)) : undefined;
      if (!ride || !w) return { ...base, feel: ride?.feel };
      const rating = rateWorkout(w, ride.ftp || settings.ftp);
      const o = rideOutcome(ride, plannedStats(flatten(w), ride.ftp || settings.ftp).duration);
      return { ...base, zone: rating.zone, level: rating.level, outcome: o.outcome, compliance: r1(o.compliance), feel: ride.feel };
    });
  const upcoming = s.calendar
    .filter((p) => p.date >= addDays(today, -7) && p.date <= addDays(today, upcomingDays))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((p) => {
      const st = plannedStats(flatten(p.workout), settings.ftp);
      const r = rateWorkout(p.workout, settings.ftp);
      return { id: p.id, date: p.date, name: p.workout.name, zone: r.zone, level: r.level, minutes: Math.round(st.duration / 60), tss: Math.round(st.tss), status: p.status, origin: p.origin };
    });
  const plan = s.plans.find((p) => p.active);
  return {
    today,
    athlete: { ftp: settings.ftp, weightKg: settings.riderKg, maxHr: settings.maxHr, ftpEstimate: estimateFtp(s.rides)?.ftp, levels },
    fitness: { ctl: r1(now?.ctl ?? 0), atl: r1(now?.atl ?? 0), tsb: r1(now?.tsb ?? 0), ctlChange7d: r1((now?.ctl ?? 0) - (weekAgo?.ctl ?? 0)) },
    weeklyHistory: weeklyTotals(entries, addDays(today, -56), today).map((w) => ({
      week: w.week,
      tss: Math.round(w.tss),
      hours: r1(w.seconds / 3600),
      activities: entries.filter((e) => e.date >= w.week && e.date < addDays(w.week, 7)).length,
    })),
    recent,
    upcoming,
    plan: plan && { name: plan.name, goal: plan.goal, eventDate: plan.eventDate, start: plan.start, end: plan.end, phases: plan.phases, notes: plan.notes },
    library: s.library.slice(0, 80).map((w) => {
      const st = plannedStats(flatten(w), settings.ftp);
      const r = rateWorkout(w, settings.ftp);
      return { name: w.name, zone: r.zone, level: r.level, minutes: Math.round(st.duration / 60), tss: Math.round(st.tss) };
    }),
  };
}

/** Reads `data: {...}` lines from a server-sent-events body. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<CoachEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) yield JSON.parse(line.slice(6)) as CoachEvent;
    }
    if (done) return;
  }
}

/** Calls the coach and resolves with its JSON answer. `onEvent` sees progress along the way. */
export async function askCoach<T>(req: CoachRequest, onEvent: (e: CoachEvent) => void, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`api/coach/${req.kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('Couldn’t reach the coach. Check your connection.');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('The coach is only available on your private RideBox site (Cloudflare).');
    throw new Error((j as { error?: string }).error ?? `Coach error ${res.status}`);
  }
  if (!res.body) throw new Error('No response from the coach.');
  for await (const e of readEvents(res.body)) {
    onEvent(e);
    if (e.type === 'result') return e.data as T;
    if (e.type === 'error') throw new Error(e.message);
  }
  throw new Error('The coach stopped before answering. Please try again.');
}

/** A library workout by name, or Claude's own workout checked by the RideBox shorthand parser. */
export function resolveChoice(c: WorkoutChoice, library: Workout[]): Workout {
  const lib = c.library_name?.trim();
  const text = c.workout?.text?.trim();
  if (lib) {
    const w = library.find((x) => x.name === lib) ?? library.find((x) => x.name.toLowerCase() === lib.toLowerCase());
    if (w) return w;
    if (!text) throw new Error(`No library workout named “${lib}”.`);
  }
  if (!text) throw new Error('No workout given.');
  const parsed = parseText(text, c.workout.name?.trim() || 'Coach workout');
  const w: Workout = { ...parsed, name: c.workout.name?.trim() || parsed.name, description: c.workout.description?.trim() || undefined };
  const ivs = flatten(w);
  const total = ivs.reduce((a, iv) => a + iv.duration, 0);
  if (!ivs.length || total < 10 * 60) throw new Error(`“${w.name}” is too short.`);
  if (total > 8 * 3600) throw new Error(`“${w.name}” is too long.`);
  for (const iv of ivs) {
    const hi = Math.max(iv.powerStart, iv.powerEnd);
    if (!iv.free && iv.unit === 'ftp' && (hi > 3 || Math.min(iv.powerStart, iv.powerEnd) < 0.2)) throw new Error(`“${w.name}” has an unrealistic target (${Math.round(hi * 100)}% FTP).`);
  }
  return { ...w, author: 'RideBox Coach' };
}

const validDate = (d: unknown): d is DayKey => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

export interface PlanResult {
  plan: TrainingPlan;
  items: PlannedWorkout[];
  /** workouts that failed validation (skipped) */
  problems: string[];
}

export function planFromOutput(out: PlanOutput, input: PlanInput, library: Workout[], calendar: PlannedWorkout[]): PlanResult {
  const planId = uid();
  const phases = out.phases.filter((p) => validDate(p.start) && validDate(p.end));
  const plan: TrainingPlan = {
    id: planId,
    name: out.name || input.goal,
    goal: input.goal,
    eventDate: input.eventDate,
    start: input.startDate,
    end: input.endDate,
    phases,
    notes: [out.summary, ...out.weeks.map((w) => `${w.start}: ${w.focus} (${w.target_tss} TSS, ${w.target_hours} h)${w.notes ? ` · ${w.notes}` : ''}`)].join('\n'),
    createdAt: Date.now(),
    active: true,
    input,
  };
  const items: PlannedWorkout[] = [];
  const problems: string[] = [];
  const all = [...calendar];
  for (const w of out.workouts) {
    if (!validDate(w.date) || w.date < input.startDate || w.date > input.endDate) {
      problems.push(`Skipped a workout on ${w.date}: outside the plan dates.`);
      continue;
    }
    try {
      const workout = resolveChoice(w, library);
      const phase = phases.find((p) => p.start <= w.date && w.date <= p.end)?.name;
      const item = newPlanned(workout, w.date, all, { origin: 'plan', planId, phase, rationale: w.rationale });
      all.push(item);
      items.push(item);
    } catch (e) {
      problems.push(`Skipped a workout on ${w.date}: ${(e as Error).message}`);
    }
  }
  return { plan, items, problems };
}

export interface ReviewedChange {
  change: AdaptChange;
  /** the calendar item before the change (replace / move / remove) */
  before?: PlannedWorkout;
  /** the calendar item after (replace / move / add) */
  after?: PlannedWorkout;
  problem?: string;
}

/** Checks each proposed change against the calendar so the rider can review it. Nothing is saved here. */
export function reviewAdaptation(out: AdaptOutput, calendar: PlannedWorkout[], library: Workout[], from: DayKey, to: DayKey, planId?: string): ReviewedChange[] {
  const all = [...calendar];
  return out.changes.map((change): ReviewedChange => {
    const before = change.id ? calendar.find((p) => p.id === change.id) : undefined;
    const newDate = change.date?.trim() || undefined;
    try {
      if (change.op !== 'add') {
        if (!before) throw new Error('That workout isn’t on the calendar any more.');
        if (before.status === 'done') throw new Error('That workout is already done.');
      }
      const date = newDate ?? before?.date;
      if (change.op !== 'remove') {
        if (!validDate(date)) throw new Error('No date given.');
        if (date < from || date > to) throw new Error(`${date} is outside ${from} – ${to}.`);
      }
      switch (change.op) {
        case 'remove':
          return { change, before };
        case 'move':
          return { change, before, after: { ...before!, date: date!, status: 'planned', origin: 'adapt', rationale: change.reason } };
        case 'replace': {
          const workout = resolveChoice(change, library);
          return { change, before, after: { ...before!, date: date!, workout, status: 'planned', origin: 'adapt', rationale: change.reason } };
        }
        case 'add': {
          const workout = resolveChoice(change, library);
          const after = newPlanned(workout, date!, all, { origin: 'adapt', planId, rationale: change.reason });
          all.push(after);
          return { change, after };
        }
      }
    } catch (e) {
      return { change, before, problem: (e as Error).message };
    }
    return { change, problem: 'Unknown change.' };
  });
}

export interface TodayOption {
  workout: Workout;
  reason: string;
}
export function todayOptions(out: TodayOutput, library: Workout[]): { options: TodayOption[]; problems: string[] } {
  const options: TodayOption[] = [];
  const problems: string[] = [];
  for (const o of out.options) {
    try {
      options.push({ workout: resolveChoice(o, library), reason: o.reason });
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return { options, problems };
}


export interface AdaptSuggestion {
  reason: 'missed' | 'extend';
  from: DayKey;
  to: DayKey;
  text: string;
}

/**
 * When the coach should be offered without being asked: workouts were missed
 * since the last review, or the plan's detailed workouts are about to run out.
 */
export function adaptSuggestion(plan: TrainingPlan | undefined, calendar: PlannedWorkout[], today: DayKey, lastReview?: DayKey): AdaptSuggestion | null {
  if (!plan || today > plan.end) return null;
  const since = lastReview ?? addDays(today, -7);
  const missed = calendar.filter((p) => p.status === 'missed' && p.date >= since && p.date < today);
  if (missed.length) {
    return {
      reason: 'missed',
      from: today,
      to: addDays(today, 13),
      text: missed.length === 1 ? `You missed ${missed[0].workout.name}. Want the coach to rearrange the next two weeks?` : `You missed ${missed.length} workouts. Want the coach to rearrange the next two weeks?`,
    };
  }
  const start = today < plan.start ? plan.start : today;
  const last = calendar.filter((p) => p.planId === plan.id || p.origin === 'adapt').reduce((m, p) => (p.date > m ? p.date : m), '');
  const horizon = addDays(start, 7) < plan.end ? addDays(start, 7) : plan.end;
  if (last < horizon) {
    const from = last && last >= start ? addDays(last, 1) : start;
    const to = addDays(from, 13) < plan.end ? addDays(from, 13) : plan.end;
    return { reason: 'extend', from, to, text: `Your plan has workouts through ${last || 'nothing yet'}. Let the coach plan the next two weeks from how training is going.` };
  }
  return null;
}
