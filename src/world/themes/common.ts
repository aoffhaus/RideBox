// Shared helpers for themed landscapes: loop geometry, periodic noise, a generic
// terrain-ribbon builder driven by a per-theme height/colour model, and chunked
// instancing so off-screen scenery is frustum-culled.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Route } from '../route';
import { rng } from '../route';

export { rng };
export const ROAD_HALF = 4.5;
/** Offset of the terrain column that meets the road edge. */
export const EDGE = ROAD_HALF - 0.1; // tucked just under the road edge so no gap shows

export const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Loop info
// ---------------------------------------------------------------------------
export interface LoopInfo {
  n: number;
  cx: number;
  cz: number;
  minY: number;
  maxY: number;
  /** Sign of the lateral offset that points to the inside of the loop (+1 or -1). */
  inward: 1 | -1;
}

export function loopInfo(route: Route): LoopInfo {
  const n = route.x.length;
  let cx = 0;
  let cz = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cx += route.x[i];
    cz += route.z[i];
    minY = Math.min(minY, route.y[i]);
    maxY = Math.max(maxY, route.y[i]);
    area += route.x[i] * route.z[j] - route.x[j] * route.z[i];
  }
  // Lateral (-sin h, cos h) = left normal of the direction of travel in the x/z plane:
  // it points inside the loop when the loop runs counter-clockwise (positive area).
  return { n, cx: cx / n, cz: cz / n, minY, maxY, inward: area > 0 ? 1 : -1 };
}

/**
 * Smooth periodic wave along the lap (an integer number of cycles, so it is
 * seamless where the loop closes). Returns -1..1.
 */
export function lapWave(route: Route, i: number, cyclesPerKm: number, phase: number) {
  const cycles = Math.max(1, Math.round((cyclesPerKm * route.length) / 1000));
  return Math.sin((2 * Math.PI * cycles * i) / route.x.length + phase);
}

/** World position at route sample i, lateral offset off, height dy above the road centreline. */
export function worldAt(route: Route, i: number, off: number, dy: number, out = new THREE.Vector3()) {
  const h = route.heading[i];
  return out.set(route.x[i] - Math.sin(h) * off, route.y[i] + dy, route.z[i] + Math.cos(h) * off);
}

