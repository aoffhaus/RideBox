import { describe, expect, it } from 'vitest';
import { photoStats } from '../src/ui/photoOverlay';
import { DEFAULT_SETTINGS } from '../src/storage/types';
import type { Snapshot } from '../src/app/session';

const snap = (over: Partial<Snapshot> = {}): Snapshot =>
  ({ power3s: 228, hr: 152, cadence: 91, speed: 10, elapsed: 1834, distance: 18250, ...over }) as Snapshot;

describe('photoStats', () => {
  it('lists the live numbers in the rider’s units', () => {
    const ps = photoStats(snap(), { ...DEFAULT_SETTINGS, ftp: 250, units: 'metric' }, 'Sweet Spot 3x12');
    expect(ps.stats.map((s) => `${s.label} ${s.value} ${s.unit}`.trim())).toEqual([
      'POWER 228 W',
      'HEART RATE 152 bpm',
      'CADENCE 91 rpm',
      'SPEED 36.0 km/h',
      'TIME 30:34',
      'DISTANCE 18.25 km',
    ]);
    expect(ps.stats[0].color).toBeTruthy();
    expect(ps.title).toBe('Sweet Spot 3x12');
    const imp = photoStats(snap(), { ...DEFAULT_SETTINGS, ftp: 250, units: 'imperial' }, 'x');
    expect(imp.stats[3]).toMatchObject({ value: '22.4', unit: 'mph' });
  });

  it('shows the current interval and its target', () => {
    const workout = { finished: false, interval: { label: 'Sweet spot' }, targetWatts: 224.6 } as Snapshot['workout'];
    expect(photoStats(snap({ workout }), { ...DEFAULT_SETTINGS, ftp: 250 }, 'x').subtitle).toBe('Sweet spot · 225 W');
  });

  it('shows dashes without a heart rate strap', () => {
    expect(photoStats(snap({ hr: undefined }), DEFAULT_SETTINGS, 'x').stats[1].value).toBe('--');
  });
});
