import { describe, expect, it } from 'vitest';
import { RideSession, pickPortalJump } from '../src/app/session';
import { DEFAULT_SETTINGS } from '../src/storage/db';
import { parseText } from '../src/workout/parsers';
import { ROUTE_PRESETS, rng } from '../src/world/route';
import type { Trainer, TrainerSample } from '../src/ble/types';

function fakeTrainer() {
  const calls: string[] = [];
  const t: Trainer & { push(p: number): void; calls: string[] } = {
    kind: 'simulated',
    name: 'fake',
    canControl: true,
    calls,
    onData: undefined as ((s: TrainerSample) => void) | undefined,
    async setTargetPower(w: number) {
      calls.push(`erg ${w}`);
    },
    async setGrade(g: number) {
      calls.push(`grade ${g}`);
    },
    disconnect() {},
    push(p: number) {
      this.onData?.({ power: p, cadence: 90 });
    },
  };
  return t;
}

const WORKOUT = '1m @60%\n30s @120%\n45s @50%\n30s @110%';

function ride(opts: { portalSeed?: number; erg?: boolean } = {}) {
  const trainer = fakeTrainer();
  const s = new RideSession({ trainer, settings: DEFAULT_SETTINGS, workout: parseText(WORKOUT), routePreset: 'rolling', portalSeed: opts.portalSeed });
  if (opts.erg === false) s.toggleErg();
  return { s, trainer };
}

describe('portal runs', () => {
  it('jumps to a different world at every interval gate except the finish', () => {
    const { s, trainer } = ride({ portalSeed: 42 });
    const epochs: number[] = [];
    const presets = [s.route.preset.id];
    let lastDist = 0;
    let alt = s.snapshot().altitude;
    for (let i = 0; i < 2000; i++) {
      trainer.push(200);
      const before = s.routeEpoch;
      s.tick(0.1);
      const snap = s.snapshot();
      // the odometer never jumps
      expect(snap.distance).toBeGreaterThanOrEqual(lastDist);
      expect(snap.distance - lastDist).toBeLessThan(5);
      lastDist = snap.distance;
      // nor does the recorded altitude
      expect(Math.abs(snap.altitude - alt)).toBeLessThan(1);
      alt = snap.altitude;
      if (s.routeEpoch !== before) {
        epochs.push(snap.workout!.index);
        expect(s.route.preset.id).not.toBe(presets[presets.length - 1]);
        presets.push(s.route.preset.id);
        expect(snap.routeDistance).toBeGreaterThanOrEqual(0);
        expect(snap.routeDistance).toBeLessThan(s.route.length + 10);
      }
    }
    // 4 intervals → portals into intervals 1, 2, 3; the last gate is the finish, not a portal
    expect(epochs).toEqual([1, 2, 3]);
    expect(s.worlds).toHaveLength(4);
    expect(s.snapshot().workout?.finished).toBe(true);
    s.stop = () => {}; // no ride clock in tests
    const rec = s.finish();
    expect(rec.workoutName).toBeTruthy();
    expect(rec.routeName).toBe(rec.workoutName);
    expect(rec.name).toBe(rec.workoutName);
    // ERG held the power throughout the workout (grade was never sent while it ran)
    const firstGrade = trainer.calls.findIndex((c) => c.startsWith('grade'));
    const lastErg = trainer.calls.map((c) => c.startsWith('erg')).lastIndexOf(true);
    expect(firstGrade === -1 || firstGrade > lastErg).toBe(true);
  });

  it('flags the gate as a portal and hides what lies beyond it', () => {
    const { s, trainer } = ride({ portalSeed: 1 });
    trainer.push(200);
    s.tick(0.1);
    const snap = s.snapshot();
    expect(snap.portal).toBe(true);
    expect(snap.nextArchDistance).toBeUndefined();
    expect(snap.upcoming).toHaveLength(1);
    expect(snap.upcoming[0].distance).toBeCloseTo(snap.archDistance!, 6);
  });

  it('stays put in SIM mode, and on ordinary rides', () => {
    for (const r of [ride({ portalSeed: 7, erg: false }), ride()]) {
      for (let i = 0; i < 2000; i++) {
        r.trainer.push(200);
        r.s.tick(0.1);
        expect(r.s.snapshot().portal).toBe(false);
      }
      expect(r.s.routeEpoch).toBe(0);
      expect(r.s.snapshot().routeDistance).toBe(r.s.snapshot().distance);
    }
  });

  it('same seed, same worlds', () => {
    const a = ride({ portalSeed: 99 });
    const b = ride({ portalSeed: 99 });
    for (let i = 0; i < 2000; i++) {
      a.trainer.push(200);
      b.trainer.push(200);
      a.s.tick(0.1);
      b.s.tick(0.1);
    }
    expect(a.s.worlds).toEqual(b.s.worlds);
  });

  it('picks every other world over time, never the current one', () => {
    const rand = rng(3);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const j = pickPortalJump(rand, 'kyoto');
      expect(j.preset).not.toBe('kyoto');
      const lap = ROUTE_PRESETS.find((p) => p.id === j.preset)!.lengthKm * 1000;
      expect(j.spawn).toBeGreaterThanOrEqual(0);
      expect(j.spawn).toBeLessThan(lap);
      seen.add(j.preset);
    }
    expect(seen.size).toBe(ROUTE_PRESETS.length - 1);
  });

});
