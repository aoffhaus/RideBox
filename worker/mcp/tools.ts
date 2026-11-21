// The tools Claude gets through the RideBox connector: read the rider's
// training (fitness, calendar, plan, rides, library) and change the calendar,
// plan, library and FTP directly. Everything reuses the app's own training code
// (src/training, src/workout), so numbers match what the app shows, and every
// new workout passes the same checks the in-app coach's workouts do.

import { lapStats, type RideRecord } from '../../src/app/recorder';
import { uid, type Settings, type StoredWorkout } from '../../src/storage/types';
import { moveTo, newPlanned, scaleWorkout } from '../../src/training/calendar';
import { buildContext, resolveChoice } from '../../src/training/coach';
import { ftpOn, validFtpHistory, withFtpHistory, withWeightHistory } from '../../src/training/ftp';
import { activityOutcome, computeLevels, difficultyLabel, rateWorkout, rideOutcome, stravaWorkout, ZONE_NAMES, type Levels } from '../../src/training/levels';
import { addDays, dayKey, dayStart, estimateFtp, fitnessSeries, formLabel, ftpStravaCandidates, loadEntries, plannedLoad, stravaTss, weeklyTotals, type LoadEntry } from '../../src/training/load';
import type { DayKey, PlanPhase, PlannedWorkout, StravaActivity, TrainingPlan } from '../../src/training/model';
import { normalizePlan, setActive } from '../../src/training/plans';
import { flatten, plannedStats, type Workout } from '../../src/workout/model';
import { toText } from '../../src/workout/parsers';
import {
  currentJson,
  getChange,
  loadStravaPower,
  markUndone,
  readDoc,
  recentChanges,
  saveChanges,
  shiftToLocal,
  type Change,
  type RiderData,
} from './data';
import { ToolError, type JsonSchema, type Tool } from './protocol';

export interface ToolCtx {
  db: D1Database;
  /** the rider's data, loaded once per request */
  data: () => Promise<RiderData>;
}

// ---------- helpers ----------

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (k: DayKey) => WEEKDAYS[dayStart(k).getDay()];
const monday = (k: DayKey) => addDays(k, -((dayStart(k).getDay() + 6) % 7));
const minDate = (a: DayKey, b: DayKey) => (a < b ? a : b);

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const date = (description: string): JsonSchema => ({ type: 'string', pattern: DATE, description: `${description} (YYYY-MM-DD)` });
const str = (description: string, maxLength = 500): JsonSchema => ({ type: 'string', description, maxLength });

function realDate(k: unknown, field: string): DayKey {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k) || dayKey(dayStart(k)) !== k) throw new ToolError(`${field} must be a real date as YYYY-MM-DD.`);
  return k;
}
const optStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

interface Derived {
  levels: Levels;
  entries: LoadEntry[];
  workouts: Workout[];
}
const derivedCache = new WeakMap<RiderData, Derived>();
function derive(d: RiderData): Derived {
  let x = derivedCache.get(d);
  if (!x) {
    const workouts = d.library.map((w) => w.workout);
    x = {
      workouts,
      levels: computeLevels(d.rides, d.acts, d.calendar, workouts, d.settings.ftp, d.now, (t) => ftpOn(d.settings, dayKey(t))).levels,
      entries: loadEntries(d.rides, d.acts, d.settings.ftp, d.settings.maxHr),
    };
    derivedCache.set(d, x);
  }
  return x;
}

function workoutInfo(w: Workout, ftp: number, levels: Levels) {
  const st = plannedStats(flatten(w), ftp);
  const r = rateWorkout(w, ftp);
  return {
    zone: ZONE_NAMES[r.zone],
    level: r.level,
    difficulty: difficultyLabel(r, levels).label,
    minutes: Math.round(st.duration / 60),
    tss: Math.round(st.tss),
    intensity_factor: r2(st.if),
  };
}

function itemView(p: PlannedWorkout, d: RiderData) {
  const { levels } = derive(d);
  const ride = p.rideId ? d.rides.find((r) => r.id === p.rideId) : undefined;
  const act = p.stravaId ? d.acts.find((a) => a.id === p.stravaId) : undefined;
  return {
    id: p.id,
    date: p.date,
    weekday: weekday(p.date),
    name: p.workout.name,
    ...workoutInfo(p.workout, d.settings.ftp, levels),
    status: p.status,
    origin: p.origin,
    phase: p.phase,
    rationale: p.rationale,
    note: p.note,
    completed_by: ride ? { activity_id: ride.id, name: ride.name } : act ? { activity_id: act.id, name: act.name } : undefined,
  };
}

function findItem(d: RiderData, id: unknown): PlannedWorkout {
  const p = d.calendar.find((c) => c.id === id);
  if (!p) throw new ToolError(`No calendar workout with id "${String(id)}". Use get_calendar to find ids.`);
  return p;
}

function findLibrary(d: RiderData, args: Record<string, unknown>): StoredWorkout | undefined {
  const id = optStr(args.library_id);
  if (id) {
    const w = d.library.find((x) => x.id === id);
    if (!w) throw new ToolError(`No library workout with id "${id}".`);
    return w;
  }
  const name = optStr(args.library_name);
  if (!name) return undefined;
  const w = d.library.find((x) => x.workout.name === name) ?? d.library.find((x) => x.workout.name.toLowerCase() === name.toLowerCase());
  if (!w) throw new ToolError(`No library workout named "${name}". Use list_library to see names, or pass text to write a new workout.`);
  return w;
}

