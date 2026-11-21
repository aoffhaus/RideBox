import { describe, expect, it, vi } from 'vitest';
import { RideSession } from '../src/app/session';
import { DEFAULT_SETTINGS } from '../src/storage/db';
import { parseText } from '../src/workout/parsers';
import type { Trainer, TrainerSample } from '../src/ble/types';

function fakeTrainer() {
  const t: Trainer & { push(p: number): void } = {
    kind: 'simulated',
    name: 'fake',
    canControl: true,
    onData: undefined as ((s: TrainerSample) => void) | undefined,
    async setTargetPower() {},
    async setGrade() {},
    disconnect() {},
    push(p: number) {
      this.onData?.({ power: p, cadence: 90 });
    },
  };
  return t;
}

describe('mini map projections', () => {
  it('next interval marker = arch position; markers ordered; rider reaches it when interval ends', () => {
    const trainer = fakeTrainer();
    const s = new RideSession({
      trainer,
      settings: DEFAULT_SETTINGS,
      workout: parseText('1m @60%\n30s @120%\n1m @50%'),
      routePreset: 'rolling',
    });
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      trainer.push(200);
      s.tick(0.1);
      const snap = s.snapshot();
      if (snap.workout && !snap.workout.finished && snap.upcoming.length) {
        expect(snap.upcoming[0].distance).toBeCloseTo(snap.archDistance!, 6);
        expect(snap.upcoming[0].startsIn).toBeCloseTo(snap.workout.remaining, 6);
        for (let k = 1; k < snap.upcoming.length; k++) {
          expect(snap.upcoming[k].distance).toBeGreaterThanOrEqual(snap.upcoming[k - 1].distance);
          expect(snap.upcoming[k].index).toBe(snap.upcoming[k - 1].index + 1);
        }
        if (snap.workout.remaining < 0.15) expect(snap.upcoming[0].distance - snap.distance).toBeLessThan(2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(s.snapshot().workout?.finished).toBe(true);
    expect(s.snapshot().upcoming).toEqual([]);
  });
});

describe('ride draft (crash recovery)', () => {
  it('snapshots the ride without stopping it and keeps the same id as the finished ride', () => {
    const trainer = fakeTrainer();
    const s = new RideSession({ trainer, settings: DEFAULT_SETTINGS, workout: parseText('1m @60%\n1m @80%'), routePreset: 'rolling' });
    for (let i = 0; i < 400; i++) {
      trainer.push(180);
      s.tick(0.1);
    }
    const draft = s.draftRecord();
    const n = draft.samples.length;
    expect(n).toBeGreaterThan(30);
    // the open interval shows up as a lap, and drafting doesn't close it for real
    expect(draft.laps.at(-1)?.endIndex).toBe(draft.samples.length);
    expect(s.laps.length).toBeLessThan(draft.laps.length + 1);
    for (let i = 0; i < 100; i++) {
      trainer.push(180);
      s.tick(0.1);
    }
    expect(s.samples.length).toBeGreaterThan(n);
    vi.stubGlobal('window', { clearInterval() {} });
    expect(s.finish().id).toBe(draft.id);
    vi.unstubAllGlobals();
  });
});
