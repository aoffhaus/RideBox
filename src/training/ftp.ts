// FTP over time. RideBox rides save the FTP they were ridden at; rides from other
// apps (imported from Strava) don't, so they are judged at the FTP that was in
// effect on their day, from the settings' FTP history.

import type { FtpChange, Settings } from '../storage/types';
import type { DayKey } from './model';

const BEGINNING = '0000-01-01';

/**
 * The settings with `next.ftp` recorded in the history when it differs from
 * `prev.ftp`. The first change also records the old FTP as the one in effect
 * before it. A second change on the same day replaces the first.
 */
export function withFtpHistory(prev: Settings, next: Settings, day: DayKey): Settings {
  if (next.ftp === prev.ftp) return next;
  const base = prev.ftpHistory?.length ? prev.ftpHistory : [{ from: BEGINNING, ftp: prev.ftp }];
  const history = [...base.filter((c) => c.from !== day), { from: day, ftp: next.ftp }].sort((a, b) => (a.from < b.from ? -1 : 1));
  return { ...next, ftpHistory: history };
}

/**
 * The FTP in effect on a day: the latest history entry on or before it. The
 * current setting always applies from the last change on (so a stale history
 * can never override it), and before the first entry the first entry applies.
 */
export function ftpOn(settings: Pick<Settings, 'ftp' | 'ftpHistory'>, day: DayKey): number {
  const h = [...(settings.ftpHistory ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1));
  if (!h.length) return settings.ftp;
  let i = -1;
  for (let k = 0; k < h.length; k++) if (h[k].from <= day) i = k;
  if (i === h.length - 1) return settings.ftp;
  return h[Math.max(0, i)].ftp;
}

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