/** A library workout, or a new one written in RideBox shorthand (validated like the in-app coach's). */
function workoutFrom(d: RiderData, args: Record<string, unknown>): Workout {
  const lib = findLibrary(d, args);
  if (lib) return lib.workout;
  const text = optStr(args.text);
  if (!text) throw new ToolError('Give either library_name / library_id, or text (RideBox shorthand) with a name.');
  try {
    const w = resolveChoice({ library_name: '', workout: { name: optStr(args.name) ?? '', description: optStr(args.description) ?? '', text } } as never, []);
    return { ...w, author: 'Claude' };
  } catch (e) {
    throw new ToolError(`That workout didn't pass RideBox's checks: ${(e as Error).message}`);
  }
}

function planFor(d: RiderData, date: DayKey): { plan?: TrainingPlan; phase?: string } {
  const plan = d.plans.find((p) => p.active && p.start <= date && date <= p.end);
  return { plan, phase: plan?.phases.find((ph) => ph.start <= date && date <= ph.end)?.name };
}

const SYNC_NOTE = 'Saved. Open browsers pick this up when the RideBox tab gets focus, or within 5 minutes.';

async function save(ctx: ToolCtx, tool: string, summary: string, changes: Change[]) {
  const ids = await saveChanges(ctx.db, tool, summary, changes);
  return { change_ids: ids, note: SYNC_NOTE };
}

const WORKOUT_SOURCE_PROPS: Record<string, JsonSchema> = {
  library_name: str('Exact name of a workout in the library (see list_library). Preferred when one fits.', 200),
  library_id: str('Id of a library workout (alternative to library_name).', 100),
  name: str('Name for a new workout written in text, e.g. "Threshold 3x12".', 120),
  description: str('One or two sentences on the purpose of a new workout.', 600),
  text: str(
    'A new workout in RideBox shorthand, one step per line. Power is % of FTP. Examples: "10m 45-70%" (ramp), "20m @88%" (steady), ' +
      '"3x(12m @92% \\"Sweet spot\\", 4m @50% \\"Recover\\")" (repeat with labels), "5x(1m @110% 100rpm, 1m @55%)" (cadence), "10m free" (no target), "5m @150w" (watts). ' +
      'Durations: 30s, 5m, 1h, 1h15m. Include a warm-up and cool-down. 10 minutes to 8 hours.',
    4000,
  ),
};

const PHASES: JsonSchema = {
  type: 'array',
  maxItems: 12,
  description: 'Plan phases in order (Base, Build, Specialty, Taper…).',
  items: { type: 'object', required: ['name', 'start', 'end'], properties: { name: str('Phase name', 60), start: date('First day'), end: date('Last day'), focus: str('What the phase works on', 300) } },
};

function parsePhases(v: unknown): PlanPhase[] {
  return ((v as { name: string; start: string; end: string; focus?: string }[]) ?? []).map((p, i) => {
    const start = realDate(p.start, `phases[${i}].start`);
    const end = realDate(p.end, `phases[${i}].end`);
    if (end < start) throw new ToolError(`phases[${i}] ends before it starts.`);
    return { name: p.name.trim(), start, end, focus: p.focus?.trim() ?? '' };
  });
}

// ---------- read tools ----------

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const getTrainingSummary: Tool<ToolCtx> = {
  name: 'get_training_summary',
  title: 'Training summary',
  description:
    "Start here. The rider's current picture: today's date in their time zone, FTP (set and estimated), weight, max HR, progression levels per zone (1-10), " +
    'fitness (CTL), fatigue (ATL), form (TSB), weekly training history, the active plan with its phases and weekly targets, the last 14 days of activities ' +
    'with how they went, the next 14 days of planned workouts, and a week-by-week fitness projection from the calendar.',
  inputSchema: { properties: { weeks_of_history: { type: 'integer', minimum: 1, maximum: 52, description: 'Weeks of weekly totals to include (default 8).' } }, additionalProperties: false },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const { levels, entries, workouts } = derive(d);
    const c = buildContext({ settings: d.settings, rides: d.rides, acts: d.acts, calendar: d.calendar, plans: d.plans, library: workouts, levels, today: d.today }, 14);
    const weeks = Number(args.weeks_of_history ?? 8);
    const plan = d.plans.find((p) => p.active);
    const end = minDate(addDays(d.today, 180), plan && plan.end > addDays(d.today, 28) ? plan.end : addDays(d.today, 28));
    const series = fitnessSeries(entries, plannedLoad(d.calendar, d.settings.ftp), addDays(d.today, -400), end, d.today);
    const projection = series
      .filter((x) => x.future && x.date >= addDays(d.today, 7) && weekday(x.date) === weekday(d.today))
      .map((x) => ({ date: x.date, ctl: r1(x.ctl), atl: r1(x.atl), tsb: r1(x.tsb) }));
    const ftpCandidates = ftpStravaCandidates(d.rides, d.acts, 90, d.now);
    const stravaPower = await loadStravaPower(ctx.db, ftpCandidates);
    const est = estimateFtp(d.rides, 90, d.now, stravaPower);
    const noStreams = ftpCandidates.length - stravaPower.length;
    return {
      today: d.today,
      weekday: weekday(d.today),
      timezone: d.timezone,
      athlete: {
        ftp: d.settings.ftp,
        ftp_history: d.settings.ftpHistory,
        weight_history: d.settings.weightHistory,
        ftp_estimate: est
          ? {
              ftp: est.ftp,
              best_20min_watts: est.best20,
              date: est.date,
              from: { source: est.source, name: est.name },
              method: '95% of best 20 minutes in the last 90 days, from RideBox rides and Strava rides recorded with a power meter',
            }
          : null,
        weight_kg: d.settings.riderKg,
        max_hr: d.settings.maxHr,
        units: d.settings.units,
      },
      levels: Object.fromEntries(Object.entries(levels).map(([z, v]) => [ZONE_NAMES[z as keyof typeof ZONE_NAMES], v])),
      fitness: { ctl: c.fitness.ctl, atl: c.fitness.atl, tsb: c.fitness.tsb, ctl_change_7d: c.fitness.ctlChange7d, form: formLabel(c.fitness.tsb) },
      weekly_history: weeklyTotals(entries, addDays(monday(d.today), -7 * (weeks - 1)), d.today).map((w) => ({ week_of: w.week, tss: Math.round(w.tss), hours: r1(w.seconds / 3600) })),
      active_plan: plan
        ? { id: plan.id, name: plan.name, goal: plan.goal, event_date: plan.eventDate, start: plan.start, end: plan.end, phases: plan.phases, notes: plan.notes }
        : null,
      recent_activities: c.recent.map((a) => ({ ...a, zone: a.zone ? (ZONE_NAMES[a.zone as keyof typeof ZONE_NAMES] ?? a.zone) : undefined })),
      upcoming: d.calendar
        .filter((p) => p.date >= d.today && p.date <= addDays(d.today, 14))
        .sort((a, b) => (a.date === b.date ? (a.order ?? 0) - (b.order ?? 0) : a.date < b.date ? -1 : 1))
        .map((p) => itemView(p, d)),
      projection_weekly: projection,
      notes: [
        'TSS for Strava activities uses power when there is a power meter, else heart rate, else a duration estimate.',
        'Progression levels: a productive workout is 0 to +1 above the zone level; never plan more than +1.5 above.',
        ...(noStreams
          ? [`${noStreams} Strava power-meter ride${noStreams === 1 ? '' : 's'} from the last 90 days ${noStreams === 1 ? 'has' : 'have'} no saved power data yet, so the FTP estimate doesn't include ${noStreams === 1 ? 'it' : 'them'}; opening RideBox downloads it.`]
          : []),
        ...(d.ridesPending ? [`${d.ridesPending} RideBox rides are still being indexed; numbers may change slightly on the next call.`] : []),
      ],
    };
  },
};

