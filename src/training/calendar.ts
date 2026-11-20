// Calendar logic: matching completed rides to planned workouts, missed days,
// moving and copying, and easier/harder variants.

import type { RideRecord } from '../app/recorder';
import { uid } from '../storage/types';
import type { Step, Workout } from '../workout/model';
import { addDays, dayKey, dayStart, stravaCopyChecker } from './load';
import { isRide, type DayKey, type PlannedWorkout, type StravaActivity } from './model';

/** Monday of the week containing `k`. */
export const weekStart = (k: DayKey) => addDays(k, -((dayStart(k).getDay() + 6) % 7));

/** The weeks (Monday keys) a month view shows: every week touching the month. */
export function monthWeeks(year: number, month: number): DayKey[] {
  const first = dayKey(new Date(year, month, 1));
  const last = dayKey(new Date(year, month + 1, 0));
  const out: DayKey[] = [];
  for (let w = weekStart(first); w <= last; w = addDays(w, 7)) out.push(w);
  return out;
}

/**
 * Links finished activities to the planned workouts on their day and marks
 * unridden past workouts missed. Returns only the items that changed.
 * RideBox rides are matched first (by workout name when possible), then Strava
 * rides that were at least a third as long as planned.
 */
export function reconcile(
  cal: PlannedWorkout[],
  rides: RideRecord[],
  acts: StravaActivity[],
  plannedSeconds: (p: PlannedWorkout) => number,
  todayKey: DayKey,
): PlannedWorkout[] {
  const usedRides = new Set(cal.map((p) => p.rideId).filter(Boolean));
  const usedActs = new Set(cal.map((p) => p.stravaId).filter(Boolean));
  const isCopy = stravaCopyChecker(rides);
  const changed: PlannedWorkout[] = [];
  const open = cal
    .filter((p) => (p.status === 'planned' || p.status === 'missed') && p.date <= todayKey)
    .sort((a, b) => (a.date === b.date ? (a.order ?? 0) - (b.order ?? 0) : a.date < b.date ? -1 : 1));

  const done = new Set<string>();
  // pass 1: rides recorded from a workout with the same name
  for (const p of open) {
    const ride = rides.find((r) => dayKey(r.startTime) === p.date && !usedRides.has(r.id) && r.workoutName === p.workout.name);
    if (ride) {
      usedRides.add(ride.id);
      done.add(p.id);
      changed.push({ ...p, status: 'done', rideId: ride.id });
    }
  }
  // pass 2: any other ride that day, then long-enough Strava rides; otherwise missed
  for (const p of open) {
    if (done.has(p.id)) continue;
    const ride = rides.find((r) => dayKey(r.startTime) === p.date && !usedRides.has(r.id));
    if (ride) {
      usedRides.add(ride.id);
      changed.push({ ...p, status: 'done', rideId: ride.id });
      continue;
    }
    const act = acts.find(
      (a) =>
        dayKey(a.start) === p.date &&
        isRide(a.sportType) &&
        !usedActs.has(a.id) &&
        !isCopy(a) &&
        a.movingTime >= plannedSeconds(p) / 3,
    );
    if (act) {
      usedActs.add(act.id);
      changed.push({ ...p, status: 'done', stravaId: act.id });
      continue;
    }
    if (p.date < todayKey && p.status === 'planned') changed.push({ ...p, status: 'missed' });
  }
  return changed;
}

/** Moves a workout to another day (at the end of that day's list). Done workouts keep their link. */
export function moveTo(p: PlannedWorkout, date: DayKey, cal: PlannedWorkout[], todayKey: DayKey): PlannedWorkout {
  const order = Math.max(-1, ...cal.filter((x) => x.date === date && x.id !== p.id).map((x) => x.order ?? 0)) + 1;
  // a missed workout moved to today or later is back on the plan
  const status = p.status === 'missed' && date >= todayKey ? 'planned' : p.status;
  return { ...p, date, order, status };
}

export function copyTo(p: PlannedWorkout, date: DayKey, cal: PlannedWorkout[]): PlannedWorkout {
  const order = Math.max(-1, ...cal.filter((x) => x.date === date).map((x) => x.order ?? 0)) + 1;
  return { ...p, id: uid(), date, order, status: 'planned', rideId: undefined, stravaId: undefined, createdAt: Date.now(), origin: 'manual' };
}

export function newPlanned(workout: Workout, date: DayKey, cal: PlannedWorkout[], extra: Partial<PlannedWorkout> = {}): PlannedWorkout {
  const order = Math.max(-1, ...cal.filter((x) => x.date === date).map((x) => x.order ?? 0)) + 1;
  return { id: uid(), date, workout, status: 'planned', origin: 'manual', order, createdAt: Date.now(), ...extra };
}

/** Scales every work interval's target (not the easy ones) by `factor`, e.g. 0.95 for an easier version. */
export function scaleWorkout(w: Workout, factor: number): Workout {
  const easy = 0.6; // leave warm-ups, recoveries and cool-downs alone
  const scale = (v: number, unit?: 'ftp' | 'watts') => {
    const frac = unit === 'watts' ? 1 : v;
    if (unit !== 'watts' && frac < easy) return v;
    return unit === 'watts' ? Math.round(v * factor) : Math.round(v * factor * 1000) / 1000;
  };
  const walk = (steps: Step[]): Step[] =>
    steps.map((s) => {
      if (s.type === 'repeat') return { ...s, steps: walk(s.steps) };
      if (s.type === 'steady') return { ...s, power: scale(s.power, s.unit) };
      if (s.type === 'ramp') return { ...s, from: scale(s.from, s.unit), to: scale(s.to, s.unit) };
      return s;
    });
  const base = w.name.replace(/ \((easier|harder)\)$/, '');
  const name = factor < 1 ? `${base} (easier)` : factor > 1 ? `${base} (harder)` : base;
  return { ...w, name, steps: walk(w.steps) };
}
