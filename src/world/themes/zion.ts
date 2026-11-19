// Zion: a red-asphalt road along a sandy canyon floor beside a green river.
// On both sides talus slopes lead to sheer, stratified sandstone walls - deep red
// lower cliffs, a scrubby ledge, then a towering upper face fading from orange to
// cream - topped by rounded slickrock domes. Cottonwoods line the river.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  buildTerrainMesh,
  clampOff,
  canvasTex,
  chunkedInstances,
  lapWave,
  lerp,
  loopInfo,
  merge,
  rng,
  roadTex,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
  jitterAlong,
} from './common';
import type { ThemeBuildOptions } from './index';
import { windy } from '../fx';

export function zionRoad() {
  return roadTex({
    base: '#8a4535',
    speck: (r) => {
      const v = r();
      return `rgb(${Math.round(110 + v * 70)},${Math.round(52 + v * 40)},${Math.round(40 + v * 30)})`;
    },
    worn: 'rgba(60,20,15,0.16)',
    centre: 'double-yellow',
  });
}

interface WallProfile {
  W: number; // distance from the road to the foot of the lower cliff
  talus: number; // height of the talus slope
  low: number; // height of the top of the lower cliff (relative to road)
  ledge: number; // ledge width
  top: number; // height of the rim
}

export function buildZion(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const r = rng(route.seed * 37 + 29);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);
  const riverSide = -L.inward; // the river runs on the outside of the loop
  const riverOff = (i: number) => 21 + 6 * lapWave(route, i, 0.8, 0.4);
  const RIVER_HALF = 3.2;

  const prof = (i: number, side: number): WallProfile => {
    const s = side > 0 ? 0 : 3.1;
    const W = 150 + 150 * Math.pow(w01(i, 0.45, 0.7 + s), 1.5) + 50 * w01(i, 1.6, 2.2 + s);
    const low = 32 + 40 * w01(i, 0.7, 1.9 + s);
    return {
      W,
      talus: 16 + 10 * w01(i, 2.1, s),
      low,
      ledge: 10 + 45 * w01(i, 0.55, 4.1 + s),
      top: low + 120 + 170 * w01(i, 0.38, 0.2 + s) + 40 * w01(i, 2.3, 1.1 + s),
    };
  };
  const cache = new Map<number, [WallProfile, WallProfile]>();
  const P = (i: number, side: number) => {
    let v = cache.get(i);
    if (!v) cache.set(i, (v = [prof(i, -1), prof(i, 1)]));
    return side < 0 ? v[0] : v[1];
  };

  /** Canyon floor height (relative), without walls. */
  const floorH = (i: number, off: number) => {
    const a = Math.abs(off);
    if (a < EDGE + 0.8) return -0.12;
    let dy = -0.12 + smooth(EDGE + 0.8, 12, a) * 0.5 + Math.sin(i * 0.09 + off * 0.15) * 0.35 * smooth(8, 20, a);
    dy += Math.max(0, a - 15) * 0.03;
    if (Math.sign(off) === riverSide) {
      const d = Math.abs(a - riverOff(i));
      dy -= 2.4 * (1 - smooth(RIVER_HALF - 0.6, RIVER_HALF + 3, d)); // river channel
    }
    return dy;
  };

  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    const pr = P(i, Math.sign(off) || 1);
    const t0 = pr.W - 32; // start of the talus
    if (a < t0) return floorH(i, off);
    const base = floorH(i, Math.sign(off) * t0);
    if (a < pr.W) return base + pr.talus * Math.pow((a - t0) / 32, 1.7);
    const footY = base + pr.talus;
    if (a < pr.W + 2.5) return lerp(footY, pr.low, (a - pr.W) / 2.5); // lower cliff
    const ledgeEnd = pr.W + 2.5 + pr.ledge;
    if (a < ledgeEnd) return pr.low + ((a - pr.W - 2.5) / pr.ledge) * 9; // ledge (rubble slope)
    if (a < ledgeEnd + 4) return lerp(pr.low + 9, pr.top, (a - ledgeEnd) / 4); // upper cliff
    // rim: rounded slickrock domes, then the plateau
    const u = a - ledgeEnd - 4;
    return pr.top + smooth(0, 50, u) * (25 + 35 * w01(i, 3.1, Math.sign(off))) + Math.sin(i * 0.04 + u * 0.03) * 18 * smooth(30, 90, u);
  };

  // Columns per side: floor near the road (with river banks on the river side), then
  // anchored to this row's wall profile so the cliffs stay sheer.
  const sideCols = (i: number, side: number): number[] => {
    const pr = P(i, side);
    const t0 = pr.W - 32;
    const cols = [EDGE, EDGE + 0.8, 8, 11];
    if (side === riverSide) {
      const ro = riverOff(i);
      cols.push(ro - RIVER_HALF - 3, ro - RIVER_HALF - 0.4, ro - RIVER_HALF + 0.8, ro, ro + RIVER_HALF - 0.8, ro + RIVER_HALF + 0.4, ro + RIVER_HALF + 3);
      const last = ro + RIVER_HALF + 3;
      for (let k = 1; k <= 4; k++) cols.push(lerp(last, t0, k / 5));
    } else for (let k = 1; k <= 11; k++) cols.push(lerp(11, t0, k / 12));
    const le = pr.W + 2.5 + pr.ledge;
    cols.push(t0, t0 + 12, t0 + 22, t0 + 28, pr.W, pr.W + 2.5, pr.W + 2.5 + pr.ledge * 0.5, le, le + 4, le + 20, le + 50, le + 110, le + 220, le + 400);
    return cols;
  };
  const PER = 4 + 11 + 14;
  const colCache = new Map<number, [number[], number[]]>();
  const colOff = (i: number, c: number) => {
    let v = colCache.get(i);
    if (!v) colCache.set(i, (v = [sideCols(i, -1), sideCols(i, 1)]));
    return c < PER ? -v[0][PER - 1 - c] : v[1][c - PER];
  };

  // strata texture: v follows a piecewise height mapping (see uv below), u runs along the road
  const strata = canvasTex(512, 1024, (g) => {
    const H = 1024;
    const y = (v: number) => (1 - v) * H;
    const band = (v0: number, v1: number, c: string) => {
      g.fillStyle = c;
      g.fillRect(0, y(v1), 512, y(v0) - y(v1) + 1);
    };
    band(0, 0.05, '#efe7da'); // floor & talus: neutral (vertex colours carry the sand tones)
    // lower cliffs: deep reds with thin pale beds
    const reds = ['#b04e31', '#bf5c36', '#a2452f', '#c96d41', '#b55636', '#9e4834', '#c4653c'];
    const rr = rng(4);
    let v = 0.05;
    let k = 0;
    while (v < 0.4) {
      const dv = 0.015 + rr() * 0.04;
      band(v, Math.min(0.4, v + dv), reds[k++ % reds.length]);
      if (rr() < 0.5) band(v + dv - 0.003, v + dv, '#d39a7a');
      v += dv;
    }
    band(0.4, 0.425, '#9b6a48'); // ledge
    // upper wall: orange-red → salmon → pink → cream → white top
    const stops: [number, string][] = [
      [0.425, '#b8532f'],
      [0.55, '#c86a3c'],
      [0.66, '#d98c5e'],
      [0.76, '#e6b08a'],
      [0.85, '#eed2b4'],
      [0.95, '#f3e6d4'],
      [1.0, '#f1e3cf'],
    ];
    const gr = g.createLinearGradient(0, y(0.425), 0, y(1));
    for (const [sv, c] of stops) gr.addColorStop((sv - 0.425) / (1 - 0.425), c);
    g.fillStyle = gr;
    g.fillRect(0, 0, 512, y(0.425));
    // cross-bedding lines in the upper wall
    for (let i = 0; i < 70; i++) {
      const vv = 0.43 + rr() * 0.52;
      g.strokeStyle = `rgba(120,60,40,${0.06 + rr() * 0.1})`;
      g.lineWidth = 1 + rr() * 2;
      g.beginPath();
      const x0 = rr() * 512;
      g.moveTo(x0, y(vv));
      g.lineTo(x0 + 80 + rr() * 200, y(vv) + (rr() - 0.5) * 18);
      g.stroke();
    }
    // desert varnish: dark vertical streaks below the rims
    for (let i = 0; i < 90; i++) {
      const x = rr() * 512;
      const vTop = rr() < 0.5 ? 0.38 : 0.92;
      const len = 0.06 + rr() * 0.25;
      const gv = g.createLinearGradient(0, y(vTop), 0, y(vTop - len));
      gv.addColorStop(0, `rgba(55,30,25,${0.25 + rr() * 0.3})`);
      gv.addColorStop(1, 'rgba(55,30,25,0)');
      g.fillStyle = gv;
      g.fillRect(x, y(vTop), 2 + rr() * 9, y(vTop - len) - y(vTop));
    }
    // speckle
    for (let i = 0; i < 20000; i++) {
      const vv = 0.05 + rr() * 0.95;
      g.fillStyle = `rgba(${rr() < 0.5 ? '255,240,220' : '70,35,25'},${0.05 + rr() * 0.08})`;
      g.fillRect(rr() * 512, y(vv), 2, 2);
    }
  });
  strata.wrapT = THREE.ClampToEdgeWrapping;

  const sand = new THREE.Color('#d9b089');
  const sandR = new THREE.Color('#c98d63');
  const sage = new THREE.Color('#8f9568');
  const grass = new THREE.Color('#6e8a3e');
  const riverbed = new THREE.Color('#7d6a52');
  const talusC = new THREE.Color('#c27b55');
  const white = new THREE.Color('#ffffff');
  const ledgeC = new THREE.Color('#b9a27a');
  const verge = new THREE.Color('#b9876a');
  const model: TerrainModel = {
    cols: PER * 2,
    roadCol: PER - 1,
    colOff,
    height,
    flatShading: true,
    map: strata,
    color(i, off, dy, out) {
      const a = Math.abs(off);
      const side = Math.sign(off) || 1;
      const pr = P(i, side);
      if (a >= pr.W + 0.01) {
        const le = pr.W + 2.5 + pr.ledge;
        if (a > pr.W + 2.4 && a < le + 0.1) out.copy(ledgeC);
        else out.copy(white);
        return;
      }
      const t = 0.5 + 0.5 * Math.sin(i * 0.029 + off * 0.07);
      out.copy(sand).lerp(sandR, t * 0.7);
      const patch = 0.5 + 0.5 * Math.sin(i * 0.019 + Math.floor(off / 25) * 1.9);
      out.lerp(sage, smooth(0.5, 0.9, patch) * 0.55);
      const fine = Math.sin(i * 0.37 + off * 0.53) * Math.sin(i * 0.11 - off * 0.29);
      out.multiplyScalar(0.93 + 0.1 * fine);
      if (side === riverSide) {
        const d = Math.abs(a - riverOff(i));
        out.lerp(grass, (1 - smooth(RIVER_HALF + 1, RIVER_HALF + 9, d)) * 0.8);
        if (d < RIVER_HALF - 0.3) out.copy(riverbed);
      }
      if (a > pr.W - 32) out.lerp(talusC, smooth(pr.W - 32, pr.W - 20, a));
      if (a < EDGE + 0.8) out.copy(verge);
      void dy;
    },
    uv(i, off, dy, _x, _z, o) {
      const pr = P(i, Math.sign(off) || 1);
      const a = Math.abs(off);
      o[0] = (i * route.step) / 260;
      if (a < pr.W - 32) {
        o[0] = (i * route.step) / 9;
        o[1] = 0.025; // floor: inside the neutral band
        return;
      }
      const base = height(i, Math.sign(off) * (pr.W - 32));
      const foot = base + pr.talus;
      const h = dy;
      let v: number;
      if (h <= foot) v = 0.05 * Math.max(0, (h - base) / pr.talus);
      else if (h <= pr.low) v = lerp(0.05, 0.4, (h - foot) / (pr.low - foot));
      else if (h <= pr.low + 9 && a < pr.W + 2.5 + pr.ledge + 0.1) v = lerp(0.4, 0.425, (h - pr.low) / 9);
      else if (h <= pr.top) v = lerp(0.425, 0.95, (h - pr.low - 9) / (pr.top - pr.low - 9));
      else v = 0.95 + Math.min(0.05, (h - pr.top) / 2000);
      o[1] = v;
    },
  };
  const out: THREE.Object3D[] = [buildTerrainMesh(route, model)];

  // --- river surface
  {
    const rows = Math.ceil(n / 2) + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    for (let k = 0; k < rows; k++) {
      const i = (k * 2) % n;
      const ro = riverOff(i);
      for (let s = 0; s < 2; s++) {
        const a = ro + (s === 0 ? -RIVER_HALF - 0.2 : RIVER_HALF + 0.2);
        worldAt(route, i, riverSide * a, floorH(i, riverSide * (ro - RIVER_HALF - 2)) - 1.0, p);
        const o = (k * 2 + s) * 3;
        pos.set([p.x, p.y, p.z], o);
        uv[(k * 2 + s) * 2] = s;
        uv[(k * 2 + s) * 2 + 1] = (k * 2 * route.step) / 30;
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
    const ripple = canvasTex(64, 256, (g) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 64, 256);
      const rr = rng(8);
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `rgb(${200 + rr() * 55},${215 + rr() * 40},${210 + rr() * 45})`;
        g.fillRect(rr() * 64, rr() * 256, 4 + rr() * 12, 1 + rr() * 2);
      }
    });
    const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: '#4d7a68', specular: '#cfe3e0', shininess: 60, map: ripple, side: THREE.DoubleSide }));
    m.receiveShadow = true;
    out.push(m);
  }

  // --- vegetation and boulders
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const density = opts.high ? 1 : 0.5;
  const cottonwoods: Inst[] = [];
  const cwTrunks: Inst[] = [];
  const junipers: Inst[] = [];
  const brush: Inst[] = [];
  const boulders: Inst[] = [];
  const rimTrees: Inst[] = [];
  const spot = (i: number, off0: number, sink = 0.25) => {
    const off = clampOff(route, i, off0);
    return worldAt(route, i, off, height(i, off) - sink);
  };
  for (let i = 0; i < n; i += 2) {
    const ro = riverOff(i);
    // cottonwoods along the river
    for (const bank of [-1, 1]) {
      if (r() < 0.32 * density) {
        const a = ro + bank * (RIVER_HALF + 2.5 + r() * 9);
        if (a < EDGE + 3) continue;
        const p = spot(i, riverSide * a);
        jitterAlong(p, route, i, 6, r);
        const s = 0.8 + r() * 0.8;
        const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.85 + r() * 0.35), s));
        cottonwoods.push({ i, m, c: new THREE.Color().setHSL(0.2 + r() * 0.06, 0.45, 0.25 + r() * 0.1) });
        cwTrunks.push({ i, m });
      }
    }
    for (const bank of [-1, 1]) {
      if (r() < 0.6 * density) {
        const a = ro + bank * (RIVER_HALF + 0.3 + r() * 2.5);
        if (a > EDGE + 2) {
          const p = spot(i, riverSide * a, 0.3);
          jitterAlong(p, route, i, 8, r);
          const s = 0.6 + r() * 0.8;
          brush.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6), new THREE.Vector3(s * 1.6, s * 1.3, s * 1.6)), c: new THREE.Color().setHSL(0.2 + r() * 0.07, 0.4, 0.24 + r() * 0.08) });
        }
      }
    }
    for (const side of [-1, 1]) {
      const pr = P(i, side);
      // sagebrush / rabbitbrush across the floor and talus
      const nb = 1.3 * density;
      let k = Math.floor(nb) + (r() < nb % 1 ? 1 : 0);
      while (k-- > 0) {
        const a = EDGE + 1.5 + r() * (pr.W - EDGE - 4);
        if (side === riverSide && Math.abs(a - ro) < RIVER_HALF + 1) continue;
        const p = spot(i, side * a, 0.1);
        jitterAlong(p, route, i, 6, r);
        const s = 0.3 + r() * 0.5;
        brush.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6), new THREE.Vector3(s * 1.4, s, s * 1.4)), c: new THREE.Color().setHSL(0.17 + r() * 0.08, 0.16 + r() * 0.14, 0.3 + r() * 0.1) });
      }
      // junipers / pinyons dotted on the floor, talus and ledges
      if (r() < 0.22 * density) {
        const zone = r();
        let a: number;
        if (zone < 0.55) a = EDGE + 6 + r() * (pr.W - EDGE - 8);
        else if (zone < 0.85) a = pr.W + 3 + r() * Math.max(1, pr.ledge - 2);
        else a = pr.W + 2.5 + pr.ledge + 8 + r() * 120;
        if (!(side === riverSide && Math.abs(a - ro) < RIVER_HALF + 2)) {
          const p = spot(i, side * a);
          const s = 0.6 + r() * 0.7;
          const item = { i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.8 + r() * 0.5), s)), c: new THREE.Color().setHSL(0.24 + r() * 0.06, 0.25, 0.2 + r() * 0.08) };
          (zone < 0.85 ? junipers : rimTrees).push(item);
        }
      }
      // boulders fallen from the walls (mostly on the talus)
      if (r() < 0.25 * density) {
        const a = r() < 0.75 ? pr.W - 30 + r() * 30 : EDGE + 4 + r() * (pr.W - 40);
        if (!(side === riverSide && Math.abs(a - ro) < RIVER_HALF + 1)) {
          const p = spot(i, side * a, 0.4);
          const s = 0.6 + Math.pow(r(), 2) * 5;
          boulders.push({ i, m: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s, s * 0.7, s)), c: new THREE.Color().setHSL(0.04 + r() * 0.03, 0.45, 0.35 + r() * 0.12) });
        }
      }
    }
  }
  const cwGeo = merge([
    new THREE.IcosahedronGeometry(3.4, 0).scale(1.25, 0.85, 1.15).translate(0, 8.5, 0),
    new THREE.IcosahedronGeometry(2.6, 0).scale(1.2, 0.8, 1).translate(2.6, 7.4, 1.2),
    new THREE.IcosahedronGeometry(2.4, 0).scale(1.1, 0.8, 1.1).translate(-2.4, 7.0, -1.0),
    new THREE.IcosahedronGeometry(2.0, 0).translate(0.5, 10.6, -0.4),
  ]);
  out.push(chunkedInstances(route, new THREE.CylinderGeometry(0.3, 0.55, 7.5, 6, 1, true).translate(0, 3.75, 0), new THREE.MeshLambertMaterial({ color: '#7a6a58' }), cwTrunks));
  out.push(chunkedInstances(route, cwGeo, windy(new THREE.MeshLambertMaterial({ flatShading: true }), 11, 0.32), cottonwoods));
  const juniperGeo = merge([
    new THREE.CylinderGeometry(0.15, 0.25, 1.4, 5, 1, true).translate(0, 0.7, 0),
    new THREE.IcosahedronGeometry(1.5, 0).scale(1, 1.25, 1).translate(0, 2.4, 0),
    new THREE.IcosahedronGeometry(1.0, 0).translate(0.8, 3.4, 0.3),
  ]);
  const junMat = windy(new THREE.MeshLambertMaterial({ flatShading: true }), 4, 0.08);
  out.push(chunkedInstances(route, juniperGeo, junMat, junipers));
  out.push(chunkedInstances(route, juniperGeo, junMat, rimTrees, { shadow: false }));
  out.push(chunkedInstances(route, new THREE.IcosahedronGeometry(1, 0).scale(1, 0.65, 1).translate(0, 0.35, 0), windy(new THREE.MeshLambertMaterial({ flatShading: true }), 0.8, 0.06), brush, { shadow: false }));
  out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), boulders, { shadow: true, receive: true }));
  return out;
}