const getCalendar: Tool<ToolCtx> = {
  name: 'get_calendar',
  title: 'Calendar',
  description:
    'Planned workouts and completed activities day by day between two dates, with each workout\'s id (needed to change it), zone, level, difficulty for the rider, ' +
    'minutes, TSS, status (planned / done / missed / skipped), notes and the coach\'s rationale, plus weekly planned vs. done TSS and hours. Defaults to this week and next.',
  inputSchema: { properties: { from: date('First day (default: Monday of this week)'), to: date('Last day (default: 13 days after from); at most 120 days after from') }, additionalProperties: false },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const { entries } = derive(d);
    const from = args.from ? realDate(args.from, 'from') : monday(d.today);
    const to = args.to ? realDate(args.to, 'to') : addDays(from, 13);
    if (to < from) throw new ToolError('"to" is before "from".');
    if (to > addDays(from, 120)) throw new ToolError('Ask for at most 120 days at a time.');
    const items = d.calendar.filter((p) => p.date >= from && p.date <= to).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const acts = entries.filter((e) => e.date >= from && e.date <= to);
    const days: unknown[] = [];
    for (let k = from; k <= to; k = addDays(k, 1)) {
      const planned = items.filter((p) => p.date === k).map((p) => itemView(p, d));
      const activities = acts.filter((e) => e.date === k).map((e) => ({ activity_id: e.id, source: e.kind, name: e.name, minutes: Math.round(e.seconds / 60), tss: Math.round(e.tss) }));
      if (planned.length || activities.length) days.push({ date: k, weekday: weekday(k), planned, activities });
    }
    const weeks = weeklyTotals(entries, from, to).map((w) => {
      const wk = items.filter((p) => p.date >= w.week && p.date < addDays(w.week, 7) && p.status !== 'skipped');
      const st = wk.map((p) => plannedStats(flatten(p.workout), d.settings.ftp));
      return {
        week_of: w.week,
        planned_tss: Math.round(st.reduce((a, s) => a + s.tss, 0)),
        planned_hours: r1(st.reduce((a, s) => a + s.duration, 0) / 3600),
        done_tss: Math.round(w.tss),
        done_hours: r1(w.seconds / 3600),
      };
    });
    return { today: d.today, from, to, days, weeks };
  },
};

const getPlan: Tool<ToolCtx> = {
  name: 'get_plan',
  title: 'Training plan',
  description: "The active training plan in full (goal, event date, phases, weekly focus and targets in its notes, the rider's availability per weekday if the plan has it), plus a list of the rider's other plans.",
  inputSchema: { properties: { plan_id: str('A specific plan (default: the active one)', 100) }, additionalProperties: false },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const plan = args.plan_id ? d.plans.find((p) => p.id === args.plan_id) : d.plans.find((p) => p.active);
    if (args.plan_id && !plan) throw new ToolError(`No plan with id "${String(args.plan_id)}".`);
    const items = plan ? d.calendar.filter((c) => c.planId === plan.id) : [];
    return {
      plan: plan
        ? {
            id: plan.id,
            name: plan.name,
            goal: plan.goal,
            event_date: plan.eventDate,
            start: plan.start,
            end: plan.end,
            active: plan.active,
            phases: plan.phases,
            notes: plan.notes,
            availability_minutes_per_weekday: plan.input?.days,
            weekly_hours: plan.input?.weeklyHours,
            experience: plan.input?.experience,
            workouts: { planned: items.filter((i) => i.status === 'planned').length, done: items.filter((i) => i.status === 'done').length, missed: items.filter((i) => i.status === 'missed').length, last_scheduled: items.reduce((m, i) => (i.date > m ? i.date : m), '') || null },
          }
        : null,
      other_plans: d.plans.filter((p) => p !== plan).map((p) => ({ id: p.id, name: p.name, goal: p.goal, start: p.start, end: p.end, active: p.active })),
    };
  },
};

