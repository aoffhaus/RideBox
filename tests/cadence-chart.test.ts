import { describe, expect, it } from 'vitest';
import { cadencePath } from '../src/ui/WorkoutChart';

const id = (v: number) => v;

describe('cadencePath', () => {
  it('returns empty for no samples or no cadence data', () => {
    expect(cadencePath([], id, id)).toBe('');
    expect(cadencePath([{}, { cadence: 0 }, { cadence: undefined }], id, id)).toBe('');
  });

  it('breaks the line on missing cadence instead of dropping to zero', () => {
    const d = cadencePath([{ cadence: 90 }, { cadence: 92 }, { cadence: 0 }, {}, { cadence: 85 }], id, id);
    expect(d).toBe('M0.0,90.0L1.0,92.0M4.0,85.0');
  });

  it('downsamples long histories', () => {
    const samples = Array.from({ length: 20000 }, () => ({ cadence: 90 }));
    const d = cadencePath(samples, id, id, 1000);
    expect((d.match(/[ML]/g) ?? []).length).toBeLessThanOrEqual(1000);
    expect(d.startsWith('M')).toBe(true);
  });
});
