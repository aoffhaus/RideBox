import type { HeartRateMonitor, Trainer } from '../ble/types';
import { WorkoutEngine, type EngineState } from '../workout/engine';
import { intervalFtpFraction, zoneFor, type Workout } from '../workout/model';
import { DEFAULT_RIDER, stepSpeed, type RiderParams } from '../physics/rider';
import { ROUTE_PRESETS, generateRoute, rng, type Route, type RoutePresetId } from '../world/route';
import { ArchTracker } from '../world/arches';
import { summarize, type Lap, type RideRecord, type Sample } from './recorder';
import type { Settings } from '../storage/db';
import { uid } from '../storage/db';

export interface IntervalStats {
  avgPower: number;
  avgHr?: number;
  avgCadence?: number;
  seconds: number;
}

export interface Snapshot {
  started: boolean;
  paused: boolean;
  autoPaused: boolean;
  elapsed: number; // ride (moving) time
  power: number; // instantaneous
  power3s: number;
  cadence: number;
  hr?: number;
  speed: number; // m/s
  distance: number; // m, total ridden this session (the odometer)
  /** Where you are on the current route (m along it). Equals `distance` unless portals moved you. */
  routeDistance: number;
  /** Bumps each time a portal swaps the route (the views rebuild for the new world). */
  routeEpoch: number;
  /** Continuous altitude: portal jumps are levelled out so climbing totals stay honest. */
  altitude: number;
  grade: number;
  ergOn: boolean;
  mode: 'erg' | 'sim';
  workout?: EngineState;
  workoutDone: boolean;
  intervalStats?: IntervalStats;
  /** Route distances (on the current route) of the gate ending this interval and the next one. */
  archDistance?: number;
  nextArchDistance?: number;
  /** The gate ending this interval is a portal to another world. */
  portal: boolean;
  /** Projected route distance where each upcoming interval starts (next few; on the current route). */
  upcoming: { index: number; distance: number; startsIn: number }[];
  lapCount: number;
}

export interface SessionOptions {
  trainer: Trainer;
  hrm?: HeartRateMonitor | null;
  settings: Settings;
  workout?: Workout;
  routePreset: RoutePresetId;
  routeSeed?: number;
  /**
   * Portal run: every interval gate of an ERG workout is a portal that drops you at a
   * random spot in a random world. Seeds the sequence of worlds (so it can be repeated).
   */
  portalSeed?: number;
}

/** Where a portal took you. */
export interface PortalJump {
  preset: RoutePresetId;
  seed: number;
  /** route distance you arrive at */
  spawn: number;
}

/**
 * Picks the next portal destination: a different world from the one you're in
 * (so every jump is a visible change), a fresh layout seed, and a random spot on it.
 */
export function pickPortalJump(rand: () => number, current: RoutePresetId): PortalJump {
  const options = ROUTE_PRESETS.filter((p) => p.id !== current);
  const preset = options[Math.floor(rand() * options.length) % options.length];
  const seed = 1 + Math.floor(rand() * 1e6);
  const lap = preset.lengthKm * 1000;
  return { preset: preset.id, seed, spawn: rand() * lap };
}

/**
 * The ride: ties the trainer, HRM, workout clock, physics, arches and the
 * 1 Hz recorder together. Runs on its own timer so it keeps going even if
 * the 3D view is throttled.
 */
export class RideSession {
  /** The route you're on; replaced when a portal moves you to another world. */
  route: Route;
  /** route position = distance + routeOffset */
  private routeOffset = 0;
  /** added to the route's altitude so the recorded altitude doesn't jump through portals */
  private altOffset = 0;
  /** Bumps on every route swap. */
  routeEpoch = 0;
  /** Names of the worlds ridden, in order (portal runs visit several). */
  readonly worlds: string[] = [];
  private portalRand?: () => number;
  private portalArmed = false;
  readonly engine?: WorkoutEngine;
  readonly startTime = Date.now();
  readonly samples: Sample[] = [];
  readonly laps: Lap[] = [];
  readonly arch = new ArchTracker();
  readonly rider: RiderParams;