function rideDetails(r: RideRecord, d: RiderData) {
  const { workouts } = derive(d);
  const planned = d.calendar.find((p) => p.rideId === r.id);
  const w = planned?.workout ?? (r.workoutName ? workouts.find((x) => x.name === r.workoutName) : undefined);
  const ftp = r.ftp || d.settings.ftp;
  const outcome = w ? rideOutcome(r, plannedStats(flatten(w), ftp).duration) : undefined;
  const rating = w ? rateWorkout(w, ftp) : undefined;
  return {
    activity_id: r.id,
    source: 'ridebox',
    name: r.name,
    date: dayKey(r.startTime),
    workout: r.workoutName,
    calendar_id: planned?.id,
    minutes: Math.round(r.summary.duration / 60),
    tss: Math.round(r.summary.tss),
    np: Math.round(r.summary.np),
    intensity_factor: r2(r.summary.if),
    avg_power: Math.round(r.summary.avgPower),
    avg_hr: r.summary.avgHr ? Math.round(r.summary.avgHr) : undefined,
    ftp_at_ride: ftp,
    zone: rating ? ZONE_NAMES[rating.zone] : undefined,
    workout_level: rating?.level,
    outcome: outcome?.outcome,
    compliance: outcome ? r2(outcome.compliance) : undefined,
    feel: r.feel,
    feel_scale: r.feel ? '1 easy … 5 all out' : undefined,
    on_strava: r.strava?.status === 'done' ? r.strava.activityId : undefined,
  };
}

function actDetails(a: StravaActivity, d: RiderData) {
  const t = stravaTss(a, d.settings.ftp, d.settings.maxHr);
  // a workout ridden in another app, matched by name (rated at the FTP of that day)
  const w = stravaWorkout(a, d.calendar, derive(d).workouts);
  const actFtp = ftpOn(d.settings, dayKey(a.start));
  const rating = w ? rateWorkout(w, actFtp) : undefined;
  const outcome = w ? activityOutcome(a, w, actFtp) : undefined;
  return {
    activity_id: a.id,
    source: 'strava',
    name: a.name,
    sport: a.sportType,
    date: dayKey(a.start),
    minutes: Math.round(a.movingTime / 60),
    distance_km: r1(a.distance / 1000),
    climb_m: a.climb != null ? Math.round(a.climb) : undefined,
    tss: Math.round(t.tss),
    tss_from: t.source,
    avg_power: a.avgWatts != null ? Math.round(a.avgWatts) : undefined,
    weighted_power: a.weightedWatts != null ? Math.round(a.weightedWatts) : undefined,
    power_meter: a.deviceWatts,
    avg_hr: a.avgHr != null ? Math.round(a.avgHr) : undefined,
    max_hr: a.maxHr,
    avg_cadence: a.avgCadence != null ? Math.round(a.avgCadence) : undefined,
    indoor: a.trainer,
    ftp_that_day: w ? actFtp : undefined,
    workout: w?.name,
    zone: rating ? ZONE_NAMES[rating.zone] : undefined,
    workout_level: rating?.level,
    outcome: outcome?.outcome,
    compliance: outcome ? r2(outcome.compliance) : undefined,
  };
}

const listActivities: Tool<ToolCtx> = {
  name: 'list_activities',
  title: 'Activities',
  description:
    'Completed activities between two dates, newest first: RideBox rides (with the workout, outcome pass / struggle / fail, compliance with targets, how it felt 1-5, NP, IF, TSS) ' +
    'and Strava activities (sport, distance, climbing, power, heart rate, TSS; workouts ridden in other apps that match a workout by name also get zone, level, outcome and compliance, judged from NP vs. plan). Strava copies of RideBox rides are left out. Defaults to the last 14 days.',
  inputSchema: {
    properties: { from: date('First day (default: 13 days ago)'), to: date('Last day (default: today)'), limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max activities (default 50)' } },
    additionalProperties: false,
  },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const { entries } = derive(d);
    const from = args.from ? realDate(args.from, 'from') : addDays(d.today, -13);
    const to = args.to ? realDate(args.to, 'to') : d.today;
    const limit = Number(args.limit ?? 50);
    const rides = new Map(d.rides.map((r) => [r.id, r]));
    const acts = new Map(d.acts.map((a) => [a.id, a]));
    const list = entries
      .filter((e) => e.date >= from && e.date <= to)
      .reverse()
      .slice(0, limit)
      .map((e) => (e.kind === 'ridebox' ? rideDetails(rides.get(e.id)!, d) : actDetails(acts.get(e.id)!, d)));
    return { from, to, count: list.length, activities: list };
  },
};

const getActivity: Tool<ToolCtx> = {
  name: 'get_activity',
  title: 'Activity details',
  description: 'One activity in detail. For a RideBox ride this includes every interval (lap): target vs. actual power, heart rate and cadence. Use activity ids from list_activities or get_calendar.',
  inputSchema: { required: ['activity_id'], properties: { activity_id: str('Activity id', 100) }, additionalProperties: false },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const id = String(args.activity_id);
    const act = d.acts.find((a) => a.id === id);
    if (act) return actDetails(act, d);
    const lite = d.rides.find((r) => r.id === id);
    const full = await readDoc<RideRecord>(ctx.db, 'rides', id);
    if (!lite || !full) throw new ToolError(`No activity with id "${id}".`);
    const r = { ...full.value, startTime: shiftToLocal(d.timezone, full.value.startTime) };
    const laps = r.laps.slice(0, 80).map((lap, i) => {
      const s = lapStats(r.samples, lap);
      return {
        lap: i + 1,
        label: lap.label,
        seconds: s.duration,
        target_watts: lap.target ? Math.round(lap.target) : undefined,
        avg_watts: Math.round(s.avgPower),
        avg_hr: s.avgHr ? Math.round(s.avgHr) : undefined,
        max_hr: s.maxHr,
        avg_cadence: s.avgCadence ? Math.round(s.avgCadence) : undefined,
      };
    });
    return {
      ...rideDetails(r, d),
      max_power: Math.round(r.summary.maxPower),
      max_hr: r.summary.maxHr,
      avg_cadence: r.summary.avgCadence ? Math.round(r.summary.avgCadence) : undefined,
      kj: Math.round(r.summary.kj),
      route: r.routeName,
      laps,
      laps_truncated: r.laps.length > 80 ? r.laps.length : undefined,
    };
  },
};

