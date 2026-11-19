// Iceland highlands: a dusty gravel-and-asphalt road across a vast, quiet volcanic
// plateau. Rhyolite hills and mountains are painted in noise-warped bands of rust,
// ochre, sulphur, cream and teal, streaked with dark scree and capped with old snow.
// Black lava fields wear lumpy cushions of bright moss; a braided glacial river of
// milky-blue channels and gravel bars wanders across the valley floor; geothermal
// vents breathe white steam over yellow-and-orange sulphur crusts. Glaciers and
// snowy peaks line the horizon.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clampOff,
  clamp01,
  jitterAlong,
  lapWave,
  loopDelta,
  loopInfo,
  merge,
  mirroredColumns,
  rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { fxBuild, fxSurge, fxTime, windy } from '../fx';

export const ICELAND_SUN = { elevation: 27, azimuth: 205 };
const HAZE = '#c4ccd0';

// ---------------------------------------------------------------------------
// Road: dark, dusty asphalt with gravel shoulders and only a ghost of a centre line
// ---------------------------------------------------------------------------
export function icelandRoad() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#4b4845';
    g.fillRect(0, 0, 256, 512);
    const r = rng(77);
    // patched, uneven surface
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '30,29,28' : '110,100,90'},${0.05 + r() * 0.08})`;
      g.fillRect(20 + r() * 200, r() * 512, 20 + r() * 60, 10 + r() * 50);
    }
    for (let i = 0; i < 9000; i++) {
      const v = r();
      const c = v < 0.7 ? 58 + r() * 26 : v < 0.95 ? 84 + r() * 24 : 110 + r() * 25;
      g.fillStyle = `rgba(${c + 6},${c + 2},${c - 4},0.8)`;
      g.fillRect(r() * 256, r() * 512, 1 + r() * 0.8, 1 + r() * 0.8);
    }
    // wheel tracks: slightly darker and smoother
    g.fillStyle = 'rgba(25,24,24,0.16)';
    for (const x of [54, 86, 152, 184]) g.fillRect(x, 0, 20, 512);
    // dust blown in from the shoulders
    for (const [x0, dir] of [
      [0, 1],
      [256, -1],
    ] as const) {
      const gr = g.createLinearGradient(x0, 0, x0 + dir * 48, 0);
      gr.addColorStop(0, 'rgba(150,138,118,0.85)');
      gr.addColorStop(0.35, 'rgba(140,128,110,0.4)');
      gr.addColorStop(1, 'rgba(140,128,110,0)');
      g.fillStyle = gr;
      g.fillRect(dir > 0 ? 0 : 208, 0, 48, 512);
    }
    // loose gravel on the shoulders
    for (let i = 0; i < 2200; i++) {
      const side = r() < 0.5;
      const x = side ? Math.pow(r(), 2) * 40 : 256 - Math.pow(r(), 2) * 40;
      const c = 90 + r() * 60;
      g.fillStyle = `rgb(${c},${c - 6},${c - 14})`;
      g.fillRect(x, r() * 512, 1.5 + r() * 2, 1.5 + r() * 2);
    }
    // faded centre dashes
    g.fillStyle = 'rgba(225,215,185,0.09)';
    g.fillRect(125, 0, 6, 190);
  });
}

// ---------------------------------------------------------------------------
// Periodic value noise (seamless around the lap)
// ---------------------------------------------------------------------------
function hash2(x: number, y: number, seed: number) {
  let t = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) | 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}
function vnoise(u: number, v: number, P: number, seed: number) {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  let fu = u - iu;
  let fv = v - iv;
  fu = fu * fu * (3 - 2 * fu);
  fv = fv * fv * (3 - 2 * fv);
  const u0 = ((iu % P) + P) % P;
  const u1 = (u0 + 1) % P;
  const a = hash2(u0, iv, seed);
  const b = hash2(u1, iv, seed);
  const c = hash2(u0, iv + 1, seed);
  const d = hash2(u1, iv + 1, seed);
  return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
}

/** Palette for the painted rhyolite bands (cycled through by height + warp). */
const BAND_COUNT = 12;
const BANDS = ['#ad5030', '#c9823e', '#d4b052', '#cbb894', '#b5835a', '#78977f', '#9c452e', '#cca066', '#5f8473', '#c0623a', '#c4ad86', '#86685a'].map((c) => new THREE.Color(c));

export function buildIceland(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const step = route.step;
  const r = rng(route.seed * 61 + 7);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);
  const riverSide = -L.inward as 1 | -1; // the glacial river braids across the outside of the loop
  const density = opts.high ? 1 : 0.5;

  /** fbm noise at sample i, signed offset off, with a feature size in metres (periodic along the lap). */
  const N = (i: number, off: number, cell: number, seed: number, oct = 3) => {
    const P0 = Math.max(1, Math.round(route.length / cell));
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      const P = P0 << o;
      sum += amp * vnoise((i / n) * P, (off / cell) * (1 << o), P, seed + o * 31);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };

  // --- per-sample profile (cached): river valley + hill line
  interface Prof {
    rise: number; // how high the road is above the valley
    D: number; // valley floor depth relative to the road (river side)
    rc: number; // river centre offset
    rw: number; // braid-plain half width
    a0: [number, number]; // hill foot offset per side (neg, pos)
    M: [number, number]; // mountain height per side
    lava: number; // 0..1 lava field
  }
  const profCache: Prof[] = new Array(n);
  const prof = (i: number): Prof => {
    let p = profCache[i];
    if (p) return p;
    const rise = Math.min(130, route.y[i] - L.minY);
    const D = -3.5 - 0.5 * rise;
    const rc = 82 + 26 * lapWave(route, i, 0.5, 0.9) + 0.9 * rise;
    const rw = 32 + 16 * w01(i, 0.9, 2.4);
    const a0: [number, number] = [0, 0];
    const M: [number, number] = [0, 0];
    for (const s of [-1, 1] as const) {
      const k = s < 0 ? 0 : 1;
      const big = Math.pow(N(i, s * 5000, 1600, 11 + k, 2), 1.3);
      if (s === riverSide) {
        a0[k] = rc + rw + 14;
        M[k] = 70 + 260 * big; // across the valley: lower, so the glaciers peek over
      } else {
        a0[k] = 26 + 40 * w01(i, 0.6, 1.7 + k);
        M[k] = 140 + 380 * big;
      }
    }
    const lava = smooth(0.15, 0.5, 0.6 * lapWave(route, i, 0.35, 1.1) + 0.4 * lapWave(route, i, 1.3, 2.0));
    p = { rise, D, rc, rw, a0, M, lava };
    profCache[i] = p;
    return p;
  };

  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    if (a < EDGE + 0.8) return -0.12;
    const side = off < 0 ? -1 : 1;
    const k = side < 0 ? 0 : 1;
    const P = prof(i);
    const a0 = P.a0[k];
    let dy = -0.12 - smooth(EDGE + 0.8, EDGE + 3, a) * 0.3;
    // hummocky ground and lava lumps near the road
    const near = 1 - smooth(a0 - 5, a0 + 40, a);
    dy += (N(i, off, 55, 3) - 0.5) * 4 * smooth(7, 30, a) * near;
    dy += P.lava * (N(i, off, 16, 5, 2) - 0.35) * 2.4 * smooth(EDGE + 2, 11, a) * near;
    if (side === riverSide) {
      const bank0 = 12;
      const plain0 = P.rc - P.rw;
      if (a < P.rc + P.rw) {
        dy += P.D * smooth(bank0, plain0, a);
        if (a > plain0 - 4) dy += (N(i, off, 22, 9, 2) - 0.5) * 0.7; // gravel bars
        return dy;
      }
      dy += P.D;
    }
    // hills and rhyolite mountains
    const t = smooth(a0, a0 + 460 + 160 * N(i, off, 700, 13, 1), a);
    const ridged = 1 - Math.abs(2 * N(i, off, 230, 17, 2) - 1);
    dy += P.M[k] * t * (0.55 + 0.45 * ridged);
    dy += 38 * smooth(a0, a0 + 70, a) * N(i, off, 110, 19, 2);
    dy += Math.max(0, a - a0) * 0.02;
    return dy;
  };

  // --- geothermal vents (placed before colouring: they stain the ground)
  interface Vent {
    i: number;
    off: number;
    p: THREE.Vector3;
    s: number; // strength
  }
  const vents: Vent[] = [];
  {
    const K = 9;
    for (let c = 0; c < K; c++) {
      const ic = Math.floor(((c + 0.2 + r() * 0.6) / K) * n);
      const P = prof(ic);
      let side: number = r() < 0.6 ? -riverSide : riverSide;
      let a: number;
      if (side === riverSide) a = P.a0[side < 0 ? 0 : 1] + 10 + r() * 90;
      else a = 22 + r() * 120;
      if (c === 1) {
        side = -riverSide; // one field close by the road, so it is seen up close
        a = 17 + r() * 6;
      }
      const cnt = 2 + Math.floor(r() * 4);
      for (let v = 0; v < cnt; v++) {
        const i = (ic + Math.round((r() - 0.5) * (24 / step)) + n) % n;
        const off = clampOff(route, i, side * Math.max(14, a + (r() - 0.5) * 22));
        vents.push({ i, off, p: worldAt(route, i, off, height(i, off) - 0.2), s: 0.6 + r() * 0.8 });
      }
    }
  }
  /** Sulphur staining 0..1 around vents (and which tint). */
  const stain = (i: number, off: number): [number, number] => {
    let best = 0;
    let tint = 0;
    for (const v of vents) {
      const da = loopDelta(i, v.i, n) * step;
      if (Math.abs(da) > 60) continue;
      const d = Math.hypot(da, off - v.off);
      const R = 16 + 14 * v.s;
      const s = 1 - smooth(R * 0.25, R, d + (N(i, off, 6, 41, 2) - 0.5) * 10);
      if (s > best) {
        best = s;
        tint = d / R;
      }
    }
    return [best, tint];
  };

  // --- colours
  const C = (h: string) => new THREE.Color(h);
  const gravel = C('#6c665f');
  const grass = C('#76734a');
  const grassPale = C('#a09a70');
  const lavaRock = C('#29292b');
  const moss = C('#647449');
  const mossPale = C('#959b74');
  const plain = C('#8e8b85');
  const wetGravel = C('#6a6c6c');
  const scree = C('#35343a');
  const screeWarm = C('#4a3f3a');
  const snow = C('#f3f5f7');
  const greenSlope = C('#6c8a4a');
  const sulphur = C('#d9be48');
  const orange = C('#d27a2c');
  const crust = C('#efe8d2');
  const shoulder = C('#857a6a');
  const tmp = C('#000');
  const tmp2 = C('#000');

  // per-vertex band coordinate + weight, handed from color() to uv() (called right after it)
  let bandT = 0;
  let bandW = 0;
  const white = C('#ffffff');
  const bandAvg = C('#9a7a5c'); // what the painted bands average to (blends overlays in without whitening)
  // per-vertex massif tint for the bands, in the exact order buildTerrainMesh visits vertices
  const tints: number[] = [];
  const bandTint = C('#ffffff');

  const model: TerrainModel = {
    ...(() => {
      const mags = [EDGE, EDGE + 0.8, 6.5, 9, 12, 16, 21, 27, 34, 42, 51, 61, 72, 84, 97, 111, 126, 142, 158, 175, 193, 212, 232, 254, 278, 304, 332, 362, 395, 430, 468, 510, 556, 606, 662, 724, 794, 874, 966, 1072, 1194, 1330];
      const { offs, roadCol } = mirroredColumns(mags);
      return { cols: offs.length, roadCol, colOff: (_i: number, c: number) => offs[c] };
    })(),
    height,
    map: bandTexture(),
    color(i, off, dy, out) {
      const a = Math.abs(off);
      const side = off < 0 ? -1 : 1;
      const k = side < 0 ? 0 : 1;
      const P = prof(i);
      const a0 = P.a0[k];
      // slope from finite differences
      const ip = (i + 2) % n;
      const da = Math.max(3, a * 0.06);
      const sx = (height(i, off + side * da) - height(i, off - side * da)) / (2 * da);
      const sz = (height(ip, off) - dy) / (2 * step);
      const slope = Math.hypot(sx, sz);
      // --- near ground: volcanic gravel, grass, lava + moss
      out.copy(gravel).lerp(grass, smooth(0.5, 0.75, N(i, off, 40, 21)) * 0.75);
      out.lerp(grassPale, smooth(0.55, 0.8, N(i, off, 13, 22, 2)) * 0.5);
      if (P.lava > 0.01) {
        const mo = N(i, off, 9, 23, 2);
        tmp.copy(lavaRock).lerp(moss, smooth(0.5, 0.72, mo) * 0.85).lerp(mossPale, smooth(0.7, 0.85, mo) * 0.5);
        out.lerp(tmp, P.lava * smooth(EDGE + 1, EDGE + 4, a) * (1 - smooth(a0, a0 + 30, a)));
      }
      // --- river plain
      if (side === riverSide && a < P.rc + P.rw + 10) {
        const plainT = smooth(P.rc - P.rw - 10, P.rc - P.rw + 2, a) * (1 - smooth(P.rc + P.rw, P.rc + P.rw + 10, a));
        tmp.copy(plain).lerp(wetGravel, smooth(0.4, 0.6, N(i, off, 18, 25, 2)) * 0.6);
        out.lerp(tmp, plainT);
      }
      // --- rhyolite hills
      const hill = smooth(a0 - 6, a0 + 50, a);
      bandW = 0;
      bandTint.copy(white);
      if (hill > 0) {
        const rel = dy - (side === riverSide ? P.D : 0);
        const warp = 2.4 * N(i, off, 280, 31) + 0.8 * N(i, off, 110, 32, 2);
        bandT = rel / 34 + warp * 1.3 + Math.floor(N(i, off, 900, 33, 1) * 3) * 4;
        // the bands themselves are painted per pixel (bandTexture); vertex colours carry a
        // massif tint: cooler teal/grey-green or warmer rust
        const cool = smooth(0.45, 0.7, N(i, off, 600, 35, 2));
        bandTint.copy(white).lerp(tmp2.set('#b4d6ca'), cool * 0.4).lerp(tmp2.set('#ffd9bf'), (1 - cool) * smooth(0.5, 0.8, N(i, off, 450, 34)) * 0.5);
        bandTint.multiplyScalar(0.9 + 0.2 * N(i, off, 70, 44, 2));
        // vertex colour = what covers the bands (moss, scree, snow), starting from their average tone
        tmp.copy(bandAvg);
        let w = 1;
        // soft green moss on the gentle lower slopes
        const gm = (1 - smooth(0.25, 0.5, slope)) * (1 - smooth(10, 60, rel)) * smooth(0.4, 0.65, N(i, off, 60, 36)) * 0.75;
        tmp.lerp(greenSlope, gm);
        w *= 1 - gm;
        // dark scree fans streaking down the steep faces
        const streak = vnoise((i / n) * Math.round(route.length / 22), off / 200, Math.round(route.length / 22), 37);
        const sc = smooth(0.35, 0.75, slope) * smooth(0.42, 0.68, streak + 0.25 * N(i, off, 90, 38));
        tmp.lerp(N(i, off, 300, 39) > 0.5 ? scree : screeWarm, sc * 0.9);
        w *= 1 - sc * 0.9;
        // old snow on the summits
        const snowLine = 235 + 80 * N(i, off, 400, 40);
        const sn = smooth(snowLine, snowLine + 30, rel) * smooth(0.3, 0.55, N(i, off, 50, 41, 2) + 0.25 - slope * 0.3);
        tmp.lerp(snow, sn);
        w *= 1 - sn;
        out.lerp(tmp, hill);
        bandW = w * hill;
      }
      // --- sulphur staining around vents
      const [st, tint] = stain(i, off);
      if (st > 0) {
        tmp.copy(crust).lerp(sulphur, smooth(0.1, 0.45, tint)).lerp(orange, smooth(0.5, 0.9, tint));
        out.lerp(tmp, st * 0.8);
        bandW *= 1 - st;
      }
      // painterly brightness variation
      out.multiplyScalar(0.92 + 0.14 * N(i, off, 20, 43, 2));
      if (a < EDGE + 0.85) out.copy(shoulder);
      tints.push(bandTint.r, bandTint.g, bandTint.b);
    },
    uv(_i, _off, _dy, _x, _z, o) {
      o[0] = bandT;
      o[1] = bandW;
    },
  };
  const terrain = buildTerrainMesh(route, model);
  paintTerrain(terrain, tints);
  const out: THREE.Object3D[] = [terrain];

  out.push(buildRiver(route, prof, riverSide, height));
  out.push(buildSteam(vents, opts.high));
  out.push(buildDistantPeaks(route), buildOvercast(route));

  // --- scattered life and rocks
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const spot = (i: number, off0: number, sink = 0.1) => {
    const off = clampOff(route, i, off0);
    return worldAt(route, i, off, height(i, off) - sink);
  };
  const onRiver = (i: number, off: number) => {
    if (Math.sign(off) !== riverSide) return false;
    const P = prof(i);
    return Math.abs(Math.abs(off) - P.rc) < P.rw + 3;
  };
  const tufts: Inst[] = [];
  const rocks: Inst[] = [];
  const mossCaps: Inst[] = [];
  const crustBits: Inst[] = [];
  const stones: Inst[] = [];
  for (let i = 0; i < n; i += 2) {
    const P = prof(i);
    for (const side of [-1, 1]) {
      const a0 = P.a0[side < 0 ? 0 : 1];
      // grass tufts (fewer in the lava)
      const nt = (3.4 - 2.2 * P.lava) * density;
      let k = Math.floor(nt) + (r() < nt % 1 ? 1 : 0);
      while (k-- > 0) {
        const a = EDGE + 1.2 + Math.pow(r(), 2.2) * (a0 + 40 - EDGE);
        const off = side * a;
        if (onRiver(i, off)) continue;
        const p = spot(i, off, 0.05);
        jitterAlong(p, route, i, 10, r);
        const s = 0.7 + r() * 1.0;
        tufts.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.7 + r() * 0.6), s)), c: new THREE.Color().setHSL(0.13 + r() * 0.07, 0.3 + r() * 0.2, 0.36 + r() * 0.14) });
      }
      // lava blocks with moss cushions
      const nr = P.lava * 2.4 * density;
      k = Math.floor(nr) + (r() < nr % 1 ? 1 : 0);
      while (k-- > 0) {
        const a = EDGE + 2 + Math.pow(r(), 2) * (a0 + 20 - EDGE);
        const off = side * a;
        if (onRiver(i, off)) continue;
        const p = spot(i, off, 0.35);
        jitterAlong(p, route, i, 10, r);
        const s = 0.25 + Math.pow(r(), 3) * 1.3;
        const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, r() * 6.3, (r() - 0.5) * 0.5)), new THREE.Vector3(s * (1 + r() * 0.6), s * (0.5 + r() * 0.35), s * (1 + r() * 0.5)));
        if (r() < 0.25) rocks.push({ i, m, c: new THREE.Color().setHSL(0.08, 0.05, 0.12 + r() * 0.06) });
        else mossCaps.push({ i, m, c: new THREE.Color().setHSL(0.15 + r() * 0.08, 0.2 + r() * 0.2, 0.75 + r() * 0.25) });
      }
      // scattered boulders on the hills
      if (r() < 0.12 * density) {
        const a = a0 + r() * 220;
        const p = spot(i, side * a, 0.4);
        const s = 0.8 + Math.pow(r(), 2) * 4;
        rocks.push({ i, m: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s, s * 0.7, s)), c: new THREE.Color().setHSL(0.06, 0.08, 0.2 + r() * 0.1) });
      }
    }
  }
  // sulphur crust mounds around the vents
  for (const v of vents) {
    const cnt = Math.round((10 + 10 * v.s) * (opts.high ? 1 : 0.6));
    for (let k = 0; k < cnt; k++) {
      const ang = r() * 6.3;
      const d = Math.pow(r(), 0.8) * (6 + 8 * v.s);
      const off = v.off + Math.sin(ang) * d;
      const i = (v.i + Math.round((Math.cos(ang) * d) / step) + n) % n;
      if (Math.abs(off) < EDGE + 1) continue;
      const p = spot(i, off, 0.15);
      const s = 0.3 + r() * 0.9;
      const tint = d / (6 + 8 * v.s) + (r() - 0.5) * 0.3;
      const c = tint < 0.3 ? crust.clone() : tint < 0.7 ? sulphur.clone() : orange.clone();
      crustBits.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6), new THREE.Vector3(s * 1.4, s * 0.35, s * 1.2)), c: c.multiplyScalar(0.85 + r() * 0.2) });
    }
  }
  // cairns along the road
  for (let c = 0; c < 14; c++) {
    const i = Math.floor(((c + r()) / 14) * n);
    const side = r() < 0.5 ? -1 : 1;
    const off = side * (7.5 + r() * 4);
    if (onRiver(i, off)) continue;
    const p = spot(i, off, 0.15);
    let y = 0;
    const layers = 4 + Math.floor(r() * 3);
    for (let l = 0; l < layers; l++) {
      const s = 0.55 * (1 - l / (layers + 1.5)) + r() * 0.08;
      const pos = p.clone().add(new THREE.Vector3((r() - 0.5) * 0.12, y + s * 0.45, (r() - 0.5) * 0.12));
      stones.push({ i, m: new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(new THREE.Euler(r(), r() * 6, r())), new THREE.Vector3(s, s * 0.75, s)), c: new THREE.Color().setHSL(0.08, 0.05, 0.36 + r() * 0.12) });
      y += s * 0.85;
    }
  }

  const tuftGeo = merge(
    Array.from({ length: 7 }, (_, k) => {
      const ang = (k / 7) * Math.PI * 2;
      const lean = 0.25 + (k % 3) * 0.12;
      return new THREE.ConeGeometry(0.06, 0.55 + (k % 3) * 0.15, 3, 1, true)
        .translate(0, 0.3, 0)
        .rotateZ(Math.cos(ang) * lean)
        .rotateX(Math.sin(ang) * lean)
        .translate(Math.cos(ang) * 0.08, 0, Math.sin(ang) * 0.08);
    }),
  );
  out.push(chunkedInstances(route, tuftGeo, windy(new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), 0.7, 0.14), tufts, { shadow: false }));
  const rockGeo = lumpy(new THREE.IcosahedronGeometry(1, 1), 0.28, 5).translate(0, 0.3, 0);
  const mossyGeo = mossy(lumpy(new THREE.IcosahedronGeometry(1, 1), 0.26, 6).translate(0, 0.3, 0));
  out.push(chunkedInstances(route, rockGeo, new THREE.MeshLambertMaterial({ flatShading: true }), rocks, { shadow: true, receive: true }));
  out.push(chunkedInstances(route, mossyGeo, new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true }), mossCaps, { shadow: true, receive: true }));
  out.push(chunkedInstances(route, lumpy(new THREE.IcosahedronGeometry(1, 1), 0.3, 9), new THREE.MeshLambertMaterial({ flatShading: true }), crustBits, { shadow: false }));
  out.push(chunkedInstances(route, lumpy(new THREE.DodecahedronGeometry(1, 0), 0.15, 3), new THREE.MeshLambertMaterial({ flatShading: true }), stones, { shadow: true }));

  // a lone mountain hut
  {
    const i = Math.floor(n * 0.37);
    const side = -riverSide;
    const off = clampOff(route, i, side * (prof(i).a0[side < 0 ? 0 : 1] * 0.55 + 12));
    const p = worldAt(route, i, off, height(i, off));
    const hut = new THREE.Group();
    const wallMat = new THREE.MeshLambertMaterial({ color: '#e9e5da' });
    const walls = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 4.4).translate(0, 0.9, 0), wallMat);
    const tri = new THREE.Shape([new THREE.Vector2(-2.2, 0), new THREE.Vector2(2.2, 0), new THREE.Vector2(0, 1.9)]);
    const gable = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 6, bevelEnabled: false }).translate(0, 0, -3).rotateY(Math.PI / 2), wallMat);
    gable.position.y = 3.4;
    const roofMat = new THREE.MeshLambertMaterial({ color: '#a8352b' });
    const roofA = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.18, 3.2), roofMat);
    roofA.position.set(0, 4.4, 1.1);
    roofA.rotation.x = 0.71;
    const roofB = roofA.clone();
    roofB.position.z = -1.1;
    roofB.rotation.x = -0.71;
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.9, 0.1), new THREE.MeshLambertMaterial({ color: '#3b2f28' }));
    door.position.set(0.8, 1.35, 2.22);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.1), new THREE.MeshLambertMaterial({ color: '#2a3036' }));
    win.position.set(-1.6, 2.1, 2.22);
    hut.add(walls, gable, roofA, roofB, door, win);
    hut.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    hut.position.copy(p);
    hut.rotation.y = -route.heading[i] + (side > 0 ? 0 : Math.PI);
    out.push(hut);
  }
  return out;
}

/**
 * The rhyolite strata as a 1D strip (u = band coordinate / BAND_COUNT): flat bands of
 * colour with soft, ragged, painted edges and the odd thin pale or dark seam.
 */
function bandTexture() {
  const W = 2048;
  const t = canvasTex(W, 8, (g) => {
    const r = rng(12);
    const bw = W / BAND_COUNT;
    for (let k = 0; k <= BAND_COUNT; k++) {
      const c = BANDS[k % BAND_COUNT];
      g.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      g.fillRect(k * bw - 1, 0, bw + 2, 8);
    }
    // soft transitions between neighbours
    for (let k = 0; k < BAND_COUNT; k++) {
      const x = (k + 1) * bw;
      const a = BANDS[k];
      const b = BANDS[(k + 1) % BAND_COUNT];
      const w = 10 + r() * 50;
      const gr = g.createLinearGradient(x - w, 0, x + w * 0.4, 0);
      gr.addColorStop(0, `rgba(${Math.round(a.r * 255)},${Math.round(a.g * 255)},${Math.round(a.b * 255)},1)`);
      gr.addColorStop(1, `rgba(${Math.round(b.r * 255)},${Math.round(b.g * 255)},${Math.round(b.b * 255)},1)`);
      g.fillStyle = gr;
      g.fillRect(x - w, 0, w * 1.4, 8);
    }
    // thin seams and tonal wobble inside each band
    for (let k = 0; k < 24; k++) {
      const x = r() * W;
      g.fillStyle = r() < 0.6 ? `rgba(245,236,214,${0.1 + r() * 0.2})` : `rgba(70,50,40,${0.08 + r() * 0.15})`;
      g.fillRect(x, 0, 3 + r() * 10, 8);
    }
    for (let k = 0; k < 60; k++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,240,220' : '60,40,30'},${0.04 + r() * 0.08})`;
      g.fillRect(r() * W, 0, 20 + r() * 80, 8);
    }
  });
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

