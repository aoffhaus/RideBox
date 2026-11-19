// Big Sur: a road notched into a steep coastal hillside. Inland, golden grass and
// coastal scrub climb to high ridges dotted with oaks; seaward, a grassy shoulder
// ends at rocky cliffs dropping to a blue Pacific with foam, coves and sea stacks.
// Concrete arch bridges carry the road over the deepest gullies.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  ROAD_HALF,
  beamMatrix,
  buildTerrainMesh,
  clampOff,
  canvasTex,
  chunkedInstances,
  clamp01,
  detailTex,
  lapWave,
  loopDelta,
  loopInfo,
  merge,
  radialTex,
  rng,
  roadTex,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { windy } from '../fx';

export function bigSurRoad() {
  return roadTex({
    base: '#46484c',
    speck: (r) => {
      const v = 48 + r() * 50;
      return `rgb(${v},${v},${v + 2})`;
    },
    worn: 'rgba(20,20,22,0.18)',
    centre: 'double-yellow',
  });
}

interface Gully {
  c: number; // centre sample
  depth: number; // m below the road at the centre
  bridge: boolean;
}

export function buildBigSur(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const step = route.step;
  const sea = L.minY - 42; // absolute sea level: the lowest point of the road is still 42 m up
  const land = L.inward; // the sea lies outside the loop, the hills inside
  const r = rng(route.seed * 53 + 17);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);
  const above = (i: number) => route.y[i] - sea; // road height above the sea

  // --- gullies: a few creeks cut down from the ridges to coves; the deepest on straight road get bridges
  const gullies: Gully[] = [];
  const nG = 5;
  for (let k = 0; k < nG; k++) {
    const base = Math.floor(((k + 0.15 + r() * 0.7) / nG) * n);
    // look nearby for the straightest stretch (bridges need it)
    let best = base;
    let bestScore = Infinity;
    const span = Math.round(60 / step);
    for (let d = -Math.round(400 / step); d <= Math.round(400 / step); d += 4) {
      const c = (base + d + n) % n;
      let turn = 0;
      for (let s = -span; s < span; s++) {
        let dh = route.heading[(c + s + 1 + n) % n] - route.heading[(c + s + n) % n];
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        turn += Math.abs(dh);
      }
      const gr = Math.abs(route.y[(c + span) % n] - route.y[(c - span + n) % n]) / (2 * span * step);
      const score = turn + gr * 4;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const bridge = k % 2 === 0 && bestScore < 0.25;
    gullies.push({ c: bridge ? best : base, depth: 0, bridge });
  }
  for (const gl of gullies) gl.depth = gl.bridge ? Math.min(46, above(gl.c) - 6) : 30;

  /** Gully carve depth at sample i and lateral distance a (m). */
  const carve = (i: number, a: number, isLand: boolean) => {
    let c = 0;
    for (const gl of gullies) {
      const d = Math.abs(loopDelta(i, gl.c, n)) * step;
      const hw = (gl.bridge ? 46 : 30) + a * 0.32;
      if (d > hw) continue;
      const along = 1 - smooth(0, hw, d);
      let f = gl.bridge ? 1 : smooth(14, 40, a);
      if (isLand) f *= 1 - smooth(160, 400, a);
      c = Math.max(c, gl.depth * along * f);
    }
    return c;
  };

  // --- seaward profile parameters (vary along the coast)
  const headland = (i: number) => Math.max(0, 0.65 * lapWave(route, i, 1.1, 1.3) + 0.45 * lapWave(route, i, 0.45, 0.2) - 0.15);
  const terrace = (i: number) => 2 + 6 * w01(i, 2.3, 0.4) + 140 * Math.pow(headland(i), 2.2);
  const cliffW = (i: number) => 9 + 0.2 * above(i) + 10 * w01(i, 0.9, 2.2);

  const landH = (i: number, a: number) => {
    if (a < EDGE + 1) return Math.max(-0.12 - carve(i, a, true), -above(i) + 0.6);
    const w1 = w01(i, 0.7, 0.3);
    const w2 = w01(i, 0.31, 2.1);
    const w3 = w01(i, 1.9, 4.0);
    let dy = -0.12 + smooth(EDGE + 1, 13, a) * (1.5 + 3 * w3); // low cut bank
    const slope = 0.3 + 0.32 * w1;
    // steep lower slopes easing off towards a ridgeline (no hard edge where the terrain ends)
    const S = 240;
    dy += slope * S * (1 - Math.exp(-Math.max(0, a - 10) / S));
    dy += smooth(70, 330, a) * (15 + 50 * w2); // ridges
    dy += Math.sin(i * 0.031 + a * 0.021) * 7 * smooth(30, 120, a); // spurs
    return Math.max(dy - carve(i, a, true), -above(i) + 0.6);
  };

  const seaH = (i: number, a: number) => {
    if (a < EDGE + 1) return Math.max(-0.12 - carve(i, a, false), -above(i) - 5);
    const H = above(i);
    const T = terrace(i);
    const c0 = EDGE + 1 + T;
    const shoulderEnd = -0.12 - T * 0.07 - 0.6;
    let dy: number;
    if (a < c0) dy = -0.12 - (a - EDGE - 1) * 0.07 - smooth(EDGE + 1, EDGE + 4, a) * 0.6 + Math.sin(i * 0.07 + a * 0.2) * 0.25 * smooth(EDGE + 2, EDGE + 8, a);
    else {
      const W = cliffW(i);
      const t = clamp01((a - c0) / W);
      const bottom = -H - 5;
      dy = shoulderEnd + (bottom - shoulderEnd) * (1 - Math.pow(1 - t, 1.7));
      if (a > c0 + W) dy = bottom - Math.min(30, (a - c0 - W) * 0.12);
    }
    const seabed = -H - 5 - Math.min(30, Math.max(0, a - c0 - cliffW(i)) * 0.12);
    return Math.max(dy - carve(i, a, false), seabed);
  };

  const height = (i: number, off: number) => (off * land > 0 ? landH(i, Math.abs(off)) : seaH(i, Math.abs(off)));

  // Columns: land side fixed offsets; sea side anchored to the terrace / cliff of each row.
  const landMags = [EDGE, 6.5, 9, 13, 18, 25, 34, 46, 62, 82, 108, 140, 180, 230, 290, 350, 420];
  const seaRel = (i: number): number[] => {
    const T = terrace(i);
    const c0 = EDGE + 1 + T;
    const W = cliffW(i);
    return [EDGE, EDGE + 1, EDGE + 1 + T * 0.3, EDGE + 1 + T * 0.65, c0, c0 + W * 0.08, c0 + W * 0.2, c0 + W * 0.36, c0 + W * 0.55, c0 + W * 0.78, c0 + W, c0 + W + 25, c0 + W + 80, c0 + W + 200, c0 + W + 420];
  };
  const nS = 15;
  const nL = landMags.length;
  const cache = new Map<number, number[]>();
  const seaCols = (i: number) => {
    let v = cache.get(i);
    if (!v) cache.set(i, (v = seaRel(i)));
    return v;
  };
  // column order runs from negative offsets to positive ones
  const colOff = (i: number, c: number) => {
    if (land > 0) {
      // sea on the negative side
      if (c < nS) return -seaCols(i)[nS - 1 - c];
      return landMags[c - nS];
    }
    if (c < nL) return -landMags[nL - 1 - c];
    return seaCols(i)[c - nL];
  };

  const gold = new THREE.Color('#bfa15a');
  const straw = new THREE.Color('#cdb277');
  const green = new THREE.Color('#7f9447');
  const scrub = new THREE.Color('#4c5c30');
  const rock = new THREE.Color('#8b7e6c');
  const rockL = new THREE.Color('#a69882');
  const rockD = new THREE.Color('#5f564c');
  const sand = new THREE.Color('#d6c59c');
  const wet = new THREE.Color('#5f6a62');
  const verge = new THREE.Color('#8e8b5c');
  const iceplant = new THREE.Color('#7b7a3c');
  const model: TerrainModel = {
    cols: nS + nL,
    roadCol: land > 0 ? nS - 1 : nL - 1,
    colOff,
    height,
    color(i, off, dy, out) {
      const a = Math.abs(off);
      const isLand = off * land > 0;
      const H = above(i);
      const slope = Math.abs(height(i, off + 1.5) - height(i, off - 1.5)) / 3;
      const t = 0.5 + 0.5 * Math.sin(i * 0.023 + off * 0.045) * Math.cos(i * 0.011 - off * 0.02);
      out.copy(gold).lerp(straw, t * 0.6);
      // greener scrub patches, darker chaparral in gullies and on the steepest slopes
      const patch = 0.5 + 0.5 * Math.sin(i * 0.017 + Math.floor(off / 40) * 1.7);
      out.lerp(green, smooth(0.45, 0.85, patch) * 0.75);
      // big swathes of dark coastal scrub / chaparral on the hillsides
      const chap = 0.5 + 0.5 * Math.sin(i * 0.009 + off * 0.013 + 1.3) * Math.sin(i * 0.004 - off * 0.006);
      out.lerp(scrub, smooth(0.6, 0.85, chap) * 0.85);
      if (isLand) out.lerp(scrub, clamp01(carve(i, a, true) / 20) * 0.8 + smooth(0.75, 1.1, slope) * 0.3);
      if (slope > 1.0) out.lerp(isLand ? rock : rockL, smooth(1.0, 1.8, slope) * 0.9);
      if (!isLand) {
        const T = terrace(i);
        if (a > EDGE + 1 + T * 0.75 && a < EDGE + 2 + T) out.lerp(iceplant, 0.5);
        if (a > EDGE + 1.5 + T) {
          // craggy cliff face: grey-brown rock with darker bands
          const band = 0.5 + 0.5 * Math.sin(dy * 0.45 + i * 0.07) * Math.sin(i * 0.23 + dy * 0.1);
          out.copy(rock).lerp(rockL, band * 0.6).lerp(rockD, smooth(0.6, 1, Math.sin(i * 0.41 + dy * 0.3)) * 0.5);
        }
      }
      // beach / wet rock at the waterline, dark seabed below
      const h = dy + H;
      if (h < 3) out.lerp(sand, smooth(3, 0.5, h) * 0.8);
      if (h < 0) out.copy(wet);
      if (a < EDGE + 1) out.copy(verge);
    },
    map: detailTex(11, (g, rr) => {
      for (let i = 0; i < 15000; i++) {
        const v = 150 + rr() * 105;
        g.fillStyle = `rgb(${v},${v + 4},${v - 14})`;
        g.fillRect(rr() * 256, rr() * 256, 1 + rr() * 1.5, 2 + rr() * 4);
      }
    }),
  };

  const out: THREE.Object3D[] = [buildTerrainMesh(route, model)];

  // --- ocean
  const waterTex = canvasTex(256, 256, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 256, 256);
    const rr = rng(5);
    for (let i = 0; i < 900; i++) {
      const v = 228 + rr() * 27;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(rr() * 256, rr() * 256, 8 + rr() * 26, 1 + rr() * 2);
    }
  });
  waterTex.repeat.set(700, 700);
  const ocean = new THREE.Mesh(
    new THREE.CircleGeometry(12000, 64),
    new THREE.MeshPhongMaterial({ color: '#1f5c86', specular: '#9fb8c8', shininess: 70, map: waterTex }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(L.cx, sea, L.cz);
  ocean.receiveShadow = false;
  ocean.userData.mapWater = true; // minimap: the sea
  out.push(ocean);

  // --- shoreline: where the seaward profile crosses sea level, for each row
  const seaSign = -land;
  const shore = new Float32Array(Math.ceil(n / 2) + 1);
  for (let k = 0; k < shore.length; k++) {
    const i = (k * 2) % n;
    const H = above(i);
    let lo = EDGE + 1;
    let hi = 800;
    if (seaH(i, lo) + H < 0) {
      shore[k] = lo;
      continue;
    }
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (seaH(i, mid) + H > 0) lo = mid;
      else hi = mid;
    }
    shore[k] = lo;
  }
  const ribbon = (inner: number, outer: number, lift: number, mat: THREE.Material, vScale: number) => {
    const rows = shore.length;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    for (let k = 0; k < rows; k++) {
      const i = (k * 2) % n;
      for (let s = 0; s < 2; s++) {
        const a = shore[k] + (s === 0 ? inner : outer);
        worldAt(route, i, seaSign * a, 0, p);
        const o = (k * 2 + s) * 3;
        pos[o] = p.x;
        pos[o + 1] = sea + lift;
        pos[o + 2] = p.z;
        uv[(k * 2 + s) * 2] = s;
        uv[(k * 2 + s) * 2 + 1] = (k * 2 * step) / vScale;
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
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1;
    return m;
  };
  const shallowTex = canvasTex(
    64,
    64,
    (g) => {
      const gr = g.createLinearGradient(0, 0, 64, 0);
      gr.addColorStop(0, 'rgba(70,190,180,0.85)');
      gr.addColorStop(0.35, 'rgba(50,160,170,0.45)');
      gr.addColorStop(1, 'rgba(40,120,160,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
    },
    false,
  );
  shallowTex.wrapT = THREE.RepeatWrapping;
  const foamTex = canvasTex(128, 256, (g) => {
    const gr = g.createLinearGradient(0, 0, 128, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.7)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.15)');
    gr.addColorStop(0.62, 'rgba(255,255,255,0.45)');
    gr.addColorStop(0.75, 'rgba(255,255,255,0.05)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 256);
    // break it up a little
    const rr = rng(9);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(0,0,0,${0.2 + rr() * 0.5})`;
      g.beginPath();
      g.ellipse(20 + rr() * 108, rr() * 256, 3 + rr() * 8, 6 + rr() * 16, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
  const transparent = (map: THREE.Texture, color: string, po: number) =>
    new THREE.MeshBasicMaterial({ map, color, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: po, polygonOffsetUnits: po });
  out.push(ribbon(-2, 90, 0.05, transparent(shallowTex, '#ffffff', -1), 60));
  out.push(ribbon(-2.5, 16, 0.12, transparent(foamTex, '#ffffff', -2), 26));

  // --- sea stacks and wave-washed rocks
  const stacks: Inst[] = [];
  const stackCol = new THREE.Color();
  const rocksSmall: Inst[] = [];
  const foamRings: Inst[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < shore.length; k += 3) {
    const i = (k * 2) % n;
    if (r() < 0.12) {
      const a = shore[k] + 20 + Math.pow(r(), 1.5) * 220;
      const p = worldAt(route, i, seaSign * a, 0);
      p.y = sea - 8;
      const wdt = 5 + r() * 10;
      const ht = 14 + r() * 26;
      e.set((r() - 0.5) * 0.3, r() * 6, (r() - 0.5) * 0.3);
      q.setFromEuler(e);
      stacks.push({ i, m: new THREE.Matrix4().compose(p, q, new THREE.Vector3(wdt, ht, wdt * (0.7 + r() * 0.6))), c: stackCol.setHSL(0.08, 0.12, 0.3 + r() * 0.12).clone() });
      foamRings.push({ i, m: new THREE.Matrix4().compose(new THREE.Vector3(p.x, sea + 0.15, p.z), q.setFromAxisAngle(up, r() * 6), new THREE.Vector3(wdt * 3.4, 1, wdt * 3.4)) });
    }
    for (let j = 0; j < 2; j++) {
      if (r() < 0.35) {
        const a = shore[k] - 2 + r() * 14;
        const p = worldAt(route, i, seaSign * a, 0);
        p.y = sea - 0.5;
        const s = 1 + r() * 3.5;
        e.set(r() * 3, r() * 3, r() * 3);
        rocksSmall.push({ i, m: new THREE.Matrix4().compose(p, q.setFromEuler(e), new THREE.Vector3(s, s * 0.7, s)) });
      }
    }
  }
  const stackGeo = new THREE.DodecahedronGeometry(0.5, 1).translate(0, 0.5, 0);
  {
    // roughen the stacks: flat-topped, craggy
    const pa = stackGeo.attributes.position;
    const rr = rng(77);
    for (let v = 0; v < pa.count; v++) {
      const y = pa.getY(v);
      const k = 0.8 + rr() * 0.4;
      pa.setXYZ(v, pa.getX(v) * k * (1.1 - y * 0.4), Math.min(y, 0.92), pa.getZ(v) * k * (1.1 - y * 0.4));
    }
    stackGeo.computeVertexNormals();
  }
  out.push(chunkedInstances(route, stackGeo, new THREE.MeshLambertMaterial({ flatShading: true }), stacks, { shadow: false }));
  out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#5e564d', flatShading: true }), rocksSmall, { shadow: false }));
  const ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ map: radialTex('rgba(255,255,255,0)', 'rgba(255,255,255,0)'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  ringMat.map = canvasTex(
    128,
    128,
    (g) => {
      const gr = g.createRadialGradient(64, 64, 10, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.3, 'rgba(255,255,255,0.85)');
      gr.addColorStop(0.55, 'rgba(255,255,255,0.25)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    },
    false,
  );
  out.push(chunkedInstances(route, ringGeo, ringMat, foamRings, { shadow: false }));

  // --- vegetation: windswept cypress, coast live oaks, scrub
  const cypress: Inst[] = [];
  const oaks: Inst[] = [];
  const trunks: Inst[] = [];
  const bushes: Inst[] = [];
  const density = opts.high ? 1 : 0.5;
  const spot = (i: number, off0: number, jit: number) => {
    const off = clampOff(route, i, off0);
    const p = worldAt(route, i, off, height(i, off) - 0.25);
    p.x += (r() - 0.5) * jit;
    p.z += (r() - 0.5) * jit;
    return p;
  };
  for (let i = 0; i < n; i += 2) {
    const grove = smooth(0.2, 0.8, w01(i, 1.1, 0.7));
    // land side: oaks in gullies & on gentle slopes, cypress groves near the road
    if (r() < (0.12 + 0.3 * grove) * density) {
      const a = EDGE + 5 + Math.pow(r(), 1.6) * 300;
      const off = land * a;
      const sl = Math.abs(height(i, off + 2) - height(i, off - 2)) / 4;
      if (sl < 0.9) {
        const p = spot(i, off, 6);
        const s = 0.7 + r() * 0.8;
        const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.8 + r() * 0.4), s));
        if (a < 60 && r() < 0.5) cypress.push({ i, m, c: new THREE.Color().setHSL(0.27 + r() * 0.05, 0.35, 0.16 + r() * 0.06) });
        else oaks.push({ i, m, c: new THREE.Color().setHSL(0.2 + r() * 0.06, 0.4, 0.2 + r() * 0.08) });
        trunks.push({ i, m });
      }
    }
    // sea side: occasional cypress on the terrace
    const T = terrace(i);
    if (T > 14 && r() < 0.18 * grove * density) {
      const a = EDGE + 3 + r() * (T - 4);
      const p = spot(i, -land * a, 3);
      const s = 0.8 + r() * 0.6;
      // windswept: yaw so the crown streams inland
      const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, -route.heading[i] + (land > 0 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 0.6), new THREE.Vector3(s, s, s));
      cypress.push({ i, m, c: new THREE.Color().setHSL(0.27 + r() * 0.05, 0.35, 0.15 + r() * 0.05) });
      trunks.push({ i, m });
    }
    // scrub (both sides, mostly inland)
    for (const side of [land, -land]) {
      const lim = side === land ? 160 : Math.max(0, T);
      if (lim > 3 && r() < (side === land ? 0.75 : 0.3) * density) {
        const a = EDGE + 1.5 + Math.pow(r(), 1.4) * lim;
        const p = spot(i, side * a, 4);
        const s = 0.3 + r() * 0.5;
        bushes.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6), new THREE.Vector3(s * 1.4, s * (0.55 + r() * 0.4), s * 1.4)), c: new THREE.Color().setHSL(0.19 + r() * 0.09, 0.22 + r() * 0.12, 0.17 + r() * 0.08) });
      }
    }
  }
  const cypressGeo = merge([
    new THREE.IcosahedronGeometry(3.2, 0).scale(1.25, 0.42, 1).translate(0.8, 6.4, 0),
    new THREE.IcosahedronGeometry(2.6, 0).scale(1.2, 0.45, 1.1).translate(-2.4, 5.6, 0.6),
    new THREE.IcosahedronGeometry(2.4, 0).scale(1.1, 0.5, 1).translate(3.6, 5.2, -0.8),
    new THREE.IcosahedronGeometry(2.0, 0).scale(1, 0.5, 1).translate(0.4, 7.4, 0.4),
  ]);
  const oakGeo = merge([
    new THREE.IcosahedronGeometry(2.8, 0).scale(1.2, 0.75, 1.1).translate(0, 4.2, 0),
    new THREE.IcosahedronGeometry(2.2, 0).scale(1.1, 0.75, 1).translate(1.9, 3.6, 0.9),
    new THREE.IcosahedronGeometry(2.0, 0).scale(1.1, 0.75, 1).translate(-1.8, 3.5, -0.6),
  ]);
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.38, 4.6, 6, 1, true).translate(0, 2.3, 0);
  const leaf = new THREE.MeshLambertMaterial({ flatShading: true });
  out.push(chunkedInstances(route, trunkGeo, new THREE.MeshLambertMaterial({ color: '#5b4632' }), trunks));
  // coastal wind: the cypress canopies rock more than the sheltered oaks
  out.push(chunkedInstances(route, cypressGeo, windy(leaf, 8, 0.3), cypress));
  out.push(chunkedInstances(route, oakGeo, windy(leaf.clone(), 6, 0.18), oaks));
  out.push(chunkedInstances(route, new THREE.IcosahedronGeometry(1, 0).translate(0, 0.45, 0), windy(new THREE.MeshLambertMaterial({ flatShading: true }), 1, 0.08), bushes, { shadow: false }));

  // --- concrete arch bridges over the bridged gullies
  const beams: Inst[] = [];
  for (const gl of gullies) {
    if (!gl.bridge) continue;
    const half = Math.round(44 / step);
    const c = gl.c;
    const yc = route.y[c];
    const spring = yc - gl.depth * 0.82; // arch feet (buried in the gully sides)
    const crown = yc - 2.4;
    const halfLen = half * step;
    for (let d = -half - 4; d < half + 4; d++) {
      const i = (c + d + n) % n;
      const j = (i + 1) % n;
      const a = new THREE.Vector3(route.x[i], route.y[i] - 0.65, route.z[i]);
      const b = new THREE.Vector3(route.x[j], route.y[j] - 0.65, route.z[j]);
      const side = new THREE.Vector3(-Math.sin(route.heading[i]), 0, Math.cos(route.heading[i]));
      beams.push({ i, m: beamMatrix(a, b, 1.3, ROAD_HALF * 2 + 1.6, side) }); // deck
      for (const s of [-1, 1]) {
        const o = s * (ROAD_HALF + 0.55);
        const pa = worldAt(route, i, o, 0.35);
        const pb = worldAt(route, j, o, 0.35);
        beams.push({ i, m: beamMatrix(pa, pb, 0.7, 0.3, side) }); // parapet
      }
    }
    // arch ribs and spandrel columns (in the frame of each sample along the span)
    const archY = (dm: number) => spring + (crown - spring) * (1 - Math.pow(dm / halfLen, 2));
    const segs = 18;
    for (const s of [-1, 1]) {
      const o = s * 3.4;
      for (let k = 0; k < segs; k++) {
        const d0 = -halfLen + (2 * halfLen * k) / segs;
        const d1 = -halfLen + (2 * halfLen * (k + 1)) / segs;
        const i0 = (c + Math.round(d0 / step) + n) % n;
        const i1 = (c + Math.round(d1 / step) + n) % n;
        const pa = worldAt(route, i0, o, 0);
        const pb = worldAt(route, i1, o, 0);
        pa.y = archY(d0);
        pb.y = archY(d1);
        const side = new THREE.Vector3(-Math.sin(route.heading[i0]), 0, Math.cos(route.heading[i0]));
        beams.push({ i: i0, m: beamMatrix(pa, pb, 1.6, 1.5, side) });
      }
      for (let dm = -halfLen + 6; dm <= halfLen - 6; dm += 7) {
        const i0 = (c + Math.round(dm / step) + n) % n;
        const top = route.y[i0] - 1.2;
        const bot = archY(dm);
        if (top - bot < 0.6) continue;
        const pa = worldAt(route, i0, o, 0);
        const pb = pa.clone();
        pa.y = bot;
        pb.y = top;
        const side = new THREE.Vector3(Math.cos(route.heading[i0]), 0, Math.sin(route.heading[i0]));
        beams.push({ i: i0, m: beamMatrix(pa, pb, 0.9, 0.9, side) });
      }
    }
    // end piers down to the gully sides
    for (const sgn of [-1, 1]) {
      const i0 = (c + sgn * half + n) % n;
      for (const s of [-1, 1]) {
        const pa = worldAt(route, i0, s * 3.4, 0);
        const pb = pa.clone();
        pa.y = spring - 4;
        pb.y = route.y[i0] - 1.2;
        const side = new THREE.Vector3(Math.cos(route.heading[i0]), 0, Math.sin(route.heading[i0]));
        beams.push({ i: i0, m: beamMatrix(pa, pb, 2.2, 1.6, side) });
      }
    }
  }
  out.push(chunkedInstances(route, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#d8d2c4' }), beams, { shadow: true, receive: true }));
  return out;
}