const listLibrary: Tool<ToolCtx> = {
  name: 'list_library',
  title: 'Workout library',
  description: "The rider's workout library with each workout's zone, level (1-10), difficulty relative to the rider's current level, minutes and TSS. Filter by text, zone or length.",
  inputSchema: {
    properties: {
      query: str('Words to match in the name or description', 100),
      zone: { type: 'string', enum: ['Recovery', 'Endurance', 'Tempo', 'Sweet Spot', 'Threshold', 'VO2max', 'Anaerobic', 'Test'], description: 'Only this zone' },
      max_minutes: { type: 'integer', minimum: 10, maximum: 600, description: 'Only workouts this long or shorter' },
      limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Max results (default 100)' },
    },
    additionalProperties: false,
  },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const { levels } = derive(d);
    const q = optStr(args.query)?.toLowerCase().split(/\s+/) ?? [];
    const all = d.library.map((w) => ({ id: w.id, name: w.workout.name, ...workoutInfo(w.workout, d.settings.ftp, levels), source: w.source, favorite: w.favorite || undefined, description: w.workout.description }));
    const hits = all.filter(
      (w) =>
        q.every((t) => `${w.name} ${w.description ?? ''}`.toLowerCase().includes(t)) &&
        (!args.zone || w.zone === args.zone) &&
        (args.max_minutes == null || w.minutes <= Number(args.max_minutes)),
    );
    const limit = Number(args.limit ?? 100);
    return { total: hits.length, workouts: hits.slice(0, limit).map((w) => ({ ...w, description: w.description && w.description.length > 160 ? `${w.description.slice(0, 157)}…` : w.description })) };
  },
};

const getWorkout: Tool<ToolCtx> = {
  name: 'get_workout',
  title: 'Workout details',
  description: 'The full structure of a workout as RideBox shorthand (each step\'s duration and % FTP), with its description, zone, level, minutes, TSS and IF. Give a calendar_id, library_id or library_name.',
  inputSchema: { properties: { calendar_id: str('A calendar workout id', 100), library_id: str('A library workout id', 100), library_name: str('A library workout name', 200) }, additionalProperties: false },
  annotations: READ,
  async run(args, ctx) {
    const d = await ctx.data();
    const { levels } = derive(d);
    let w: Workout | undefined;
    if (args.calendar_id) w = findItem(d, args.calendar_id).workout;
    else w = findLibrary(d, args)?.workout;
    if (!w) throw new ToolError('Give a calendar_id, library_id or library_name.');
    return { name: w.name, description: w.description, author: w.author, ...workoutInfo(w, d.settings.ftp, levels), ftp: d.settings.ftp, text: toText(w) };
  },
};

// ---------- calendar changes ----------

const scheduleWorkout: Tool<ToolCtx> = {
  name: 'schedule_workout',
  title: 'Schedule a workout',
  description:
    'Adds a workout to the calendar on a date: a library workout (library_name or library_id, preferred) or a new one written in RideBox shorthand (name, description, text). ' +
    'If the date falls in the active plan, the workout joins that plan. Check the day first with get_calendar so you don\'t double up.',
  inputSchema: {
    required: ['date'],
    properties: { date: date('Day to ride it'), ...WORKOUT_SOURCE_PROPS, rationale: str('One sentence to the rider on why this workout, shown on the calendar card', 300), note: str('A note on the workout', 500) },
    additionalProperties: false,
  },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const day = realDate(args.date, 'date');
    const workout = workoutFrom(d, args);
    const { plan, phase } = planFor(d, day);
    const item = newPlanned(workout, day, d.calendar, { origin: 'adapt', planId: plan?.id, phase, rationale: optStr(args.rationale), note: optStr(args.note) });
    const res = await save(ctx, 'schedule_workout', `Scheduled ${workout.name} on ${day}`, [{ store: 'calendar', id: item.id, value: item }]);
    return { scheduled: itemView(item, d), ...res };
  },
};

const moveWorkout: Tool<ToolCtx> = {
  name: 'move_workout',
  title: 'Move a workout',
  description: 'Moves a calendar workout to another day. A missed workout moved to today or later goes back to planned.',
  inputSchema: { required: ['id', 'date'], properties: { id: str('Calendar workout id', 100), date: date('New day'), rationale: str('Why, in one sentence to the rider', 300) }, additionalProperties: false },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const p = findItem(d, args.id);
    if (p.status === 'done') throw new ToolError('That workout is already done; it stays on the day it was ridden.');
    const day = realDate(args.date, 'date');
    const moved = { ...moveTo(p, day, d.calendar, d.today), rationale: optStr(args.rationale) ?? p.rationale };
    const res = await save(ctx, 'move_workout', `Moved ${p.workout.name} from ${p.date} to ${day}`, [{ store: 'calendar', id: p.id, value: moved }]);
    return { moved: itemView(moved, d), from: p.date, ...res };
  },
};

