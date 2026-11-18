/**
 * Turns the ride's 10 Hz distance updates into smooth per-frame motion.
 * Between updates the true position is extrapolated with the true speed, so the
 * target itself moves smoothly; the rendered position glides toward it.
 */
export class MotionSmoother {
  dist: number;
  speed = 0;
  private lastTrue: number;
  private age = 0;
  constructor(start = 0) {
    this.dist = start;
    this.lastTrue = start;
  }
  update(dt: number, trueDist: number, trueSpeed: number): number {
    if (trueDist !== this.lastTrue) {
      this.lastTrue = trueDist;
      this.age = 0;
    } else this.age += dt;
    const target = trueDist + trueSpeed * Math.min(this.age, 0.25);
    this.speed += (trueSpeed - this.speed) * (1 - Math.exp(-dt * 4));
    this.dist += this.speed * dt;
    const err = target - this.dist;
    if (Math.abs(err) > 25) this.dist = target;
    else this.dist += err * (1 - Math.exp(-dt * 1.5));
    return this.dist;
  }
}
