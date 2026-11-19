// Adaptive render quality: watches the real frame rate and trades detail for smoothness.
// It first gives up the cheap-to-lose extras (ambient-occlusion quality, shadow-map
// resolution), then resolution, then ambient occlusion and bloom resolution as a last
// resort. It steps down quickly when the GPU can't keep up and only tries stepping back
// up after a long run of smooth frames, backing off for a while if that made it choppy.

export interface QualityLevel {
  /** renderer pixel ratio (1 = one rendered pixel per CSS pixel) */
  pixelRatio: number;
  /** ambient occlusion pass on (high graphics only) */
  ao: boolean;
  /** fewer ambient-occlusion samples */
  aoLite: boolean;
  /** sun shadow map size in texels (square) */
  shadowMap: number;
  /** bloom buffer size relative to normal (1 = default, 0.5 = half) */
  bloomScale: number;
}

/** The ladder of levels to walk, best first, for a graphics setting and display. */
export function qualityLevels(graphics: 'high' | 'low', devicePixelRatio: number): QualityLevel[] {
  const top = graphics === 'high' ? Math.min(devicePixelRatio, 2) : 1;
  const ratios = [2, 1.75, 1.5, 1.25, 1].filter((r) => r < top - 1e-3);
  if (graphics === 'low') {
    // no post chain and no shadows: resolution is the only knob
    return [top, 0.75].map((pixelRatio) => ({ pixelRatio, ao: false, aoLite: false, shadowMap: 1024, bloomScale: 1 }));
  }
  const full: QualityLevel = { pixelRatio: top, ao: true, aoLite: false, shadowMap: 1536, bloomScale: 1 };
  const levels: QualityLevel[] = [
    full,
    { ...full, aoLite: true, shadowMap: 1024 },
    { ...full, aoLite: true, shadowMap: 768 },
  ];
  const lean = levels[levels.length - 1];
  for (const pixelRatio of ratios) levels.push({ ...lean, pixelRatio });
  levels.push({ ...lean, pixelRatio: 1, ao: false });
  levels.push({ ...lean, pixelRatio: 0.75, ao: false, bloomScale: 0.5 });
  return levels;
}

export interface AdaptiveOptions {
  /** below this (fps, averaged over a window) counts as choppy */
  low: number;
  /** at or above this counts as smooth */
  high: number;
  /** seconds per measurement window */
  window: number;
  /** consecutive choppy windows before stepping down (one hitch shouldn't drop quality) */
  downAfter: number;
  /** consecutive smooth windows before trying a step up */
  upAfter: number;
  /** seconds to wait before retrying a level that proved too slow */
  retryAfter: number;
  /** seconds ignored at start (shader compiles, texture uploads) */
  warmup: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveOptions = { low: 48, high: 56, window: 1, downAfter: 2, upAfter: 8, retryAfter: 60, warmup: 3 };

export class AdaptiveQuality {
  /** index into `levels` (0 = best) */
  index = 0;
  /** frame rate measured over the last complete window */
  fps = 0;
  private t = 0;
  private frames = 0;
  private winTime = 0;
  private bad = 0;
  private good = 0;
  /** time (s) each level last proved too slow */
  private failedAt: number[];
  private opts: AdaptiveOptions;

  constructor(
    readonly levels: QualityLevel[],
    opts: Partial<AdaptiveOptions> = {},
  ) {
    this.opts = { ...DEFAULT_ADAPTIVE, ...opts };
    this.failedAt = levels.map(() => -Infinity);
  }

  get level() {
    return this.levels[this.index];
  }

  /** Feed one frame's duration (s). Returns true when the level changed. */
  frame(dt: number): boolean {
    const o = this.opts;
    // a stall this long is a hidden tab or a one-off rebuild, not the steady frame rate
    if (dt > 1) {
      this.frames = 0;
      this.winTime = 0;
      return false;
    }
    this.t += dt;
    if (this.t < o.warmup) return false;
    this.frames++;
    this.winTime += dt;
    if (this.winTime < o.window) return false;
    this.fps = this.frames / this.winTime;
    this.frames = 0;
    this.winTime = 0;

    if (this.fps < o.low) {
      this.good = 0;
      if (++this.bad >= o.downAfter && this.index < this.levels.length - 1) {
        this.failedAt[this.index] = this.t;
        return this.move(+1);
      }
    } else {
      this.bad = 0;
      if (this.fps >= o.high) {
        if (++this.good >= o.upAfter && this.index > 0 && this.t - this.failedAt[this.index - 1] >= o.retryAfter) return this.move(-1);
      } else this.good = 0;
    }
    return false;
  }

  private move(step: number) {
    this.index += step;
    this.bad = 0;
    this.good = 0;
    return true;
  }
}