const replaceWorkout: Tool<ToolCtx> = {
  name: 'replace_workout',
  title: 'Replace a workout',
  description: 'Swaps the workout of a calendar entry for a library workout or a new shorthand one, keeping its day and note. Optionally moves it too.',
  inputSchema: {
    required: ['id'],
    properties: { id: str('Calendar workout id', 100), ...WORKOUT_SOURCE_PROPS, date: date('Optional new day'), rationale: str('Why, in one sentence to the rider', 300) },
    additionalProperties: false,
  },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const p = findItem(d, args.id);
    if (p.status === 'done') throw new ToolError('That workout is already done.');
    const workout = workoutFrom(d, args);
    const day = args.date ? realDate(args.date, 'date') : p.date;
    const base = day === p.date ? p : moveTo(p, day, d.calendar, d.today);
    const next: PlannedWorkout = { ...base, workout, status: 'planned', origin: 'adapt', rationale: optStr(args.rationale) ?? p.rationale };
    const res = await save(ctx, 'replace_workout', `Replaced ${p.workout.name} with ${workout.name} on ${day}`, [{ store: 'calendar', id: p.id, value: next }]);
    return { replaced: p.workout.name, now: itemView(next, d), ...res };
  },
};

const adjustIntensity: Tool<ToolCtx> = {
  name: 'adjust_workout_intensity',
  title: 'Make a workout easier or harder',
  description: "Scales a calendar workout's work intervals (warm-ups, recoveries and cool-downs stay as they are), like the calendar's Easier / Harder buttons (95% / 105%).",
  inputSchema: {
    required: ['id', 'percent'],
    properties: { id: str('Calendar workout id', 100), percent: { type: 'number', minimum: 80, maximum: 120, description: 'New intensity of the work intervals, e.g. 95 for 5% easier, 105 for 5% harder' } },
    additionalProperties: false,
  },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const p = findItem(d, args.id);
    if (p.status === 'done') throw new ToolError('That workout is already done.');
    const pct = Number(args.percent);
    const next = { ...p, workout: scaleWorkout(p.workout, pct / 100) };
    const res = await save(ctx, 'adjust_workout_intensity', `${p.workout.name} on ${p.date} at ${pct}%`, [{ store: 'calendar', id: p.id, value: next }]);
    return { before: itemView(p, d), after: itemView(next, d), ...res };
  },
};

const setWorkoutStatus: Tool<ToolCtx> = {
  name: 'skip_workout',
  title: 'Skip or unskip a workout',
  description: 'Marks a calendar workout skipped (it stays on the calendar but no longer counts as planned load or as missed), or back to planned.',
  inputSchema: { required: ['id'], properties: { id: str('Calendar workout id', 100), skipped: { type: 'boolean', description: 'true to skip (default), false to put it back' }, note: str('Optional note, e.g. why', 500) }, additionalProperties: false },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const p = findItem(d, args.id);
    if (p.status === 'done') throw new ToolError('That workout is already done.');
    const skip = args.skipped !== false;
    const next: PlannedWorkout = { ...p, status: skip ? 'skipped' : p.date < d.today ? 'missed' : 'planned', note: optStr(args.note) ?? p.note };
    const res = await save(ctx, 'skip_workout', `${skip ? 'Skipped' : 'Unskipped'} ${p.workout.name} on ${p.date}`, [{ store: 'calendar', id: p.id, value: next }]);
    return { workout: itemView(next, d), ...res };
  },
};

const setWorkoutNote: Tool<ToolCtx> = {
  name: 'set_workout_note',
  title: 'Note on a workout',
  description: 'Sets (or clears, with an empty note) the note on a calendar workout.',
  inputSchema: { required: ['id', 'note'], properties: { id: str('Calendar workout id', 100), note: { type: 'string', maxLength: 1000, description: 'The note ("" clears it)' } }, additionalProperties: false },
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const d = await ctx.data();
    const p = findItem(d, args.id);
    const next = { ...p, note: optStr(args.note) };
    const res = await save(ctx, 'set_workout_note', `Note on ${p.workout.name} (${p.date})`, [{ store: 'calendar', id: p.id, value: next }]);
    return { workout: itemView(next, d), ...res };
  },
};

const removeWorkout: Tool<ToolCtx> = {
  name: 'remove_workout',
  title: 'Remove a workout',
  description: 'Deletes a workout from the calendar. Prefer skip_workout when the rider might want it back; this can still be undone with undo_change.',
  inputSchema: { required: ['id'], properties: { id: str('Calendar workout id', 100) }, additionalProperties: false },
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const d = await ctx.data();
    const p = findItem(d, args.id);
    if (p.status === 'done') throw new ToolError('That workout is done and linked to a ride; it stays as history.');
    const res = await save(ctx, 'remove_workout', `Removed ${p.workout.name} from ${p.date}`, [{ store: 'calendar', id: p.id, value: null }]);
    return { removed: itemView(p, d), ...res };
  },
};

// ---------- library, plan, settings ----------

const saveLibraryWorkout: Tool<ToolCtx> = {
  name: 'save_library_workout',
  title: 'Save a workout to the library',
  description: "Adds a new workout, written in RideBox shorthand, to the rider's library so it can be ridden any time or scheduled later.",
  inputSchema: { required: ['name', 'text'], properties: { name: WORKOUT_SOURCE_PROPS.name, description: WORKOUT_SOURCE_PROPS.description, text: WORKOUT_SOURCE_PROPS.text }, additionalProperties: false },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    if (d.library.some((w) => w.workout.name.toLowerCase() === String(args.name).trim().toLowerCase())) throw new ToolError(`The library already has a workout named "${String(args.name).trim()}". Pick another name.`);
    const workout = workoutFrom(d, { name: args.name, description: args.description, text: args.text });
    const stored: StoredWorkout = { id: uid(), workout, source: 'claude', createdAt: Date.now() };
    const res = await save(ctx, 'save_library_workout', `Added ${workout.name} to the library`, [{ store: 'workouts', id: stored.id, value: stored }]);
    return { saved: { id: stored.id, name: workout.name, ...workoutInfo(workout, d.settings.ftp, derive(d).levels) }, ...res };
  },
};

