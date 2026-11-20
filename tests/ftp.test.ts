import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/types';
import { ftpOn, logFtp, logWeight, removeFtp, removeWeight, validFtpHistory, weightOn, withFtpHistory, withRiderHistory } from '../src/training/ftp';
import { computeLevels, rateWorkout } from '../src/training/levels';
import { parseText } from '../src/workout/parsers';
import { flatten, plannedStats } from '../src/workout/model';

const s = (ftp: number, ftpHistory?: { from: string; ftp: number }[]) => ({ ...DEFAULT_SETTINGS, ftp, ftpHistory });

describe('FTP history', () => {
  it('looks up the FTP of a day, with the current setting from the last change on', () => {
    const st = s(255, [{ from: '2026-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 252 }]);
    expect(ftpOn(st, '2026-10-24')).toBe(233);
    expect(ftpOn(st, '2026-11-09')).toBe(233);
    expect(ftpOn(st, '2026-11-10')).toBe(255); // last entry: the current setting wins
    expect(ftpOn(st, '2025-06-01')).toBe(233); // before the first entry
    expect(ftpOn(s(240), '2026-01-01')).toBe(240); // no history
  });

  it('records changes, keeping the old FTP as the one before the first change', () => {
    const a = withFtpHistory(s(233), s(252), '2026-11-10');
    expect(a.ftpHistory).toEqual([{ from: '0000-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 252 }]);
    expect(ftpOn(a, '2026-11-01')).toBe(233);
    const b = withFtpHistory(a, { ...a, ftp: 255 }, '2026-11-10'); // same day: replaces
    expect(b.ftpHistory).toEqual([{ from: '0000-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 255 }]);
    expect(withFtpHistory(a, { ...a, riderKg: 70 }, '2026-11-12').ftpHistory).toBe(a.ftpHistory); // no FTP change
  });

  it('logs a dated FTP: the newest entry becomes current, an earlier date only fills in history', () => {
    const base = s(255, [{ from: '2026-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 252 }, { from: '2026-11-19', ftp: 255 }]);
    const now = logFtp(base, '2026-11-20', 262);
    expect(now.ftp).toBe(262);
    expect(now.ftpHistory!.at(-1)).toEqual({ from: '2026-11-20', ftp: 262 });
    const past = logFtp(base, '2026-09-01', 225);
    expect(past.ftp).toBe(255);
    expect(ftpOn(past, '2026-09-15')).toBe(225);
    expect(ftpOn(past, '2026-08-01')).toBe(233);
    // into an empty history: the current FTP becomes the earlier one, and the log is the newest
    const fresh = logFtp(s(200), '2026-11-19', 255);
    expect(fresh.ftp).toBe(255);
    expect(ftpOn(fresh, '2026-11-01')).toBe(200);
    expect(fresh.ftpHistory).toEqual([{ from: '0000-01-01', ftp: 200 }, { from: '2026-11-19', ftp: 255 }]);
  });

  it('removes a logged FTP, making the one before current when it was the latest', () => {
    const base = s(255, [{ from: '2026-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 252 }, { from: '2026-11-19', ftp: 255 }]);
    const r = removeFtp(base, '2026-11-19');
    expect(r.ftp).toBe(252);
    expect(r.ftpHistory).toHaveLength(2);
    expect(removeFtp(base, '2026-01-01').ftp).toBe(255);
  });

  it('keeps a weight history the same way, and saving settings records FTP and weight changes', () => {
    const base = { ...s(255), riderKg: 80 };
    const w = logWeight(base, '2026-11-20', 79.37);
    expect(w.riderKg).toBe(79.4);
    expect(weightOn(w, '2026-11-20')).toBe(79.4);
    const back = logWeight(w, '2026-10-01', 82);
    expect(back.riderKg).toBe(79.4);
    expect(weightOn(back, '2026-10-15')).toBe(82);
    expect(removeWeight(back, '2026-11-20').riderKg).toBe(82);
    const saved = withRiderHistory(base, { ...base, ftp: 260, riderKg: 78 }, '2026-11-21');
    expect(saved.ftpHistory!.at(-1)).toEqual({ from: '2026-11-21', ftp: 260 });
    expect(saved.weightHistory!.at(-1)).toEqual({ from: '2026-11-21', kg: 78 });
    // a dated log already set the history: saving leaves it alone
    const logged = logFtp(base, '2026-11-18', 258);
    expect(withRiderHistory(base, logged, '2026-11-21').ftpHistory).toBe(logged.ftpHistory);
    // lb rounding noise isn't a weight change
    expect(withRiderHistory(base, { ...base, riderKg: 80.01 }, '2026-11-21').weightHistory).toBeUndefined();
  });

  it('validates a history given by the rider', () => {
    expect(validFtpHistory([{ from: '2026-11-10', ftp: 252 }, { from: '2026-01-01', ftp: 233 }])).toEqual([{ from: '2026-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 252 }]);
    expect(typeof validFtpHistory([{ from: '11/10', ftp: 252 }])).toBe('string');
    expect(typeof validFtpHistory([{ from: '2026-11-10', ftp: 20 }])).toBe('string');
    expect(typeof validFtpHistory([])).toBe('string');
  });

  it('judges a Strava ride at the FTP of its day', () => {
    const w = parseText('# Eichorn +1\n10m 50%\n2x(20m 85%, 5m 40%)\n5m 40%');
    const np = (ftp: number) => plannedStats(flatten(w), ftp).np; // steady blocks: smoothing hardly matters
    const act = { id: 'strava-1', stravaId: 1, name: 'Eichorn +1', sportType: 'Ride', start: Date.UTC(2026, 9, 22, 19), movingTime: plannedStats(flatten(w), 233).duration, distance: 0, weightedWatts: np(233), deviceWatts: true };
    const now = Date.UTC(2026, 10, 20);
    const atCurrent = computeLevels([], [act], [], [w], 255, now);
    expect(atCurrent.history[0].outcome).toBe('struggle'); // 233 W of work judged at 255 is 91% of plan
    const st = s(255, [{ from: '2026-01-01', ftp: 233 }, { from: '2026-11-10', ftp: 252 }]);
    const atTheTime = computeLevels([], [act], [], [w], 255, now, (t) => ftpOn(st, new Date(t).toISOString().slice(0, 10)));
    expect(atTheTime.history[0].outcome).toBe('pass');
    expect(atTheTime.levels.tempo).toBeCloseTo(rateWorkout(w, 233).level, 5);
  });
});
