import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/types';
import { ftpOn, validFtpHistory, withFtpHistory } from '../src/training/ftp';
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
