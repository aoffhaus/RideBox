// Procedurally generated looping routes.

export type RoutePresetId = 'rolling' | 'bigsur' | 'redwoods' | 'zion' | 'synthwave' | 'neoncity';

/** Visual theme of the 3D world (sky, terrain, scenery). Defaults to 'countryside'. */
export type ThemeId = 'countryside' | 'bigsur' | 'redwoods' | 'zion' | 'synthwave' | 'neoncity';

export interface RoutePreset {
  id: RoutePresetId;
  name: string;
  description: string;
  lengthKm: number;
  maxGrade: number; // fraction
  harmonics: [number, number]; // elevation wave numbers per lap
  bendiness: number; // 0..1
  theme?: ThemeId; // scenery theme (default 'countryside')
}

export const ROUTE_PRESETS: RoutePreset[] = [
  { id: 'rolling', name: 'Rolling Farmland', description: 'Short punchy rollers', lengthKm: 20, maxGrade: 0.045, harmonics: [8, 30], bendiness: 0.45 },
  {
    id: 'bigsur',
    name: 'Big Sur Coast',
    description: 'Cliff-top coast road above the Pacific: golden headlands, sea stacks and steep pitches out of every cove',
    lengthKm: 24,
    maxGrade: 0.065,
    harmonics: [3, 14],
    bendiness: 0.65,
    theme: 'bigsur',
  },
  {
    id: 'redwoods',
    name: 'Redwood Forest',
    description: 'Gentle rollers through misty old-growth giants, ferns brushing the road',
    lengthKm: 15,
    maxGrade: 0.035,
    harmonics: [5, 20],
    bendiness: 0.6,
    theme: 'redwoods',
  },
  {
    id: 'zion',
    name: 'Zion Canyon',
    description: 'Red-road canyon floor beneath towering sandstone walls, with a couple of long steady climbs',
    lengthKm: 20,
    maxGrade: 0.06,
    harmonics: [2, 8],
    bendiness: 0.5,
    theme: 'zion',
  },
  {
    id: 'synthwave',
    name: 'Neon Grid',
    description: 'Fast rhythmic rollers across a glowing grid at night, racing a giant retro sun',
    lengthKm: 18,
    maxGrade: 0.03,
    harmonics: [6, 24],
    bendiness: 0.4,
    theme: 'synthwave',
  },
  {
    id: 'neoncity',
    name: 'Neon Rain',
    description: 'Night streets in steady rain: neon mirrored in wet asphalt, canyons of lit towers and a couple of overpass ramps',
    lengthKm: 14,
    maxGrade: 0.035,
    harmonics: [6, 22],
    bendiness: 0.35,
    theme: 'neoncity',
  },
];

export interface RoutePoint {
  x: number;
  y: number; // elevation (m)
  z: number;
  heading: number; // radians, direction of travel in the xz plane
  grade: number; // rise/run
}

export interface Route {
  preset: RoutePreset;
  seed: number;
  length: number; // meters per lap
  step: number; // sample spacing (m)
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  grade: Float32Array;
  heading: Float32Array;
  totalClimb: number; // m per lap
  at(distance: number): RoutePoint;
  /** For a visually exaggerated copy: the true route it was made from. */
  base?: Route;
}

// Small seeded PRNG (mulberry32)
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Closed centripetal Catmull-Rom through 2D control points, resampled by arc length. */
function closedSpline(ctrl: [number, number][], step: number): { pts: [number, number][]; length: number } {
  const n = ctrl.length;
  const dense: [number, number][] = [];
  const SUB = 60;
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % n];
    const p3 = ctrl[(i + 2) % n];
    // centripetal parameterisation
    const d = (a: [number, number], b: [number, number]) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
    const t0 = 0;
    const t1 = t0 + d(p0, p1);
    const t2 = t1 + d(p1, p2);
    const t3 = t2 + d(p2, p3);
    for (let k = 0; k < SUB; k++) {
      const t = t1 + ((t2 - t1) * k) / SUB;
      const lerp = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => {
        const w = (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const A1 = lerp(p0, p1, t0, t1);
      const A2 = lerp(p1, p2, t1, t2);
      const A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2);
      const B2 = lerp(A2, A3, t1, t3);
      dense.push(lerp(B1, B2, t1, t2));
    }
  }
  // cumulative length
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[cum.length - 1];
  const count = Math.round(length / step);
  const pts: [number, number][] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * length;
    while (cum[j + 1] < s) j++;
    const a = dense[j];
    const b = dense[(j + 1) % dense.length];
    const w = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    pts.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
  }
  return { pts, length };
}

