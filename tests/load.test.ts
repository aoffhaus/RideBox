import { describe, expect, it } from 'vitest';
import type { RideRecord } from '../src/app/recorder';
import { addDays, bestAverage, dayKey, daysBetween, estimateFtp, fitnessSeries, loadEntries, stravaTss, weeklyTotals } from '../src/training/load';
import type { StravaActivity } from '../src/training/model';

const ride = (id: string, start: number, tss: number, power: number[] = [], activityId?: number): RideRecord => ({
  id,
  name: id,
  routeName: 'r',
  startTime: start,
  ftp: 250,
  samples: power.map((p, i) => ({ t: start + i * 1000, elapsed: i, power: p, speed: 0, distance: 0, altitude: 0 })),
  laps: [],
  summary: { duration: 3600, distance: 0, avgPower: 0, maxPower: 0, np: 0, if: 0, tss, climb: 0, kj: 0 },
  strava: activityId ? { status: 'done', activityId } : undefined,
});

const act = (over: Partial<StravaActivity>): StravaActivity => ({
  id: 'strava-1',
  stravaId: 1,
  name: 'Outdoor',
  sportType: 'Ride',
  start: new Date(2026, 5, 1, 9).getTime(),
  movingTime: 3600,
  distance: 30000,
  ...over,
});

describe('dates', () => {
  it('adds days across month ends and DST', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('stravaTss', () => {
  it('uses power when a power meter recorded it', () => {
    const r = stravaTss(act({ weightedWatts: 250, deviceWatts: true }), 250, 190);
    expect(r).toEqual({ tss: 100, source: 'power' });
  });
  it('falls back to heart rate, then to duration', () => {
    expect(stravaTss(act({ avgHr: 0.89 * 190 }), 250, 190).tss).toBeCloseTo(100, 5);
    expect(stravaTss(act({ avgHr: 0.89 * 190 }), 250, 190).source).toBe('hr');
    const est = stravaTss(act({}), 250, 190);
    expect(est.source).toBe('estimate');
    expect(est.tss).toBeCloseTo(42.25, 2);
  });
  it("ignores Strava's estimated watts", () => {
    expect(stravaTss(act({ weightedWatts: 300, deviceWatts: false, avgHr: 150 }), 250, 190).source).toBe('hr');
  });
});

describe('loadEntries', () => {
  it('drops Strava copies of RideBox rides', () => {
    const t = new Date(2026, 5, 1, 9).getTime();
    const entries = loadEntries(
      [ride('a', t, 80, [], 77)],
      [act({ id: 'strava-77', stravaId: 77 }), act({ id: 'strava-78', stravaId: 78, start: t + 30_000 }), act({ id: 'strava-79', stravaId: 79, start: t + 86_400_000 })],
      250,
      190,
    );
    expect(entries.map((e) => e.id)).toEqual(['a', 'strava-79']);
  });
});

describe('fitnessSeries', () => {
  it('converges to a steady daily load', () => {
    const entries = Array.from({ length: 400 }, (_, i) => ({ date: addDays('2025-01-01', i), tss: 50, seconds: 3600, kind: 'ridebox' as const, id: String(i), name: '' }));
    const s = fitnessSeries(entries, [], '2025-01-01', addDays('2025-01-01', 399), '2030-01-01');
    const last = s[s.length - 1];
    expect(last.ctl).toBeCloseTo(50, 0);
    expect(last.atl).toBeCloseTo(50, 3);
    expect(Math.abs(last.tsb)).toBeLessThan(0.5);
  });

  it('applies one day of load with the right time constants', () => {
    const s = fitnessSeries([{ date: '2026-01-01', tss: 100, seconds: 0, kind: 'ridebox', id: 'x', name: '' }], [], '2026-01-01', '2026-01-02', '2026-01-10');
    expect(s[0].ctl).toBeCloseTo(100 / 42, 6);
    expect(s[0].atl).toBeCloseTo(100 / 7, 6);
    expect(s[0].tsb).toBe(0); // form is measured going into the day
    expect(s[1].tsb).toBeCloseTo(100 / 42 - 100 / 7, 6);
  });

  it('projects planned TSS after today, and uses it today until a ride is recorded', () => {
    const planned = [
      { date: '2026-01-02', tss: 70 },
      { date: '2026-01-03', tss: 60 },
    ];
    const s = fitnessSeries([], planned, '2026-01-01', '2026-01-03', '2026-01-02');
    expect(s[1].future).toBe(false);
    expect(s[1].ctl).toBeCloseTo(70 / 42, 6);
    expect(s[2].future).toBe(true);
    expect(s[2].planned).toBe(60);
  });
});

describe('weeklyTotals', () => {
  it('buckets by Monday weeks', () => {
    // 2026-06-01 is a Monday
    const e = (date: string, tss: number) => ({ date, tss, seconds: 3600, kind: 'ridebox' as const, id: date, name: '' });
    const w = weeklyTotals([e('2026-06-01', 50), e('2026-06-07', 30), e('2026-06-08', 20)], '2026-06-01', '2026-06-14');
    expect(w).toEqual([
      { week: '2026-06-01', tss: 80, seconds: 7200 },
      { week: '2026-06-08', tss: 20, seconds: 3600 },
    ]);
  });
});

describe('FTP estimate', () => {
  it('finds the best rolling average', () => {
    expect(bestAverage([1, 2, 3, 10, 10, 1], 2)).toBe(10);
    expect(bestAverage([1, 2], 3)).toBe(0);
  });

  it('is 95% of the best 20 minutes in the window', () => {
    const now = new Date(2026, 5, 30).getTime();
    const power = [...Array(600).fill(150), ...Array(1200).fill(300), ...Array(600).fill(150)];
    const est = estimateFtp([ride('recent', now - 10 * 86_400_000, 90, power), ride('old', now - 200 * 86_400_000, 90, Array(1300).fill(400))], 90, now);
    expect(est).toMatchObject({ ftp: 285, best20: 300, rideId: 'recent' });
  });
});

describe('periodTotals', () => {
  it('planned counts every planned workout, done counts everything completed', async () => {
    const { periodTotals } = await import('../src/training/load');
    const w = { name: 'w', steps: [{ type: 'steady', duration: 3600, power: 1, unit: 'ftp' }] } as never;
    const pw = (id: string, date: string, status: 'planned' | 'done' | 'missed' | 'skipped') => ({ id, date, workout: w, status, origin: 'manual', createdAt: 0 }) as never;
    const cal = [pw('a', '2026-06-01', 'done'), pw('b', '2026-06-02', 'missed'), pw('c', '2026-06-03', 'planned'), pw('d', '2026-06-04', 'skipped'), pw('e', '2026-06-09', 'planned')];
    const entries = loadEntries([ride('r1', new Date(2026, 5, 1, 8).getTime(), 80)], [act({ start: new Date(2026, 5, 5, 9).getTime(), weightedWatts: 200, deviceWatts: true })], 250, 190);
    const t = periodTotals(cal, entries, 250, '2026-06-01', '2026-06-07');
    // done, missed, planned and skipped all count as planned; missed + skipped are flagged as skipped
    expect(t.plannedTss).toBeCloseTo(400, 0);
    expect(t.plannedSec).toBe(4 * 3600);
    expect(t.skippedSec).toBe(2 * 3600);
    expect(t.skippedTss).toBeCloseTo(200, 0);
    // planned ride + unplanned Strava ride both count as done
    expect(t.doneSec).toBe(7200);
    expect(t.doneTss).toBeGreaterThan(80);
  });
});