/** Shortest signed distance in samples from i to c around the loop. */
export function loopDelta(i: number, c: number, n: number) {
  let d = i - c;
  if (d > n / 2) d -= n;
  if (d < -n / 2) d += n;
  return d;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
export interface TerrainModel {
  /** Number of columns across (both sides of the road). */
  cols: number;
  /** The quad between column roadCol and roadCol+1 is the road and is left open. */
  roadCol: number;
  /** Actual lateral offset (m) of column c at route sample i (monotonic in c). */
  colOff(i: number, c: number): number;
  /** Ground height relative to the road centreline at sample i, lateral offset off. */
  height(i: number, off: number): number;
  color(i: number, off: number, dy: number, out: THREE.Color): void;
  uv?(i: number, off: number, dy: number, x: number, z: number, out: [number, number]): void;
  map?: THREE.Texture;
  flatShading?: boolean;
}

/**
 * How far terrain may extend to each side of the road before the ribbons would fold
 * over themselves on the inside of a bend (≈ the local turning radius). [neg side, pos side]
 */
const limitCache = new WeakMap<Route, [Float32Array, Float32Array]>();
export function foldLimits(route: Route): [Float32Array, Float32Array] {
  const cached = limitCache.get(route);
  if (cached) return cached;
  const n = route.x.length;
  const w = 6;
  const raw: [Float32Array, Float32Array] = [new Float32Array(n).fill(1e6), new Float32Array(n).fill(1e6)];
  for (let i = 0; i < n; i++) {
    let dh = route.heading[(i + w) % n] - route.heading[(i - w + n) % n];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const k = dh / (2 * w * route.step); // >0: turning towards +off
    if (Math.abs(k) < 1e-6) continue;
    raw[k > 0 ? 1 : 0][i] = 0.7 / Math.abs(k);
  }
  // spread each limit along the road so neighbouring rows agree
  const span = Math.round(250 / route.step);
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  for (const s of [0, 1]) {
    for (let i = 0; i < n; i++) {
      let m = 1e6;
      for (let d = -span; d <= span; d += 2) m = Math.min(m, raw[s][(i + d + n) % n] + Math.abs(d) * route.step * 0.35);
      out[s][i] = m;
    }
  }
  limitCache.set(route, out);
  return out;
}

/** True if the terrain ribbon is folded over (inside-out) at sample i, offset off. */
function folded(route: Route, i: number, off: number) {
  const n = route.x.length;
  const j = (i + 2) % n;
  const hi = route.heading[i];
  const hj = route.heading[j];
  const dx = route.x[j] - Math.sin(hj) * off - (route.x[i] - Math.sin(hi) * off);
  const dz = route.z[j] + Math.cos(hj) * off - (route.z[i] + Math.cos(hi) * off);
  return dx * Math.cos(hi) + dz * Math.sin(hi) <= 0;
}

/** Clamp a lateral offset so scenery stays on visible (unfolded) terrain at sample i. */
export function clampOff(route: Route, i: number, off: number) {
  const lim = foldLimits(route)[off > 0 ? 1 : 0][i];
  let o = Math.abs(off) > lim ? Math.sign(off) * lim : off;
  while (Math.abs(o) > 12 && folded(route, i, o)) o *= 0.85;
  return o;
}

/**
 * Fit one row of column offsets inside the fold limits (≈ the local turning radius on each
 * side). Rather than clamping every column past the limit onto the same point, which leaves
 * zero-width slivers that turn into spikes where the limit changes from row to row, the
 * columns beyond the road edge are compressed proportionally so they stay evenly spread
 * and in order. Rows already inside their limits are left untouched.
 */
export function squeezeRow(offs: ArrayLike<number> & { [k: number]: number }, cols: number, limNeg: number, limPos: number) {
  for (const sign of [-1, 1]) {
    const lim = sign > 0 ? limPos : limNeg;
    let max = 0;
    for (let c = 0; c < cols; c++) if (Math.sign(offs[c]) === sign) max = Math.max(max, Math.abs(offs[c]));
    if (max <= lim) continue;
    const base = Math.min(EDGE, lim);
    const k = max > base ? (lim - base) / (max - base) : 0;
    for (let c = 0; c < cols; c++) {
      const a = Math.abs(offs[c]);
      if (Math.sign(offs[c]) !== sign || a <= base) continue;
      offs[c] = sign * (base + (a - base) * k);
    }
  }
}

/** Terrain ribbons beside the road, split into ~1 km chunks for frustum culling. */
export function buildTerrainMesh(route: Route, model: TerrainModel, rowStep = 2): THREE.Group {
  const n = route.x.length;
  const limits = foldLimits(route);
  const cols = model.cols;
  const rows = Math.ceil(n / rowStep);
  const chunkRows = Math.max(8, Math.round(1000 / (route.step * rowStep)));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: model.map ?? null, flatShading: model.flatShading ?? false });
  const g = new THREE.Group();
  const tmp = new THREE.Color();
  const uvo: [number, number] = [0, 0];
  const p = new THREE.Vector3();
  const rowOffs = new Float64Array(cols);
  for (let r0 = 0; r0 < rows; r0 += chunkRows) {
    const r1 = Math.min(rows, r0 + chunkRows); // inclusive end row (row `rows` wraps to sample 0)
    const nr = r1 - r0 + 1;
    const pos = new Float32Array(nr * cols * 3);
    const col = new Float32Array(nr * cols * 3);
    const uv = new Float32Array(nr * cols * 2);
    const idx: number[] = [];
    for (let rr = 0; rr < nr; rr++) {
      const i = ((r0 + rr) * rowStep) % n;
      for (let c = 0; c < cols; c++) rowOffs[c] = model.colOff(i, c);
      squeezeRow(rowOffs, cols, limits[0][i], limits[1][i]);
      for (let c = 0; c < cols; c++) {
        const off = rowOffs[c];
        const dy = model.height(i, off);
        worldAt(route, i, off, dy, p);
        const o = (rr * cols + c) * 3;
        pos[o] = p.x;
        pos[o + 1] = p.y;
        pos[o + 2] = p.z;
        model.color(i, off, dy, tmp);
        col[o] = tmp.r;
        col[o + 1] = tmp.g;
        col[o + 2] = tmp.b;
        if (model.uv) model.uv(i, off, dy, p.x, p.z, uvo);
        else {
          uvo[0] = p.x / 7;
          uvo[1] = p.z / 7;
        }
        uv[(rr * cols + c) * 2] = uvo[0];
        uv[(rr * cols + c) * 2 + 1] = uvo[1];
      }
      if (rr < nr - 1) {
        for (let c = 0; c < cols - 1; c++) {
          if (c === model.roadCol) continue;
          const a = rr * cols + c;
          const b = a + cols;
          idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

/** Column offsets from a list of one-sided magnitudes (ascending, first = EDGE): mirrored to both sides. */
export function mirroredColumns(mags: number[]): { offs: number[]; roadCol: number } {
  const offs = [...mags.map((m) => -m).reverse(), ...mags];
  return { offs, roadCol: mags.length - 1 };
}

// ---------------------------------------------------------------------------
// Instancing
// ---------------------------------------------------------------------------
export interface Inst {
  i: number; // route sample (for chunking)
  m: THREE.Matrix4;
  c?: THREE.Color;
}

/** InstancedMeshes split by route position (~800 m chunks) so chunks out of view are culled. */
export function chunkedInstances(
  route: Route,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: Inst[],
  opts: { shadow?: boolean; receive?: boolean; chunkM?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  const per = Math.max(1, Math.round((opts.chunkM ?? 800) / route.step));
  const buckets = new Map<number, Inst[]>();
  for (const it of items) {
    const k = Math.floor(it.i / per);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(it);
  }
  const withColor = items.some((it) => it.c);
  for (const b of buckets.values()) {
    const m = new THREE.InstancedMesh(geo, mat, b.length);
    b.forEach((it, k) => {
      m.setMatrixAt(k, it.m);
      if (withColor) m.setColorAt(k, it.c ?? new THREE.Color(1, 1, 1));
    });
    m.castShadow = opts.shadow ?? true;
    m.receiveShadow = opts.receive ?? false;
    m.computeBoundingSphere();
    g.add(m);
  }
  return g;
}

/**
 * Per-frame view hook: `WorldView` calls `object.userData.onView(camera)` once per frame
 * (before any render pass) for every object in the world that carries one.
 */
export type ViewHook = (camera: THREE.Camera) => void;

export interface LodLevel {
  /** null: not drawn at all at this distance */
  geo: THREE.BufferGeometry | null;
  /** instances closer than this (m, from the camera) use this level; the last level takes the rest */
  upTo: number;
  /** cast shadows (keep it to near levels: the sun's shadow box only reaches a few tens of metres) */
  shadow?: boolean;
}

/**
 * Like `chunkedInstances`, but each instance picks a detail level by its distance from the
 * camera. Chunks stay put (so whole chunks are still frustum-culled); each chunk holds one
 * InstancedMesh per level, and instances are moved between them as the camera passes. The split
 * is recomputed every few metres of camera travel, with a little hysteresis so trees on a
 * boundary don't flicker between levels.
 */
export function lodInstances(
  route: Route,
  levels: LodLevel[],
  mat: THREE.Material,
  items: Inst[],
  opts: { receive?: boolean; chunkM?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  const per = Math.max(1, Math.round((opts.chunkM ?? 800) / route.step));
  const buckets = new Map<number, Inst[]>();
  for (const it of items) {
    const k = Math.floor(it.i / per);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(it);
  }
  const withColor = items.some((it) => it.c);
  const last = levels.length - 1;
  const HYST = 1.08;
  const STEP = 4; // m of camera travel between re-splits
  const geos = levels.flatMap((l) => (l.geo ? [l.geo] : []));
  for (const geo of geos) if (!geo.boundingSphere) geo.computeBoundingSphere();
  const geoR = Math.max(...geos.map((geo) => geo.boundingSphere!.radius));
  const c0 = geos[0].boundingSphere!.center;

  interface Chunk {
    items: Inst[];
    pos: Float32Array; // instance centres (world)
    level: Int8Array; // current level per instance (-1 = unassigned)
    meshes: (THREE.InstancedMesh | null)[];
    centre: THREE.Vector3;
    radius: number;
    allLast: boolean;
  }
  const chunks: Chunk[] = [];
  const v = new THREE.Vector3();
  for (const b of buckets.values()) {
    const pos = new Float32Array(b.length * 3);
    const box = new THREE.Box3();
    b.forEach((it, k) => {
      v.copy(c0).applyMatrix4(it.m);
      v.toArray(pos, k * 3);
      box.expandByPoint(v);
    });
    const centre = box.getCenter(new THREE.Vector3());
    let radius = 0;
    for (let k = 0; k < b.length; k++) radius = Math.max(radius, v.fromArray(pos, k * 3).distanceTo(centre));
    const meshes = levels.map((l) => {
      if (!l.geo) return null;
      const m = new THREE.InstancedMesh(l.geo, mat, b.length);
      m.count = 0;
      m.visible = false;
      m.castShadow = !!l.shadow;
      m.receiveShadow = opts.receive ?? false;
      g.add(m);
      return m;
    });
    chunks.push({ items: b, pos, level: new Int8Array(b.length).fill(-1), meshes, centre, radius: radius + geoR, allLast: false });
  }

  const fill = (ch: Chunk) => {
    const n = ch.meshes.map(() => 0);
    ch.items.forEach((it, k) => {
      const L = ch.level[k];
      const m = ch.meshes[L];
      if (!m) return;
      m.setMatrixAt(n[L], it.m);
      if (withColor) m.setColorAt(n[L], it.c ?? new THREE.Color(1, 1, 1));
      n[L]++;
    });
    ch.meshes.forEach((m, L) => {
      if (!m) return;
      m.count = n[L];
      m.visible = n[L] > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      if (n[L] > 0) m.computeBoundingSphere();
    });
  };

  const lastCam = new THREE.Vector3(Infinity, 0, 0);
  const cam = new THREE.Vector3();
  const farEdge = levels[Math.max(0, last - 1)].upTo * HYST;
  const onView: ViewHook = (camera) => {
    camera.getWorldPosition(cam);
    if (cam.distanceToSquared(lastCam) < STEP * STEP) return;
    lastCam.copy(cam);
    for (const ch of chunks) {
      if (last === 0 || ch.centre.distanceTo(cam) - ch.radius > farEdge) {
        // the whole chunk is beyond every boundary: everything at the last level
        if (ch.allLast) continue;
        ch.level.fill(last);
        ch.allLast = true;
        fill(ch);
        continue;
      }
      let changed = false;
      let allLast = true;
      for (let k = 0; k < ch.items.length; k++) {
        const d = v.fromArray(ch.pos, k * 3).distanceTo(cam);
        let L = 0;
        while (L < last && d >= levels[L].upTo) L++;
        const cur = ch.level[k];
        if (cur >= 0 && L > cur && d < levels[cur].upTo * HYST) L = cur; // hold a finer level a little longer
        if (L !== cur) {
          ch.level[k] = L;
          changed = true;
        }
        if (L !== last) allLast = false;
      }
      ch.allLast = allLast;
      if (changed) fill(ch);
    }
  };
  g.userData.onView = onView;
  return g;
}

/** Merge built-in geometries (position/normal/uv); mixes of indexed and non-indexed are flattened. */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const mixed = geos.some((g) => !g.index);
  const out = mergeGeometries(mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos, false);
  if (!out) throw new Error('merge failed');
  return out;
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
/** Matrix for a unit box (centred) stretched from a to b, with given thickness (y) and width (z, along `side`). */
export function beamMatrix(a: THREE.Vector3, b: THREE.Vector3, thick: number, width: number, side: THREE.Vector3) {
  _x.subVectors(b, a);
  const len = _x.length();
  _x.normalize();
  _z.copy(side).addScaledVector(_x, -side.dot(_x)).normalize();
  _y.crossVectors(_z, _x).normalize();
  const m = new THREE.Matrix4().makeBasis(_x, _y, _z);
  m.scale(new THREE.Vector3(len, thick, width));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  return m;
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------
/** Asphalt tile (12 m) with edge lines and a configurable centre line. */
export function roadTex(opts: { base: string; speck: (r: () => number) => string; worn: string; centre: 'double-yellow' | 'dashed-yellow' | 'dashed-white' }) {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = opts.base;
    g.fillRect(0, 0, 256, 512);
    const r = rng(42);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = opts.speck(r);
      g.fillRect(r() * 256, r() * 512, 1.6, 1.6);
    }
    g.fillStyle = opts.worn;
    for (const x of [52, 84, 172, 204]) g.fillRect(x, 0, 18, 512);
    g.fillStyle = '#ececec';
    g.fillRect(8, 0, 7, 512);
    g.fillRect(241, 0, 7, 512);
    if (opts.centre === 'double-yellow') {
      g.fillStyle = '#e8b622';
      g.fillRect(119, 0, 6, 512);
      g.fillRect(131, 0, 6, 512);
    } else {
      g.fillStyle = opts.centre === 'dashed-yellow' ? '#e8b622' : '#ececec';
      g.fillRect(125, 0, 6, 200);
    }
  });
}

/** Neutral speckled detail texture (multiplied with vertex colours). */
export function detailTex(seed: number, strokes: (g: CanvasRenderingContext2D, r: () => number) => void) {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, 256, 256);
    strokes(g, rng(seed));
  });
}

/** Soft radial blob (for foam rings, light pools, etc.). */
export function radialTex(inner: string, outer: string) {
  return canvasTex(
    128,
    128,
    (g) => {
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, inner);
      gr.addColorStop(1, outer);
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    },
    false,
  );
}

/** Random nudge of ±amount/2 metres ALONG the road at sample i (never sideways onto it). */
export function jitterAlong(p: { x: number; z: number }, route: { heading: ArrayLike<number> }, i: number, amount: number, r: () => number) {
  const along = (r() - 0.5) * amount;
  p.x += Math.cos(route.heading[i]) * along;
  p.z += Math.sin(route.heading[i]) * along;
}
