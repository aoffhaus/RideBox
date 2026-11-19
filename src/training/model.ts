// Training data: the calendar, plans, and activities imported from Strava.

import type { Workout } from '../workout/model';

/** Local calendar day, "YYYY-MM-DD". */
export type DayKey = string;

export type PlannedStatus = 'planned' | 'done' | 'missed' | 'skipped';
export type PlannedOrigin = 'plan' | 'manual' | 'adapt' | 'recommend';

/** One workout on the calendar (stored in the synced `calendar` store). */
export interface PlannedWorkout {
  id: string;
  date: DayKey;
  workout: Workout;
  status: PlannedStatus;
  origin: PlannedOrigin;
  planId?: string;
  /** plan phase / week focus shown on the card */
  phase?: string;
  /** why the coach put it here */
  rationale?: string;
  note?: string;
  /** the RideBox ride that completed it */
  rideId?: string;
  /** a Strava activity that completed it (outdoor ride, other app) */
  stravaId?: string;
  /** order within the day */
  order?: number;
  createdAt: number;
}

export interface PlanPhase {
  name: string; // Base, Build, Specialty, Taper…
  start: DayKey;
  end: DayKey;
  focus: string;
}

/** A training plan (stored in the synced `plans` store). Its workouts live in the calendar. */
export interface TrainingPlan {
  id: string;
  name: string;
  goal: string;
  eventDate?: DayKey;
  start: DayKey;
  end: DayKey;
  phases: PlanPhase[];
  notes?: string;
  createdAt: number;
  active: boolean;
}

/** An activity imported from Strava (stored in the synced `strava_acts` store). */
export interface StravaActivity {
  id: string; // `strava-<id>`
  stravaId: number;
  name: string;
  sportType: string;
  /** ms since epoch */
  start: number;
  movingTime: number; // s
  distance: number; // m
  climb?: number; // m
  avgWatts?: number;
  weightedWatts?: number;
  /** true when the watts came from a power meter (not Strava's estimate) */
  deviceWatts?: boolean;
  kj?: number;
  avgHr?: number;
  maxHr?: number;
  trainer?: boolean;
}

export const isRide = (sportType: string) => /ride|cycl|bike/i.test(sportType);
