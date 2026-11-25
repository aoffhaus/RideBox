import { describe, expect, it } from 'vitest';
import { statCard } from '../src/ui/statCard';
import { DEFAULT_SETTINGS } from '../src/storage/types';
import type { RideRecord } from '../src/app/recorder';

const ride = (over: Partial<RideRecord> = {}): RideRecord =>
  ({
    id: 'r',
    name: 'Sweet Spot 3x12',
    workoutName: 'Sweet Spot 3x12',
    focus: 'Sweet Spot',
    routeName: 'Rolling Farmland',
    startTime: new Date(2026, 10, 24, 17).getTime(),
    ftp: 250,
    samples: [],
    laps: [],
    summary: { duration: 3725, distance: 33800, avgPower: 201, maxPower: 480, np: 218.4, if: 0.874, tss: 79.2, avgHr: 148, climb: 312, kj: 749 },
    ...over,
  }) as RideRecord;

describe('statCard', () => {
  it('puts the final stats on the card in the rider’s units', () => {
    const c = statCard(ride(), { ...DEFAULT_SETTINGS, units: 'imperial' });
    expect(c.title).toBe('Sweet Spot 3x12');
    expect(c.subtitle).toMatch(/Nov 24 · Sweet Spot$/);
    expect(c.stats.map((s) => `${s.label} ${s.value} ${s.unit}`.trim())).toEqual([
      'TIME 1:02:05',
      'DISTANCE 21.00 mi',
      'AVG POWER 201 W',
      'NORM. POWER 218 W',
      'TSS 79',
      'IF 0.87',
      'AVG HR 148 bpm',
      'CLIMBING 1024 ft',
    ]);
    expect(c.stats[3].color).toBeTruthy();
  });

  it('names the route on a free ride and handles no heart rate', () => {
    const c = statCard(ride({ name: 'Rolling Farmland ride', workoutName: undefined, focus: undefined, summary: { ...ride().summary, avgHr: undefined } }), DEFAULT_SETTINGS);
    expect(c.subtitle).toMatch(/· Tempo · Rolling Farmland$/); // focus from IF 0.874
    expect(c.stats[6]).toMatchObject({ value: '--', unit: '' });
  });
});
