// Training load: TSS per day, fitness (CTL), fatigue (ATL), form (TSB), and an
// FTP estimate. Standard Banister/Coggan impulse-response model:
//   CTL_t = CTL_{t-1} + (TSS_t − CTL_{t-1}) / 42     (fitness)
//   ATL_t = ATL_{t-1} + (TSS_t − ATL_{t-1}) / 7      (fatigue)
//   TSB_t = CTL_{t-1} − ATL_{t-1}                    (form, going into day t)

import type { RideRecord } from '../app/recorder';
import { flatten, plannedStats } from '../workout/model';
import { isRide, type DayKey, type PlannedWorkout, type StravaActivity } from './model';

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

const pad = (n: number) => String(n).padStart(2, '0');
export function dayKey(t: number | Date): DayKey {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Local midnight of a day key. */
export function dayStart(k: DayKey): Date {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(k: DayKey, n: number): DayKey {
  const d = dayStart(k);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
export function daysBetween(a: DayKey, b: DayKey): number {
  return Math.round((dayStart(b).getTime() - dayStart(a).getTime()) / 86_400_000);
}
export const today = () => dayKey(Date.now());

export type TssSource = 'power' | 'hr' | 'estimate';

/** TSS for a Strava activity: power if it has a power meter, else heart rate, else a duration estimate. */
export function stravaTss(a: StravaActivity, ftp: number, maxHr: number): { tss: number; source: TssSource } {
  const hours = a.movingTime / 3600;
  const np = a.weightedWatts ?? (a.deviceWatts ? a.avgWatts : undefined);
  if (np && a.deviceWatts !== false && ftp > 0) {
    const IF = np / ftp;
    return { tss: hours * IF * IF * 100, source: 'power' };
  }
  if (a.avgHr && maxHr > 0) {
    // hrTSS: intensity relative to lactate threshold HR (≈ 89% of max)
    const IF = Math.min(1.2, a.avgHr / (0.89 * maxHr));
    return { tss: hours * IF * IF * 100, source: 'hr' };
  }
  // no power or HR: assume endurance pace (IF ≈ 0.65 riding, 0.55 other sports)
  const IF = isRide(a.sportType) ? 0.65 : 0.55;
  return { tss: hours * IF * IF * 100, source: 'estimate' };
}

export interface LoadEntry {
  date: DayKey;
  tss: number;
  seconds: number;
  kind: 'ridebox' | 'strava';
  id: string;
  name: string;
  source?: TssSource;
}

/**
 * Every completed activity as a load entry. Strava copies of RideBox rides (the
 * ones RideBox uploaded, or anything starting within 2 minutes of one) are dropped
 * so the same ride never counts twice.
 */
export function loadEntries(rides: RideRecord[], acts: StravaActivity[], ftp: number, maxHr: number): LoadEntry[] {
  const out: LoadEntry[] = [];
  const uploaded = new Set<number>();
  const starts: number[] = [];
  for (const r of rides) {
    if (r.strava?.activityId) uploaded.add(r.strava.activityId);
    starts.push(r.startTime);
    out.push({ date: dayKey(r.startTime), tss: r.summary.tss, seconds: r.summary.duration, kind: 'ridebox', id: r.id, name: r.name, source: 'power' });
  }
  for (const a of acts) {
    if (uploaded.has(a.stravaId)) continue;
    if (starts.some((s) => Math.abs(s - a.start) < 120_000)) continue;
    const { tss, source } = stravaTss(a, ftp, maxHr);
    out.push({ date: dayKey(a.start), tss, seconds: a.movingTime, kind: 'strava', id: a.id, name: a.name, source });
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

export interface FitnessDay {
  date: DayKey;
  tss: number;
  /** planned TSS on future days (projection) */
  planned: number;
  ctl: number;
  atl: number;
  tsb: number;
  future: boolean;
}

/**
 * Day-by-day fitness from `from` to `to` (inclusive). Days after `todayKey` use
 * planned TSS so the curve shows where the plan takes you. History before `from`
 * warms the model up, so start the series well before the window you show.
 */
export function fitnessSeries(
  entries: LoadEntry[],
  planned: { date: DayKey; tss: number }[],
  from: DayKey,
  to: DayKey,
  todayKey: DayKey = today(),
): FitnessDay[] {
  const done = new Map<DayKey, number>();
  for (const e of entries) done.set(e.date, (done.get(e.date) ?? 0) + e.tss);
  const plan = new Map<DayKey, number>();
  for (const p of planned) plan.set(p.date, (plan.get(p.date) ?? 0) + p.tss);
  const out: FitnessDay[] = [];
  let ctl = 0;
  let atl = 0;
  for (let k = from, n = 0; k <= to && n < 5000; k = addDays(k, 1), n++) {
    const future = k > todayKey;
    const actual = done.get(k) ?? 0;
    // today counts what's done, or what's planned if nothing is recorded yet
    const p = plan.get(k) ?? 0;
    const tss = future ? p : k === todayKey && actual === 0 ? p : actual;
    const tsb = ctl - atl;
    ctl += (tss - ctl) / CTL_DAYS;
    atl += (tss - atl) / ATL_DAYS;
    out.push({ date: k, tss: future ? 0 : actual, planned: p, ctl, atl, tsb, future });
  }
  return out;
}

/** Planned TSS of calendar workouts that haven't happened yet. */
export function plannedLoad(cal: PlannedWorkout[], ftp: number): { date: DayKey; tss: number }[] {
  return cal.filter((p) => p.status === 'planned').map((p) => ({ date: p.date, tss: plannedStats(flatten(p.workout), ftp).tss }));
}

/** Weekly totals (weeks start Monday). */
export function weeklyTotals(entries: LoadEntry[], from: DayKey, to: DayKey): { week: DayKey; tss: number; seconds: number }[] {
  const weeks = new Map<DayKey, { tss: number; seconds: number }>();
  const monday = (k: DayKey) => addDays(k, -((dayStart(k).getDay() + 6) % 7));
  for (let w = monday(from); w <= to; w = addDays(w, 7)) weeks.set(w, { tss: 0, seconds: 0 });
  for (const e of entries) {
    if (e.date < from || e.date > to) continue;
    const t = weeks.get(monday(e.date));
    if (t) {
      t.tss += e.tss;
      t.seconds += e.seconds;
    }
  }
  return [...weeks].map(([week, t]) => ({ week, ...t }));
}

/** Highest average power over any `window`-second stretch of a 1 Hz power series. */
export function bestAverage(power: number[], window: number): number {
  if (power.length < window) return 0;
  let sum = 0;
  for (let i = 0; i < window; i++) sum += power[i];
  let best = sum;
  for (let i = window; i < power.length; i++) {
    sum += power[i] - power[i - window];
    if (sum > best) best = sum;
  }
  return best / window;
}

export interface FtpEstimate {
  ftp: number;
  best20: number;
  rideId: string;
  date: DayKey;
}

/** FTP ≈ 95% of the best 20-minute power in the last `days` days of RideBox rides. */
export function estimateFtp(rides: RideRecord[], days = 90, now = Date.now()): FtpEstimate | null {
  let best: FtpEstimate | null = null;
  for (const r of rides) {
    if (now - r.startTime > days * 86_400_000) continue;
    const b = bestAverage(
      r.samples.map((s) => s.power),
      1200,
    );
    if (b > 0 && (!best || b > best.best20)) best = { ftp: Math.round(b * 0.95), best20: Math.round(b), rideId: r.id, date: dayKey(r.startTime) };
  }
  return best;
}

/** Plain-language read of form (TSB). */
export function formLabel(tsb: number): string {
  if (tsb > 25) return 'Very fresh (losing fitness)';
  if (tsb > 5) return 'Fresh';
  if (tsb > -10) return 'Neutral';
  if (tsb > -30) return 'Productive fatigue';
  return 'Overreaching';
}
