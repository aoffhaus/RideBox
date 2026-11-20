// FTP and weight over time. RideBox rides save the FTP they were ridden at; rides
// from other apps (imported from Strava) don't, so they are judged at the FTP that
// was in effect on their day, from the settings' FTP history. Weight has a history
// too, for W/kg over time.

import type { FtpChange, Settings, WeightChange } from '../storage/types';
import type { DayKey } from './model';

const BEGINNING = '0000-01-01';

/** One value that took effect on a day (FTP in W, weight in kg). */
interface Entry {
  from: DayKey;
  v: number;
}
const byDate = (a: Entry, b: Entry) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0);

const ftpEntries = (s: Pick<Settings, 'ftpHistory'>): Entry[] => (s.ftpHistory ?? []).map((c) => ({ from: c.from, v: c.ftp })).sort(byDate);
const weightEntries = (s: Pick<Settings, 'weightHistory'>): Entry[] => (s.weightHistory ?? []).map((c) => ({ from: c.from, v: c.kg })).sort(byDate);
const toFtp = (h: Entry[]): FtpChange[] => h.map((e) => ({ from: e.from, ftp: e.v }));
const toWeight = (h: Entry[]): WeightChange[] => h.map((e) => ({ from: e.from, kg: e.v }));
const sameKg = (a: number, b: number) => Math.abs(a - b) < 0.05;

/** History after the value changed from `prev` to `next` today. The first change also records `prev` as the earlier value. */
function recordChange(h: Entry[], prev: number, next: number, day: DayKey): Entry[] {
  const base = h.length ? h : [{ from: BEGINNING, v: prev }];
  return [...base.filter((e) => e.from !== day), { from: day, v: next }].sort(byDate);
}

/**
 * History with a value logged on a day (replacing one on the same day), and
 * whether it is now the current value: the newest entry always is. Logging into
 * an empty history first records the current value as the earlier one.
 */
function logEntry(h: Entry[], current: number, entry: Entry): { history: Entry[]; isCurrent: boolean } {
  const base = h.length ? h : [{ from: BEGINNING, v: current }];
  const history = [...base.filter((e) => e.from !== entry.from), entry].sort(byDate);
  return { history, isCurrent: history[history.length - 1].from === entry.from };
}

/** Value on a day: the latest entry on or before it, the current value from the last entry on, the first entry before any. */
function valueOn(h: Entry[], current: number, day: DayKey): number {
  if (!h.length) return current;
  let i = -1;
  for (let k = 0; k < h.length; k++) if (h[k].from <= day) i = k;
  if (i === h.length - 1) return current;
  return h[Math.max(0, i)].v;
}

/**
 * The settings with `next.ftp` recorded in the history when it differs from
 * `prev.ftp`. The first change also records the old FTP as the one in effect
 * before it. A second change on the same day replaces the first. If the caller
 * already changed the history (logging a dated FTP), it is left as it is.
 */
export function withFtpHistory(prev: Settings, next: Settings, day: DayKey): Settings {
  if (next.ftp === prev.ftp || next.ftpHistory !== prev.ftpHistory) return next;
  return { ...next, ftpHistory: toFtp(recordChange(ftpEntries(prev), prev.ftp, next.ftp, day)) };
}

/** Same as withFtpHistory, for the rider's weight. */
export function withWeightHistory(prev: Settings, next: Settings, day: DayKey): Settings {
  if (sameKg(next.riderKg, prev.riderKg) || next.weightHistory !== prev.weightHistory) return next;
  return { ...next, weightHistory: toWeight(recordChange(weightEntries(prev), prev.riderKg, next.riderKg, day)) };
}

/** Records FTP and weight changes (for saving settings). */
export const withRiderHistory = (prev: Settings, next: Settings, day: DayKey) => withWeightHistory(prev, withFtpHistory(prev, next, day), day);

/** Logs an FTP that took effect on a day. The newest entry is the current FTP, so a log dated after every other one becomes it. */
export function logFtp(s: Settings, from: DayKey, ftp: number): Settings {
  const { history, isCurrent } = logEntry(ftpEntries(s), s.ftp, { from, v: Math.round(ftp) });
  return { ...s, ftpHistory: toFtp(history), ftp: isCurrent ? Math.round(ftp) : s.ftp };
}

/** Logs a weight (kg) on a day. The newest entry is the current weight. */
export function logWeight(s: Settings, from: DayKey, kg: number): Settings {
  const v = Math.round(kg * 10) / 10;
  const { history, isCurrent } = logEntry(weightEntries(s), s.riderKg, { from, v });
  return { ...s, weightHistory: toWeight(history), riderKg: isCurrent ? v : s.riderKg };
}

/** Removes the FTP logged on a day. Removing the latest makes the one before it current. */
export function removeFtp(s: Settings, from: DayKey): Settings {
  const h = ftpEntries(s).filter((e) => e.from !== from);
  const last = h[h.length - 1];
  return { ...s, ftpHistory: toFtp(h), ftp: last ? last.v : s.ftp };
}

/** Removes the weight logged on a day. Removing the latest makes the one before it current. */
export function removeWeight(s: Settings, from: DayKey): Settings {
  const h = weightEntries(s).filter((e) => e.from !== from);
  const last = h[h.length - 1];
  return { ...s, weightHistory: toWeight(h), riderKg: last ? last.v : s.riderKg };
}

/**
 * The FTP in effect on a day: the latest history entry on or before it. The
 * current setting always applies from the last change on (so a stale history
 * can never override it), and before the first entry the first entry applies.
 */
export const ftpOn = (s: Pick<Settings, 'ftp' | 'ftpHistory'>, day: DayKey) => valueOn(ftpEntries(s), s.ftp, day);

/** The rider's weight (kg) on a day, by the same rules as ftpOn. */
export const weightOn = (s: Pick<Settings, 'riderKg' | 'weightHistory'>, day: DayKey) => valueOn(weightEntries(s), s.riderKg, day);

/** True for the placeholder date the first recorded change gives the value before it. */
export const isBeginning = (day: DayKey) => day === BEGINNING;

/** Checks an FTP history given by the rider (dates in order, sensible watts). */
export function validFtpHistory(h: unknown): FtpChange[] | string {
  if (!Array.isArray(h) || !h.length) return 'ftp_history needs at least one {from, ftp} entry.';
  const out: FtpChange[] = [];
  for (const c of h) {
    const from = (c as FtpChange)?.from;
    const ftp = Number((c as FtpChange)?.ftp);
    if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return `Bad date in ftp_history: ${JSON.stringify(from)} (use YYYY-MM-DD).`;
    if (!Number.isFinite(ftp) || ftp < 50 || ftp > 600) return `Bad FTP in ftp_history: ${JSON.stringify((c as FtpChange)?.ftp)}.`;
    out.push({ from, ftp: Math.round(ftp) });
  }
  out.sort((a, b) => (a.from < b.from ? -1 : 1));
  if (new Set(out.map((c) => c.from)).size !== out.length) return 'ftp_history has two entries on the same date.';
  return out;
}
