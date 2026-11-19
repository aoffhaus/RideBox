/**
 * Interval arches, like Zwift's: the arch sits at the distance you will have
 * ridden when the interval ends, re-projected every frame from your (smoothed)
 * speed. As time runs out the arch converges on you, and you pass through it
 * exactly when the interval ends.
 */
export class ArchTracker {
  private speed = 0;
  private initialized = false;
  /** Minimum projection speed so the arch is visible even when stopped. */
  constructor(private minSpeed = 3, private tau = 3) {}

  update(dt: number, currentSpeed: number) {
    if (!this.initialized) {
      this.speed = currentSpeed;
      this.initialized = true;
    } else {
      const a = 1 - Math.exp(-dt / this.tau);
      this.speed += (currentSpeed - this.speed) * a;
    }
  }

  get projectedSpeed() {
    return Math.max(this.minSpeed, this.speed);
  }

  /** Distance (m along route) of the arch that ends an interval with `remaining` seconds left. */
  archDistance(riderDistance: number, remaining: number): number {
    return riderDistance + this.projectedSpeed * Math.max(0, remaining);
  }
}

/**
 * Smooths an arch's rendered position. The ride clock ticks at 10 Hz but we draw
 * every frame, so the caller extrapolates the target between ticks; this then eases
 * out the small corrections left over (projected-speed drift, tick jitter), and
 * snaps when the arch genuinely moves (a new interval, a skipped interval).
 */
export class ArchFollower {
  pos: number | undefined;
  constructor(private rate = 3, private snap = 40) {}
  update(dt: number, target: number | undefined): number | undefined {
    if (target == null) return (this.pos = undefined);
    if (this.pos == null || Math.abs(target - this.pos) > this.snap) this.pos = target;
    else this.pos += (target - this.pos) * (1 - Math.exp(-dt * this.rate));
    return this.pos;
  }
}
