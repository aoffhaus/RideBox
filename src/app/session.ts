import type { HeartRateMonitor, Trainer } from '../ble/types';
import { WorkoutEngine, type EngineState } from '../workout/engine';
import { intervalFtpFraction, zoneFor, type Workout } from '../workout/model';
import { DEFAULT_RIDER, stepSpeed, type RiderParams } from '../physics/rider';
import { generateRoute, type Route, type RoutePresetId } from '../world/route';
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
  distance: number; // m
  altitude: number;
  grade: number;
  ergOn: boolean;
  mode: 'erg' | 'sim';
  workout?: EngineState;
  workoutDone: boolean;
  intervalStats?: IntervalStats;
  archDistance?: number;
  nextArchDistance?: number;
  /** Projected route distance where each upcoming interval starts (next few). */
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
}

/**
 * The ride: ties the trainer, HRM, workout clock, physics, arches and the
 * 1 Hz recorder together. Runs on its own timer so it keeps going even if
 * the 3D view is throttled.
 */
export class RideSession {
  readonly route: Route;
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
    this.route = generateRoute(opts.routePreset, opts.routeSeed ?? 1);
    if (opts.workout) this.engine = new WorkoutEngine(opts.workout, s.ftp);

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
    const pt = this.route.at(this.distance);
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
      this.lastIntervalIndex = st.index;
      this.ivAcc = { p: 0, hr: 0, hrN: 0, cad: 0, cadN: 0, n: 0 };
    }
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
        altitude: pt.y,
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
    const pt = this.route.at(this.distance);
    const st = this.engine?.state;
    const a = this.ivAcc;
    const workoutActive = !!st && !st.finished;
    let archDistance: number | undefined;
    let nextArchDistance: number | undefined;
    const upcoming: Snapshot['upcoming'] = [];
    if (workoutActive && st) {
      archDistance = this.arch.archDistance(this.distance, st.remaining);
      if (st.next) nextArchDistance = this.arch.archDistance(this.distance, st.remaining + st.next.duration);
      const ivs = this.engine!.intervals;
      let t = st.remaining;
      for (let i = st.index + 1; i < ivs.length && upcoming.length < 6; i++) {
        upcoming.push({ index: i, distance: this.arch.archDistance(this.distance, t), startsIn: t });
        t += ivs[i].duration;
      }
      // where the workout ends (useful to show the finish on the map)
      if (upcoming.length < 6) upcoming.push({ index: ivs.length, distance: this.arch.archDistance(this.distance, t), startsIn: t });
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
      altitude: pt.y,
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
      name: workoutName ?? `${this.route.preset.name} ride`,
      workoutName,
      routeName: this.route.preset.name,
      startTime: this.startTime,
      ftp,
      samples: this.samples,
      laps: this.laps.length ? this.laps : [{ startIndex: 0, endIndex: this.samples.length }],
      summary: summarize(this.samples, ftp),
    };
  }
}