  started = false;
  paused = false;
  /** paused automatically because you stopped pedalling */
  autoPaused = false;
  private zeroSince = 0;
  ergOn = true;
  elapsed = 0;
  distance = 0;
  speed = 0;
  power = 0;
  cadence = 0;
  hr?: number;
  private powerHist: { t: number; p: number }[] = [];
  private lapStart = 0;
  private lastIntervalIndex = 0;
  private nextSampleAt = 1;
  private lastControlAt = -1;
  private timer?: number;
  private lastTick = performance.now();
  private ivAcc = { p: 0, hr: 0, hrN: 0, cad: 0, cadN: 0, n: 0 };
  private listeners = new Set<() => void>();
  /** called when the planned workout finishes */
  onWorkoutComplete?: () => void;
  private completedFired = false;

  constructor(private opts: SessionOptions) {
    const s = opts.settings;
    this.rider = { ...DEFAULT_RIDER, riderKg: s.riderKg, bikeKg: s.bikeKg, cda: s.cda };
    if (opts.workout) this.engine = new WorkoutEngine(opts.workout, s.ftp);
    if (opts.portalSeed != null) this.portalRand = rng(opts.portalSeed);
    this.route = generateRoute(opts.routePreset, opts.routeSeed ?? 1);
    this.worlds.push(this.route.preset.name);

    opts.trainer.onData = (d) => {
      this.power = d.power;
      this.cadence = d.cadence;
      const now = performance.now();
      this.powerHist.push({ t: now, p: d.power });
      while (this.powerHist.length && now - this.powerHist[0].t > 3000) this.powerHist.shift();
      if (!this.started && d.power > 20) this.started = true;
    };
    if (opts.hrm) opts.hrm.onHeartRate = (b) => (this.hr = b);
  }

  get trainer() {
    return this.opts.trainer;
  }

  /** performance.now() of the last ride-clock tick (the 3D view extrapolates between ticks) */
  get tickAt() {
    return this.lastTick;
  }

  /** The rider's FTP from settings (used even in free rides, where there is no workout engine). */
  get ftp() {
    return this.opts.settings.ftp;
  }

  /** A portal run (portals only open on ERG workout intervals). */
  get portalRun() {
    return this.portalRand != null;
  }

  /** Position on the current route. */
  get routeDistance() {
    return this.distance + this.routeOffset;
  }

  /**
   * Whether the gate at the end of the current interval is a portal: a portal run,
   * mid-workout with ERG holding the power (in SIM the jump in grade would be felt),
   * and another interval to ride after it.
   */
  private portalOpen(st: EngineState | undefined): boolean {
    return !!this.portalRand && !!st && !st.finished && this.ergOn && st.targetWatts != null && !!st.next;
  }

  /** Move to another world. The odometer, recording and workout carry on untouched. */
  teleport(jump: PortalJump) {
    const before = this.route.at(this.routeDistance).y + this.altOffset;
    this.route = generateRoute(jump.preset, jump.seed);
    this.routeOffset = jump.spawn - this.distance;
    this.altOffset = before - this.route.at(jump.spawn).y;
    this.routeEpoch++;
    this.worlds.push(this.route.preset.name);
  }