/** Ground grain (neutral, ~0.5 linear on average) for the terrain. */
function grainTexture() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#bcbcbc';
    g.fillRect(0, 0, 256, 256);
    const r = rng(23);
    for (let k = 0; k < 3200; k++) {
      g.fillStyle = r() < 0.5 ? `rgba(40,38,36,${0.15 + r() * 0.3})` : `rgba(255,252,245,${0.12 + r() * 0.25})`;
      const sz = 1 + r() * 3.5;
      g.fillRect(r() * 256, r() * 256, sz, sz * (0.6 + r() * 0.8));
    }
  });
}

/**
 * Terrain material patch: uv carries (band coordinate, band weight), so the strata are
 * painted per pixel from the band strip; a world-space grain texture adds ground detail.
 */
function paintTerrain(terrain: THREE.Group, tints: number[]) {
  const grain = grainTexture();
  let mat: THREE.MeshLambertMaterial | null = null;
  let t0 = 0;
  terrain.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    mat = m.material as THREE.MeshLambertMaterial;
    const pos = m.geometry.getAttribute('position');
    m.geometry.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(tints.slice(t0, t0 + pos.count * 3)), 3));
    t0 += pos.count * 3;
    const det = new Float32Array(pos.count * 2);
    for (let k = 0; k < pos.count; k++) {
      det[k * 2] = pos.getX(k) / 6;
      det[k * 2 + 1] = pos.getZ(k) / 6;
    }
    m.geometry.setAttribute('aDet', new THREE.BufferAttribute(det, 2));
  });
  if (!mat) return;
  const tm = mat as THREE.MeshLambertMaterial;
  tm.onBeforeCompile = (shader) => {
    shader.uniforms.grainMap = { value: grain };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aDet;\nattribute vec3 aTint;\nvarying vec2 vDet;\nvarying vec2 vBand;\nvarying vec3 vTint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDet = aDet;\nvBand = uv;\nvTint = aTint;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform sampler2D grainMap;
        varying vec2 vDet;
        varying vec2 vBand;
        varying vec3 vTint;
        float icH(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
        float icN(vec2 p){
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(icH(i), icH(i + vec2(1.0, 0.0)), u.x), mix(icH(i + vec2(0.0, 1.0)), icH(i + vec2(1.0, 1.0)), u.x), u.y);
        }`,
      )
      .replace('#include <map_fragment>', '')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          // erosion gullies: noise over the horizontal world position (constant down the
          // fall line) nudges the strata up and down and shades the runnels, so the bands
          // break into vertical rills instead of smooth horizontal smears
          vec2 wp = vDet * 6.0; // world x/z in metres
          float g1 = icN(wp * vec2(0.11, 0.11));
          float g2 = icN(wp * vec2(0.37, 0.37) + 13.0);
          float g3 = icN(wp * vec2(1.3, 1.3) + 41.0);
          float gully = g1 * 0.5 + g2 * 0.35 + g3 * 0.15;
          float w = clamp(vBand.y, 0.0, 1.0);
          float t = vBand.x + (gully - 0.5) * 0.55;
          vec3 bandC = texture2D(map, vec2(t / ${BAND_COUNT.toFixed(1)}, 0.5)).rgb * vTint;
          bandC *= 0.78 + 0.32 * smoothstep(0.25, 0.75, g2 * 0.6 + g3 * 0.4); // dark runnels, matte ridges
          diffuseColor.rgb = mix(diffuseColor.rgb, bandC, w);
          float gr = texture2D(grainMap, vDet).r * 2.0;
          diffuseColor.rgb *= mix(1.0, gr, 0.8);
        }`,
      );
  };
  tm.customProgramCacheKey = () => 'iceland-terrain';
}