export function generateRoute(presetId: RoutePresetId, seed = 1): Route {
  const preset = ROUTE_PRESETS.find((p) => p.id === presetId) ?? ROUTE_PRESETS[0];
  const rand = rng(seed * 7919 + presetId.length * 104729);
  const targetLen = preset.lengthKm * 1000;
  const step = 5;

  // Control points around a wobbly circle.
  const nCtrl = 14 + Math.floor(preset.bendiness * 16);
  const R = targetLen / (2 * Math.PI);
  const ctrl: [number, number][] = [];
  for (let i = 0; i < nCtrl; i++) {
    const ang = (i / nCtrl) * Math.PI * 2 + (rand() - 0.5) * (Math.PI / nCtrl) * preset.bendiness;
    const r = R * (1 + (rand() - 0.5) * 0.5 * preset.bendiness);
    ctrl.push([Math.cos(ang) * r, Math.sin(ang) * r]);
  }
  let { pts, length } = closedSpline(ctrl, step);
  // Rescale so a lap is close to the preset length.
  const k = targetLen / length;
  pts = pts.map(([x, z]) => [x * k, z * k]);
  length *= k;
  const n = pts.length;
  const realStep = length / n;

  // Elevation: sum of periodic harmonics (so the loop closes), scaled to max grade.
  const [kLo, kHi] = preset.harmonics;
  const waves: { k: number; a: number; ph: number }[] = [];
  for (let h = kLo; h <= kHi; h++) waves.push({ k: h, a: (0.3 + rand()) / Math.pow(h, 1.1), ph: rand() * Math.PI * 2 });
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = (i / n) * Math.PI * 2;
    let e = 0;
    for (const w of waves) e += w.a * Math.sin(w.k * s + w.ph);
    elev[i] = e;
  }
  // scale to target max grade
  let maxG = 0;
  for (let i = 0; i < n; i++) {
    const g = Math.abs(elev[(i + 1) % n] - elev[(i - 1 + n) % n]) / (2 * realStep);
    maxG = Math.max(maxG, g);
  }
  const scale = maxG > 0 ? preset.maxGrade / maxG : 0;
  let minE = Infinity;
  for (let i = 0; i < n; i++) {
    elev[i] *= scale;
    minE = Math.min(minE, elev[i]);
  }
  for (let i = 0; i < n; i++) elev[i] += 20 - minE;

  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const grade = new Float32Array(n);
  const heading = new Float32Array(n);
  let climb = 0;
  for (let i = 0; i < n; i++) {
    x[i] = pts[i][0];
    z[i] = pts[i][1];
    const nx = pts[(i + 1) % n];
    const px = pts[(i - 1 + n) % n];
    heading[i] = Math.atan2(nx[1] - px[1], nx[0] - px[0]);
    grade[i] = (elev[(i + 1) % n] - elev[(i - 1 + n) % n]) / (2 * realStep);
    const d = elev[(i + 1) % n] - elev[i];
    if (d > 0) climb += d;
  }

  const lerpAngle = (a: number, b: number, w: number) => {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * w;
  };

  const route: Route = {
    preset,
    seed,
    length,
    step: realStep,
    x,
    y: elev,
    z,
    grade,
    heading,
    totalClimb: climb,
    at(distance: number): RoutePoint {
      const d = ((distance % length) + length) % length;
      const f = d / realStep;
      const i = Math.floor(f) % n;
      const j = (i + 1) % n;
      const w = f - Math.floor(f);
      return {
        x: x[i] + (x[j] - x[i]) * w,
        y: elev[i] + (elev[j] - elev[i]) * w,
        z: z[i] + (z[j] - z[i]) * w,
        heading: lerpAngle(heading[i], heading[j], w),
        grade: grade[i] + (grade[j] - grade[i]) * w,
      };
    },
  };
  return route;
}

/**
 * A copy of the route with elevations scaled by `k` around the lowest point —
 * used only for drawing (like Zwift, climbs and descents look steeper than they
 * are). Physics, the trainer and the HUD keep using the true route.
 */
export function exaggerateRoute(route: Route, k: number): Route {
  if (k === 1) return route;
  const n = route.y.length;
  let minY = Infinity;
  for (const v of route.y) minY = Math.min(minY, v);
  const y = new Float32Array(n);
  const grade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = minY + (route.y[i] - minY) * k;
    grade[i] = route.grade[i] * k;
  }
  const { length, step } = route;
  return {
    ...route,
    y,
    grade,
    totalClimb: route.totalClimb * k,
    base: route,
    at(distance: number): RoutePoint {
      const p = route.at(distance);
      const d = ((distance % length) + length) % length;
      const f = d / step;
      const i = Math.floor(f) % n;
      const j = (i + 1) % n;
      const w = f - Math.floor(f);
      return { ...p, y: y[i] + (y[j] - y[i]) * w, grade: grade[i] + (grade[j] - grade[i]) * w };
    },
  };
}
