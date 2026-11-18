import { flatten, intervalPowerAt, toWatts, totalDuration, type Interval, type Workout } from './model';

export interface EngineState {
  elapsed: number;
  index: number; // -1 before start? never; == intervals.length when finished
  interval?: Interval;
  next?: Interval;
  timeInInterval: number;
  remaining: number; // seconds left in current interval
  totalRemaining: number;
  /** target watts after intensity scaling, null during free-ride segments / finished */
  targetWatts: number | null;
  intensity: number; // percent, 100 = as written
  paused: boolean;
  finished: boolean;
  cue?: string;
}

/**
 * The workout clock. Pure logic (no timers): call tick(dt) from the ride loop.
 * Skip / extend edit the timeline in place so recorded data stays consistent.
 */
export class WorkoutEngine {
  readonly intervals: Interval[];
  elapsed = 0;
  intensity = 100;
  paused = false;
  private idx = 0;

  constructor(
    public readonly workout: Workout,
    public ftp: number,
  ) {
    this.intervals = flatten(workout).map((iv) => ({ ...iv, cues: [...iv.cues] }));
  }

  get duration() {
    return totalDuration(this.intervals);
  }

  get finished() {
    return this.elapsed >= this.duration;
  }

  tick(dt: number) {
    if (this.paused || this.finished || dt <= 0) return;
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
  }

  private indexAt(t: number): number {
    const ivs = this.intervals;
    if (!ivs.length) return 0;
    let i = Math.min(this.idx, ivs.length - 1);
    while (i > 0 && t < ivs[i].start) i--;
    while (i < ivs.length && t >= ivs[i].start + ivs[i].duration) i++;
    this.idx = Math.min(i, ivs.length - 1);
    return i;
  }

  /** Target watts (scaled) at absolute workout time t; null if free ride / done. */
  targetAt(t: number): number | null {
    const i = this.indexAt(t);
    const iv = this.intervals[i];
    if (!iv || iv.free) return null;
    const raw = toWatts(intervalPowerAt(iv, t - iv.start), iv.unit, this.ftp);
    return Math.round((raw * this.intensity) / 100);
  }

  get state(): EngineState {
    const i = this.indexAt(this.elapsed);
    const iv = this.intervals[i];
    const timeIn = iv ? this.elapsed - iv.start : 0;
    let cue: string | undefined;
    if (iv) {
      for (const c of iv.cues) {
        if (timeIn >= c.offset && timeIn < c.offset + (c.duration ?? 10)) cue = c.message;
      }
    }
    return {
      elapsed: this.elapsed,
      index: i,
      interval: iv,
      next: this.intervals[i + 1],
      timeInInterval: timeIn,
      remaining: iv ? iv.duration - timeIn : 0,
      totalRemaining: Math.max(0, this.duration - this.elapsed),
      targetWatts: this.targetAt(this.elapsed),
      intensity: this.intensity,
      paused: this.paused,
      finished: this.finished,
      cue,
    };
  }

  private shiftFrom(i: number, delta: number) {
    for (let k = i; k < this.intervals.length; k++) this.intervals[k].start += delta;
  }

  /** End the current interval now and move to the next one. */
  skip() {
    const i = this.indexAt(this.elapsed);
    const iv = this.intervals[i];
    if (!iv) return;
    const timeIn = this.elapsed - iv.start;
    const delta = timeIn - iv.duration;
    if (iv.powerStart !== iv.powerEnd) {
      // keep the ramp's shape for what was ridden
      iv.powerEnd = intervalPowerAt(iv, timeIn);
    }
    iv.duration = timeIn;
    this.shiftFrom(i + 1, delta);
  }

  /** Make the current interval longer (default +60 s). */
  extend(seconds = 60) {
    const i = this.indexAt(this.elapsed);
    const iv = this.intervals[i];
    if (!iv) return;
    if (iv.powerStart !== iv.powerEnd) {
      // extend a ramp by holding its end power: insert a steady piece after it
      const steady: Interval = {
        ...iv,
        start: iv.start + iv.duration,
        duration: seconds,
        powerStart: iv.powerEnd,
        cues: [],
      };
      this.shiftFrom(i + 1, seconds);
      this.intervals.splice(i + 1, 0, steady);
      this.intervals.forEach((x, k) => (x.index = k));
      return;
    }
    iv.duration += seconds;
    this.shiftFrom(i + 1, seconds);
  }

  /** Change intensity in 1% steps (clamped 50–150%). */
  adjustIntensity(deltaPercent: number) {
    this.intensity = Math.max(50, Math.min(150, Math.round(this.intensity + deltaPercent)));
  }

  setPaused(p: boolean) {
    this.paused = p;
  }
}