/** Vertex colours for a lava block: black rock with a cushion of moss over the top. */
function mossy(geo: THREE.BufferGeometry) {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const rock = new THREE.Color('#2b2a2b');
  const moss = new THREE.Color('#6d7d4f');
  const mossDeep = new THREE.Color('#4f5e36');
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    const key = Math.round(pos.getX(k) * 1000) * 7 + Math.round(pos.getY(k) * 1000) * 131 + Math.round(pos.getZ(k) * 1000) * 1031;
    const h = hash2(key, 1, 17);
    const up = nor.getY(k) + (h - 0.5) * 0.5 + pos.getY(k) * 0.4;
    c.copy(mossDeep).lerp(moss, h).lerp(rock, 1 - smooth(0.05, 0.35, up));
    col.set([c.r, c.g, c.b], k * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Randomly displace a polyhedron's vertices (consistently for shared corners), for lumpy rocks. */
function lumpy(geo: THREE.BufferGeometry, amt: number, seed: number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k);
    const key = Math.round(v.x * 1000) * 7 + Math.round(v.y * 1000) * 131 + Math.round(v.z * 1000) * 1031;
    const f = 1 + (hash2(key, 0, seed) - 0.5) * 2 * amt;
    pos.setXYZ(k, v.x * f, v.y * f * (v.y < 0 ? 0.6 : 1), v.z * f);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Braided glacial river: milky-blue channels painted into an alpha texture on a
// ribbon over the gravel plain
// ---------------------------------------------------------------------------
type ProfFn = (i: number) => { D: number; rc: number; rw: number };
function buildRiver(route: Route, prof: ProfFn, riverSide: number, height: (i: number, off: number) => number): THREE.Object3D {
  const n = route.x.length;
  const TILE = 260; // metres per texture repeat along the river
  const cycles = Math.max(1, Math.round(route.length / TILE));
  const tex = canvasTex(256, 1024, (g) => {
    const r = rng(19);
    const W = 256;
    const H = 1024;
    for (let ch = 0; ch < 7; ch++) {
      const c0 = 0.12 + r() * 0.76;
      const A = [r() * 0.22, r() * 0.12, r() * 0.06];
      const ph = [r() * 6.3, r() * 6.3, r() * 6.3];
      const w0 = 5 + r() * 11;
      const wPh = r() * 6.3;
      const steps = 220;
      const pts: [number, number, number][] = [];
      for (let s = 0; s <= steps; s++) {
        const v = s / steps;
        let x = c0;
        for (let h = 0; h < 3; h++) x += A[h] * Math.sin(2 * Math.PI * (h + 1) * v + ph[h]);
        x = 0.04 + 0.92 * clamp01(x);
        const w = w0 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 2 * v + wPh)) + 1.5;
        pts.push([x * W, v * H, w]);
      }
      // shallow, paler halo then the deeper milky channel
      for (const [grow, col] of [
        [2.0, 'rgba(176,196,196,0.5)'],
        [1.0, 'rgba(164,196,204,1)'],
        [0.45, 'rgba(140,182,196,1)'],
      ] as const) {
        g.strokeStyle = col;
        g.lineCap = 'round';
        for (let s = 0; s < steps; s++) {
          g.lineWidth = pts[s][2] * grow;
          g.beginPath();
          g.moveTo(pts[s][0], pts[s][1]);
          g.lineTo(pts[s + 1][0], pts[s + 1][1]);
          g.stroke();
        }
      }
    }
    // sparkle / ripples
    for (let k = 0; k < 900; k++) {
      g.fillStyle = 'rgba(230,242,245,0.35)';
      const x = r() * W;
      const y = r() * H;
      const d = g.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
      if (d[3] > 200) g.fillRect(x, y, 3 + r() * 6, 1);
    }
  });
  const rows = Math.ceil(n / 2) + 1;
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (let k = 0; k < rows; k++) {
    const i = (k * 2) % n;
    const P = prof(i);
    for (let s = 0; s < 2; s++) {
      const a = P.rc + (s === 0 ? -P.rw - 4 : P.rw + 4);
      const off = clampOff(route, i, riverSide * a);
      // a hair above the plain's mean level, so gravel bars break the surface
      void height;
      worldAt(route, i, off, P.D - 0.12 + 0.02, p);
      pos.set([p.x, p.y, p.z], (k * 2 + s) * 3);
      uv[(k * 2 + s) * 2] = riverSide > 0 ? s : 1 - s;
      uv[(k * 2 + s) * 2 + 1] = ((k * 2) / n) * cycles;
    }
    if (k < rows - 1) {
      const a = k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshPhongMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    specular: '#5d6a70',
    shininess: 30,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------
// Steam: instanced soft billboards rising, swelling and fading (all in the shader)
// ---------------------------------------------------------------------------
function puffTexture() {
  return canvasTex(
    128,
    128,
    (g) => {
      const r = rng(5);
      for (let k = 0; k < 14; k++) {
        const ang = r() * 6.3;
        const d = r() * 22;
        const x = 64 + Math.cos(ang) * d;
        const y = 64 + Math.sin(ang) * d;
        const rad = 16 + r() * 24;
        const gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'rgba(255,255,255,0.4)');
        gr.addColorStop(0.5, 'rgba(255,255,255,0.18)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 128, 128);
      }
    },
    false,
  );
}

function buildSteam(vents: { p: THREE.Vector3; s: number }[], high: boolean): THREE.Object3D {
  const per = high ? 18 : 9;
  const count = vents.length * per;
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const aBase = new Float32Array(count * 3);
  const aSeed = new Float32Array(count * 2);
  const r = rng(99);
  let k = 0;
  for (const v of vents) {
    for (let j = 0; j < per; j++) {
      aBase.set([v.p.x + (r() - 0.5) * 1.5, v.p.y, v.p.z + (r() - 0.5) * 1.5], k * 3);
      aSeed[k * 2] = j / per + r() * 0.08; // phase: puffs evenly spread through the cycle
      aSeed[k * 2 + 1] = v.s;
      k++;
    }
  }
  geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(aBase, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 2));
  geo.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        map: { value: null },
        lit: { value: new THREE.Color(1.45, 1.45, 1.42) },
        shade: { value: new THREE.Color(0.9, 0.95, 1.0) },
      },
    ]),
    vertexShader: /* glsl */ `
      uniform float fxTime, fxBuild, fxSurge;
      attribute vec3 aBase;
      attribute vec2 aSeed;
      varying vec2 vUv;
      varying float vA;
      varying float vT;
      #include <fog_pars_vertex>
      void main() {
        float sp = 0.045 + 0.02 * fract(aSeed.x * 7.13);
        float t = fract(fxTime * sp + aSeed.x);
        // the vents roar as a hard effort builds: taller, bigger, denser plumes
        float boost = fxBuild + 0.6 * fxSurge;
        float str = aSeed.y + 0.9 * boost;
        // rise, lean downwind and swell
        vec3 c = aBase;
        c.y += t * (16.0 + 18.0 * str) + 0.5;
        c.x += t * t * 11.0 + sin(fxTime * 0.4 + aSeed.x * 20.0) * t * 2.0;
        c.z += t * t * 4.0;
        float size = mix(2.4, 12.0 + 8.0 * str, pow(t, 0.6));
        float ang = aSeed.x * 31.0 + t * 0.8;
        vec2 q = vec2(cos(ang) * position.x - sin(ang) * position.y, sin(ang) * position.x + cos(ang) * position.y);
        vec4 mvPosition = viewMatrix * vec4(c, 1.0);
        mvPosition.xy += q * size;
        gl_Position = projectionMatrix * mvPosition;
        vUv = uv;
        vT = t;
        vA = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.25, 1.0, t)) * (0.2 + 0.18 * str) * (1.0 + 0.5 * boost);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 lit;
      uniform vec3 shade;
      varying vec2 vUv;
      varying float vA;
      varying float vT;
      #include <fog_pars_fragment>
      void main() {
        vec4 tx = texture2D(map, vUv);
        float a = tx.a * vA;
        if (a < 0.004) discard;
        vec3 col = mix(shade, lit, smoothstep(0.1, 0.9, vUv.y));
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  mat.uniforms.map.value = puffTexture();
  mat.uniforms.fxTime = fxTime;
  mat.uniforms.fxBuild = fxBuild;
  mat.uniforms.fxSurge = fxSurge;
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 4;
  return m;
}

// ---------------------------------------------------------------------------
// A thin, high overcast: long soft grey-white streaks (the shared cumulus sit above)
// ---------------------------------------------------------------------------
function buildOvercast(route: Route): THREE.Object3D {
  const L = loopInfo(route);
  const r = rng(route.seed + 808);
  const tex = canvasTex(
    256,
    64,
    (g) => {
      for (let k = 0; k < 26; k++) {
        const x = 96 + r() * 64;
        const y = 30 + r() * 4;
        const rx = 24 + r() * 60;
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        gr.addColorStop(0, 'rgba(255,255,255,0.35)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.save();
        g.translate(x, y);
        g.scale(rx, 8 + r() * 12);
        g.fillStyle = gr;
        g.beginPath();
        g.arc(0, 0, 1, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    },
    false,
  );
  const g = new THREE.Group();
  for (let k = 0; k < 34; k++) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5 + r() * 0.35, fog: false, depthWrite: false, color: new THREE.Color().setScalar(0.86 + r() * 0.1) });
    const sp = new THREE.Sprite(mat);
    const a = r() * Math.PI * 2;
    const d = 600 + r() * 5200;
    sp.position.set(L.cx + Math.cos(a) * d, L.maxY + 380 + r() * 380, L.cz + Math.sin(a) * d);
    const sc = 900 + r() * 1500;
    sp.scale.set(sc * 2.6, sc * 0.45, 1);
    g.add(sp);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Horizon: ice caps and snowy peaks in a hazy ring around the course
// ---------------------------------------------------------------------------
function buildDistantPeaks(route: Route): THREE.Object3D {
  const L = loopInfo(route);
  let R = 0;
  for (let i = 0; i < L.n; i++) R = Math.max(R, Math.hypot(route.x[i] - L.cx, route.z[i] - L.cz));
  const r = rng(route.seed + 404);
  const haze = new THREE.Color(HAZE);
  const rock = new THREE.Color('#3f464e');
  const snowC = new THREE.Color('#eef2f6');
  const ice = new THREE.Color('#dde9ef');
  const geos: THREE.BufferGeometry[] = [];
  const addColors = (geo: THREE.BufferGeometry, h: number, kind: 'peak' | 'cap', hazeAmt: number, snowLine: number) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pos = g.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const y = pos.getY(k) / h; // 0 at base, 1 at top
      if (kind === 'cap') c.copy(ice).lerp(snowC, smooth(0.15, 0.7, y));
      else {
        const line = snowLine + 0.14 * (hash2(Math.round(pos.getX(k) * 10), Math.round(pos.getZ(k) * 10), 3) - 0.5);
        c.copy(rock).lerp(snowC, smooth(line - 0.03, line + 0.03, y));
      }
      c.lerp(haze, hazeAmt * (1 - 0.45 * y));
      col.set([c.r, c.g, c.b], k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const count = 24;
  for (let k = 0; k < count; k++) {
    const ang = (k / count) * Math.PI * 2 + r() * 0.15;
    const d = R + 1700 + r() * 2000;
    const hazeAmt = 0.3 + 0.28 * clamp01((d - R - 1700) / 2000);
    const x = L.cx + Math.cos(ang) * d;
    const z = L.cz + Math.sin(ang) * d;
    const y0 = L.minY - 40;
    if (r() < 0.35) {
      // broad ice cap
      const w = 1000 + r() * 1400;
      const h = 160 + r() * 200;
      const geo = new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(w, h, w * (0.45 + r() * 0.35));
      const g = addColors(geo, h, 'cap', hazeAmt, 0);
      g.rotateY(r() * 6.3).translate(x, y0, z);
      geos.push(g);
    } else {
      // a massif: a main summit with a few lower shoulders, concave flanks, snow on top
      const snowLine = 0.3 + r() * 0.22;
      const parts = 2 + Math.floor(r() * 3);
      const W0 = 420 + r() * 520;
      const H0 = Math.min(W0 * (0.6 + r() * 0.45), 640);
      const tx = -Math.sin(ang);
      const tz = Math.cos(ang);
      for (let q = 0; q < parts; q++) {
        const main = q === 0;
        const w = main ? W0 : W0 * (0.45 + r() * 0.4);
        const h = main ? H0 : H0 * (0.45 + r() * 0.35);
        const along = main ? 0 : (r() < 0.5 ? -1 : 1) * W0 * (0.5 + r() * 0.7);
        const geo = new THREE.ConeGeometry(w, h, 18, 7).translate(0, h / 2, 0);
        const p = geo.getAttribute('position');
        const ph = r() * 6.3;
        const lobes = 2 + Math.floor(r() * 3) + 0.5;
        const lean = (r() - 0.5) * 0.7 * w; // summits sit off-centre: one steep face, one long ridge
        for (let v = 0; v < p.count; v++) {
          const yy = p.getY(v);
          if (yy > h - 1) continue;
          const u = 1 - yy / h;
          const a2 = Math.atan2(p.getZ(v), p.getX(v));
          const ridge = Math.pow(Math.abs(Math.sin(a2 * lobes + ph)), 0.7) * 0.4 + 0.6;
          const f = Math.pow(u, 0.2) * ridge * (1 + (hash2(Math.round(p.getX(v)), Math.round(p.getZ(v) + yy), 8) - 0.5) * 0.3);
          p.setXYZ(v, p.getX(v) * f + lean * (yy / h), yy, p.getZ(v) * f);
        }
        const g = addColors(geo, H0, 'peak', hazeAmt, snowLine);
        g.rotateY(r() * 6.3).translate(x + tx * along, y0, z + tz * along);
        geos.push(g);
      }
    }
  }
  const all = merge(geos);
  all.computeVertexNormals();
  const m = new THREE.Mesh(all, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false }));
  m.renderOrder = -4;
  return m;
}