const createPlan: Tool<ToolCtx> = {
  name: 'create_plan',
  title: 'Create a training plan',
  description:
    'Creates a training plan and makes it the active one (any other active plan becomes inactive; its workouts stay on the calendar). ' +
    'Put the weekly focus and TSS / hour targets in notes, one line per week. Then add the workouts with schedule_workout.',
  inputSchema: {
    required: ['name', 'goal', 'start_date', 'end_date'],
    properties: { name: str('Plan name', 120), goal: str('The goal in the rider\'s words', 300), start_date: date('First day'), end_date: date('Last day'), event_date: date('Event day, if any'), phases: PHASES, notes: str('Summary and week-by-week targets', 6000) },
    additionalProperties: false,
  },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const start = realDate(args.start_date, 'start_date');
    const end = realDate(args.end_date, 'end_date');
    if (end < start) throw new ToolError('end_date is before start_date.');
    const plan = normalizePlan({
      id: uid(),
      name: String(args.name).trim(),
      goal: String(args.goal).trim(),
      eventDate: args.event_date ? realDate(args.event_date, 'event_date') : undefined,
      start,
      end,
      phases: parsePhases(args.phases),
      notes: optStr(args.notes),
      createdAt: Date.now(),
      active: true,
    });
    const deactivated = setActive(d.plans, null).filter((p) => p.id !== plan.id);
    const res = await save(ctx, 'create_plan', `Created plan ${plan.name}`, [...deactivated.map((p) => ({ store: 'plans' as const, id: p.id, value: p })), { store: 'plans', id: plan.id, value: plan }]);
    return { plan, deactivated: deactivated.map((p) => p.name), ...res };
  },
};

const updatePlan: Tool<ToolCtx> = {
  name: 'update_plan',
  title: 'Update a training plan',
  description: "Changes a plan's name, goal, dates, event date, phases or notes, or makes it the active plan. Only the fields given change. Workouts on the calendar aren't moved.",
  inputSchema: {
    properties: {
      plan_id: str('Plan id (default: the active plan)', 100),
      name: str('New name', 120),
      goal: str('New goal', 300),
      start_date: date('New first day'),
      end_date: date('New last day'),
      event_date: { type: 'string', description: 'New event day (YYYY-MM-DD), or "" to clear it', maxLength: 10 },
      phases: { ...PHASES, description: 'Replaces all phases' },
      notes: { type: 'string', maxLength: 6000, description: 'Replaces the notes' },
      active: { type: 'boolean', description: 'true makes this the active plan (others become inactive); false deactivates it' },
    },
    additionalProperties: false,
  },
  annotations: WRITE,
  async run(args, ctx) {
    const d = await ctx.data();
    const plan = args.plan_id ? d.plans.find((p) => p.id === args.plan_id) : d.plans.find((p) => p.active);
    if (!plan) throw new ToolError(args.plan_id ? `No plan with id "${String(args.plan_id)}".` : 'There is no active plan. Pass plan_id (see get_plan) or use create_plan.');
    const next: TrainingPlan = { ...plan };
    if (args.name != null) next.name = String(args.name).trim() || plan.name;
    if (args.goal != null) next.goal = String(args.goal).trim() || plan.goal;
    if (args.start_date != null) next.start = realDate(args.start_date, 'start_date');
    if (args.end_date != null) next.end = realDate(args.end_date, 'end_date');
    if (args.event_date != null) next.eventDate = args.event_date === '' ? undefined : realDate(args.event_date, 'event_date');
    if (args.phases != null) next.phases = parsePhases(args.phases);
    if (args.notes != null) next.notes = optStr(args.notes);
    if (next.end < next.start) throw new ToolError('The plan would end before it starts.');
    let others: TrainingPlan[] = [];
    if (args.active === true) {
      others = setActive(d.plans, plan.id).filter((p) => p.id !== plan.id);
      next.active = true;
    } else if (args.active === false) next.active = false;
    const saved = normalizePlan(next);
    const res = await save(ctx, 'update_plan', `Updated plan ${saved.name}`, [...others.map((p) => ({ store: 'plans' as const, id: p.id, value: p })), { store: 'plans', id: saved.id, value: saved }]);
    return { plan: saved, ...res };
  },
};