  start() {
    window.clearInterval(this.timer);
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(1, (now - this.lastTick) / 1000);
      this.lastTick = now;
      this.tick(dt);
    }, 100);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get power3s() {
    if (!this.powerHist.length) return this.power;
    return this.powerHist.reduce((a, b) => a + b.p, 0) / this.powerHist.length;
  }

  /** Advance the simulation by dt seconds (exposed for tests). */
  tick(dt: number) {
    // auto-pause after 3 s without power; resume as soon as you pedal
    if (this.started) {
      if (this.power < 5) {
        this.zeroSince += dt;
        if (this.zeroSince >= 3) this.autoPaused = true;
      } else {
        this.zeroSince = 0;
        if (this.power > 20) this.autoPaused = false;
      }
    }
    const moving = this.started && !this.paused && !this.autoPaused;
    // was the gate ahead a portal? (as of the last tick, before the interval changed under it)
    const portalAhead = this.portalArmed;
    let pt = this.route.at(this.routeDistance);
    if (moving) {
      this.engine?.tick(dt);
      this.elapsed += dt;
      this.speed = stepSpeed(this.speed, this.power, pt.grade, dt, this.rider);
      this.distance += this.speed * dt;
    }
    this.arch.update(dt, this.speed);

    // Interval change → lap
    const st = this.engine?.state;
    if (st && st.index !== this.lastIntervalIndex) {
      this.closeLap(this.intervalName(this.lastIntervalIndex));
      // ridden (not skipped back) through a portal gate: off to another world
      if (portalAhead && st.index > this.lastIntervalIndex) {
        this.teleport(pickPortalJump(this.portalRand!, this.route.preset.id));
        pt = this.route.at(this.routeDistance);
      }
      this.lastIntervalIndex = st.index;
      this.ivAcc = { p: 0, hr: 0, hrN: 0, cad: 0, cadN: 0, n: 0 };
    }
    this.portalArmed = this.portalOpen(st);
    if (st?.finished && !this.completedFired) {
      this.completedFired = true;
      this.onWorkoutComplete?.();
    }

    // Trainer control at most every 0.5 s (only sends on change)
    if (this.elapsed - this.lastControlAt >= 0.5 || this.lastControlAt < 0 || !moving) {
      this.lastControlAt = this.elapsed;
      this.applyControl(st, pt.grade);
    }

    // 1 Hz recording
    if (moving && this.elapsed >= this.nextSampleAt) {
      this.nextSampleAt += 1;
      const target = st?.targetWatts ?? undefined;
      this.samples.push({
        t: Date.now(),
        elapsed: Math.round(this.elapsed),
        power: Math.round(this.power),
        hr: this.hr,
        cadence: Math.round(this.cadence),
        speed: this.speed,
        distance: this.distance,
        altitude: pt.y + this.altOffset,
        target: target ?? undefined,
      });
      const a = this.ivAcc;
      a.n++;
      a.p += this.power;
      if (this.hr) {
        a.hr += this.hr;
        a.hrN++;
      }
      if (this.cadence > 0) {
        a.cad += this.cadence;
        a.cadN++;
      }
    }
    this.listeners.forEach((f) => f());
  }

  private applyControl(st: EngineState | undefined, grade: number) {
    const t = this.opts.trainer;
    const workoutActive = st && !st.finished;
    if (workoutActive && this.ergOn && st!.targetWatts != null) {
      void t.setTargetPower(st!.targetWatts!);
    } else {
      void t.setGrade((grade * this.opts.settings.simDifficulty) / 100);
    }
  }

  private intervalName(i: number): string | undefined {
    const iv = this.engine?.intervals[i];
    if (!iv) return undefined;
    return iv.label ?? (iv.free ? 'Free ride' : zoneFor(intervalFtpFraction(iv, this.opts.settings.ftp)).name);
  }

  private closeLap(label?: string) {
    if (this.samples.length > this.lapStart) {
      const lapSamples = this.samples.slice(this.lapStart);
      const targets = lapSamples.map((s) => s.target).filter((x): x is number => x != null);
      this.laps.push({
        startIndex: this.lapStart,
        endIndex: this.samples.length,
        label,
        target: targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : undefined,
      });
    }
    this.lapStart = this.samples.length;
  }

  // ---- controls ----
  togglePause() {
    this.paused = !this.paused;
    this.engine?.setPaused(this.paused);
  }
  toggleErg() {
    this.ergOn = !this.ergOn;
  }
  skipInterval() {
    this.engine?.skip();
  }
  extendInterval(sec = 60) {
    this.engine?.extend(sec);
  }
  adjustIntensity(delta: number) {
    this.engine?.adjustIntensity(delta);
  }
  manualLap() {
    if (!this.engine) this.closeLap(`Lap ${this.laps.length + 1}`);
  }

  snapshot(): Snapshot {
    const rd = this.routeDistance;
    const pt = this.route.at(rd);
    const st = this.engine?.state;
    const a = this.ivAcc;
    const workoutActive = !!st && !st.finished;
    let archDistance: number | undefined;
    let nextArchDistance: number | undefined;
    const upcoming: Snapshot['upcoming'] = [];
    const portal = this.portalOpen(st);
    if (workoutActive && st) {
      archDistance = this.arch.archDistance(rd, st.remaining);
      // beyond a portal lies another world: nothing further to show on this route
      if (st.next && !portal) nextArchDistance = this.arch.archDistance(rd, st.remaining + st.next.duration);
      const ivs = this.engine!.intervals;
      let t = st.remaining;
      for (let i = st.index + 1; i < ivs.length && upcoming.length < (portal ? 1 : 6); i++) {
        upcoming.push({ index: i, distance: this.arch.archDistance(rd, t), startsIn: t });
        t += ivs[i].duration;
      }
      // where the workout ends (useful to show the finish on the map)
      if (upcoming.length < 6 && !portal) upcoming.push({ index: ivs.length, distance: this.arch.archDistance(rd, t), startsIn: t });
    }
    return {
      started: this.started,
      paused: this.paused || this.autoPaused,
      autoPaused: this.autoPaused,
      elapsed: this.elapsed,
      power: this.power,
      power3s: this.power3s,
      cadence: this.cadence,
      hr: this.hr,
      speed: this.speed,
      distance: this.distance,
      routeDistance: rd,
      routeEpoch: this.routeEpoch,
      altitude: pt.y + this.altOffset,
      grade: pt.grade,
      ergOn: this.ergOn,
      mode: workoutActive && this.ergOn && st?.targetWatts != null ? 'erg' : 'sim',
      workout: st,
      workoutDone: !!st?.finished,
      intervalStats: a.n
        ? {
            seconds: a.n,
            avgPower: a.p / a.n,
            avgHr: a.hrN ? a.hr / a.hrN : undefined,
            avgCadence: a.cadN ? a.cad / a.cadN : undefined,
          }
        : undefined,
      archDistance,
      nextArchDistance,
      portal,
      upcoming,
      lapCount: this.laps.length,
    };
  }

  /** Stop the ride and produce the record to save. */
  finish(): RideRecord {
    this.stop();
    this.closeLap(this.engine ? this.intervalName(this.lastIntervalIndex) ?? 'Cool down' : undefined);
    const ftp = this.opts.settings.ftp;
    const workoutName = this.engine?.workout.name;
    return {
      id: uid(),
      name: workoutName ?? (this.portalRun ? 'Portal run' : `${this.route.preset.name} ride`),
      workoutName,
      routeName: this.worlds.length > 1 ? `Portal run: ${portalRoute(this.worlds)}` : this.route.preset.name,
      startTime: this.startTime,
      ftp,
      samples: this.samples,
      laps: this.laps.length ? this.laps : [{ startIndex: 0, endIndex: this.samples.length }],
      summary: summarize(this.samples, ftp),
    };
  }
}

/** "A → B → C", collapsing long runs so the name stays readable. */
export function portalRoute(worlds: string[], max = 8): string {
  if (worlds.length <= max) return worlds.join(' → ');
  return [...worlds.slice(0, max - 2), `… ${worlds.length - (max - 1)} more`, worlds[worlds.length - 1]].join(' → ');
}
