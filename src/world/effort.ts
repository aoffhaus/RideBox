// Effort meter: turns live power into two smooth 0..1 signals the world reacts to.
//
//   build  - sustained effort. Each intensity has a level it climbs toward and a
//            time constant that shrinks as the effort gets harder: endurance (Z1-Z2)
//            does nothing, a long tempo/sweet-spot block (Z3) creeps up over minutes,
//            threshold builds in about a minute, VO2 in seconds. It relaxes slowly
//            afterwards so the world calms down rather than snapping back.
//   surge  - sprint punch. Rises within a fraction of a second above ~130% FTP and
//            fades over a few seconds, so a kick is felt almost immediately.
//
// `level` = the strongest of the two, for effects that only need one number.
// Pure and deterministic (no three.js, no clock) so it is unit-tested.

export interface EffortState {
  build: number;
  surge: number;
  level: number;
  /** current power as a fraction of FTP (smoothed 3 s power / FTP) */
  intensity: number;
}

/** Piecewise-linear lookup over sorted [x, y] points (clamped at both ends). */
function curve(pts: readonly (readonly [number, number])[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const [x1, y1] = pts[k];
    if (x <= x1) {
      const [x0, y0] = pts[k - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Level the build signal settles at for a sustained intensity (fraction of FTP). */
export const BUILD_TARGET = [
  [0.75, 0], // top of Z2: nothing happens
  [0.76, 0.3], // Z3 tempo
  [0.9, 0.5], // sweet spot
  [1.05, 0.72], // threshold
  [1.2, 0.88], // VO2
  [1.5, 1],
] as const;

/** Seconds (time constant) to approach that level: long for tempo, short for hard efforts. */
export const BUILD_TAU = [
  [0.76, 300],
  [0.9, 150],
  [1.05, 60],
  [1.2, 15],
  [1.5, 3],
] as const;

const RELAX_TAU = 25; // calming down after an effort
const SURGE_ATTACK = 0.35;
const SURGE_RELEASE = 3.5;

export class EffortMeter {
  build = 0;
  surge = 0;
  intensity = 0;

  /** Advance by dt seconds with the current (3 s smoothed) power. Paused/coasting = 0 W. */
  update(dt: number, watts: number, ftp: number): EffortState {
    dt = Math.max(0, Math.min(dt, 1));
    const x = ftp > 0 ? Math.max(0, watts) / ftp : 0;
    this.intensity = x;

    const target = x < BUILD_TARGET[0][0] ? 0 : curve(BUILD_TARGET, x);
    const tau = target > this.build ? curve(BUILD_TAU, x) : RELAX_TAU;
    this.build += (target - this.build) * (1 - Math.exp(-dt / tau));

    const sTarget = Math.min(1, Math.max(0, (x - 1.3) / 0.5)); // 130% → 0, 180% → 1
    const sTau = sTarget > this.surge ? SURGE_ATTACK : SURGE_RELEASE;
    this.surge += (sTarget - this.surge) * (1 - Math.exp(-dt / sTau));

    return this.state;
  }

  get state(): EffortState {
    return { build: this.build, surge: this.surge, level: Math.max(this.build, this.surge), intensity: this.intensity };
  }
}