const updateSettings: Tool<ToolCtx> = {
  name: 'update_athlete_settings',
  title: 'Update FTP, weight or max HR',
  description:
    "Changes the rider's FTP (watts), weight (kg) or max heart rate. FTP sets every ERG target, so confirm a new FTP with the rider first. " +
    'A new FTP or weight is recorded in its history from today. ftp_history replaces the record of past FTP changes (used to judge workouts ridden in other apps at the FTP of their day); the current FTP always applies from the last change on.',
  inputSchema: {
    properties: {
      ftp: { type: 'integer', minimum: 50, maximum: 600, description: 'FTP in watts' },
      weight_kg: { type: 'number', minimum: 30, maximum: 200, description: 'Rider weight in kg' },
      max_hr: { type: 'integer', minimum: 120, maximum: 230, description: 'Max heart rate (bpm)' },
      ftp_history: {
        type: 'array',
        description: 'Past FTP changes, replacing the stored history: each FTP and the day it took effect, e.g. [{"from":"2026-01-01","ftp":233},{"from":"2026-11-10","ftp":252}]',
        items: {
          type: 'object',
          required: ['from', 'ftp'],
          properties: { from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, ftp: { type: 'integer', minimum: 50, maximum: 600 } },
          additionalProperties: false,
        },
        maxItems: 100,
      },
    },
    additionalProperties: false,
  },
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const d = await ctx.data();
    let next: Settings = { ...d.settings };
    if (args.ftp_history != null) {
      const h = validFtpHistory(args.ftp_history);
      if (typeof h === 'string') throw new ToolError(h);
      next.ftpHistory = h;
    }
    if (args.ftp != null) next = withFtpHistory(next, { ...next, ftp: Number(args.ftp) }, d.today);
    if (args.weight_kg != null) next = withWeightHistory(next, { ...next, riderKg: r1(Number(args.weight_kg)) }, d.today);
    if (args.max_hr != null) next.maxHr = Number(args.max_hr);
    const what = [
      args.ftp != null && `FTP ${next.ftp} W`,
      args.ftp_history != null && `FTP history (${(next.ftpHistory ?? []).map((c) => `${c.ftp} W from ${c.from}`).join(', ')})`,
      args.weight_kg != null && `weight ${next.riderKg} kg`,
      args.max_hr != null && `max HR ${next.maxHr}`,
    ].filter(Boolean).join(', ');
    if (!what) throw new ToolError('Give ftp, ftp_history, weight_kg or max_hr.');
    const res = await save(ctx, 'update_athlete_settings', `Set ${what}`, [{ store: 'kv', id: 'settings', value: next }]);
    const view = (x: Settings) => ({ ftp: x.ftp, ftp_history: x.ftpHistory, weight_kg: x.riderKg, max_hr: x.maxHr });
    return { before: view(d.settings), after: view(next), ...res };
  },
};

// ---------- change log ----------

const listChanges: Tool<ToolCtx> = {
  name: 'list_recent_changes',
  title: 'Recent changes by Claude',
  description: 'The changes made through this connector, newest first, with ids for undo_change.',
  inputSchema: { properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many (default 20)' } }, additionalProperties: false },
  annotations: READ,
  async run(args, ctx) {
    const rows = await recentChanges(ctx.db, Number(args.limit ?? 20));
    return { changes: rows.map((r) => ({ change_id: r.id, at: new Date(r.at).toISOString(), tool: r.tool, summary: r.summary, kind: r.store, record_id: r.doc_id, undone: !!r.undone })) };
  },
};

const undoChange: Tool<ToolCtx> = {
  name: 'undo_change',
  title: 'Undo a change',
  description: 'Puts a record back the way it was before a change made through this connector. Refuses if the record was changed again since (undo the later change first).',
  inputSchema: { required: ['change_id'], properties: { change_id: { type: 'integer', minimum: 1, description: 'From list_recent_changes or a tool result' } }, additionalProperties: false },
  annotations: WRITE,
  async run(args, ctx) {
    const c = await getChange(ctx.db, Number(args.change_id));
    if (!c) throw new ToolError(`No change ${String(args.change_id)}.`);
    if (c.undone) throw new ToolError(`Change ${c.id} was already undone.`);
    const now = await currentJson(ctx.db, c.store, c.doc_id);
    const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)));
    if (!same(now, c.after)) throw new ToolError(`That ${c.store === 'kv' ? 'setting' : 'record'} has changed since (in the app or by a later change), so undoing would overwrite that. Undo later changes first, or make the change you want directly.`);
    const res = await save(ctx, 'undo_change', `Undid: ${c.summary}`, [{ store: c.store as Change['store'], id: c.doc_id, value: c.before === null ? null : JSON.parse(c.before) }]);
    await markUndone(ctx.db, c.id);
    return { undone: c.summary, ...res };
  },
};

export const TOOLS: Tool<ToolCtx>[] = [
  getTrainingSummary,
  getCalendar,
  getPlan,
  listActivities,
  getActivity,
  listLibrary,
  getWorkout,
  scheduleWorkout,
  moveWorkout,
  replaceWorkout,
  adjustIntensity,
  setWorkoutStatus,
  setWorkoutNote,
  removeWorkout,
  saveLibraryWorkout,
  createPlan,
  updatePlan,
  updateSettings,
  listChanges,
  undoChange,
];

export const INSTRUCTIONS = `RideBox is the rider's indoor cycling training app: a calendar of structured ERG workouts, a training plan, rides recorded in RideBox and activities imported from Strava.

Act as their coach. Call get_training_summary first in a conversation; it gives today's date in the rider's time zone and the numbers everything else builds on.

Coaching principles (the same ones RideBox's in-app coach follows):
- Progressive overload with recovery: 2-3 build weeks, then a recovery week at about 60% load. Weekly CTL growth about 3-6 points; don't raise weekly TSS more than about 15%.
- Hard days hard, easy days easy: at most 2-3 intensity sessions a week, rarely back to back.
- Progression levels (1-10 per zone): productive workouts are 0 to +1 above the rider's level in that zone; never schedule more than +1.5 above.
- Missed workouts: move the key session if it fits without stacking hard days, otherwise drop the less important one. Don't chase missed volume.
- Struggled or failed workouts: repeat the stimulus a little easier and check recovery.

Making changes:
- Changes save immediately and sync to the rider's browsers. Tell the rider what you changed. Every change can be listed with list_recent_changes and reverted with undo_change.
- Prefer library workouts (list_library) over writing new ones. New workouts use RideBox shorthand (see schedule_workout's text field) and must include a warm-up and cool-down.
- Use get_calendar to find workout ids and to check a day before adding to it. Don't change workouts that are done.
- Confirm with the rider before big changes (rebuilding weeks, a new plan, a new FTP).`;
