import { describe, expect, it } from 'vitest';
import { EffortMeter } from '../src/world/effort';

const FTP = 250;
/** Ride `seconds` at `pct` of FTP in 0.1 s steps. */
function ride(m: EffortMeter, pct: number, seconds: number) {
  for (let t = 0; t < seconds; t += 0.1) m.update(0.1, FTP * pct, FTP);
  return m.state;
}

describe('EffortMeter', () => {
  it('ignores endurance riding (Z2) however long it lasts', () => {
    const s = ride(new EffortMeter(), 0.7, 3600);
    expect(s.build).toBe(0);
    expect(s.surge).toBe(0);
  });

  it('builds slowly over a long Z3 block', () => {
    const m = new EffortMeter();
    const after1 = ride(m, 0.82, 60).build;
    const after10 = ride(m, 0.82, 540).build;
    expect(after1).toBeLessThan(0.1); // barely noticeable after a minute
    expect(after10).toBeGreaterThan(0.25); // clearly there after ten
    expect(after10).toBeLessThan(0.45); // but tempo never maxes it out
  });

  it('builds much faster at threshold than at tempo', () => {
    const tempo = ride(new EffortMeter(), 0.8, 120).build;
    const thr = ride(new EffortMeter(), 1.02, 120).build;
    expect(thr).toBeGreaterThan(tempo * 3);
  });

  it('feels a sprint almost immediately and lets it fade after', () => {
    const m = new EffortMeter();
    ride(m, 0.6, 30);
    const s = ride(m, 2.0, 1); // one second of sprinting
    expect(s.surge).toBeGreaterThan(0.85);
    expect(s.level).toBeGreaterThan(0.85);
    const later = ride(m, 0.5, 8);
    expect(later.surge).toBeLessThan(0.15);
  });

  it('relaxes gradually after a hard effort instead of snapping back', () => {
    const m = new EffortMeter();
    ride(m, 1.1, 300);
    const peak = m.build;
    const after5 = ride(m, 0.5, 5).build;
    const after90 = ride(m, 0.5, 85).build;
    expect(after5).toBeGreaterThan(peak * 0.75);
    expect(after90).toBeLessThan(peak * 0.1);
  });

  it('handles zero FTP and stopped pedalling', () => {
    const m = new EffortMeter();
    expect(() => m.update(0.1, 300, 0)).not.toThrow();
    expect(ride(m, 0, 10).level).toBe(0);
  });
});
