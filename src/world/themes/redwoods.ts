// Redwoods: a narrow road winding through old-growth giants. Massive fluted
// red-brown trunks rise 40-80 m to narrow crowns; sword ferns and sorrel carpet
// the duff; fallen logs, mid-storey tanoaks, low mist and shafts of sunlight.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  buildTerrainMesh,
  clampOff,
  canvasTex,
  chunkedInstances,
  detailTex,
  lapWave,
  loopInfo,
  merge,
  mirroredColumns,
  rng,
  roadTex,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
  jitterAlong,
} from './common';
import type { ThemeBuildOptions } from './index';
import { breathingShafts, buildDustMotes, windy } from '../fx';

export function redwoodsRoad() {
  return roadTex({
    base: '#3f4144',
    speck: (r) => {
      const v = 42 + r() * 46;
      return `rgb(${v},${v + 2},${v})`;
    },
    worn: 'rgba(18,20,18,0.2)',
    centre: 'double-yellow',
  });
}

export function buildRedwoods(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const r = rng(route.seed * 71 + 3);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);

  // A creek valley: one side climbs steeply, the other more gently (they swap along the lap).
  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    if (a < EDGE + 0.8) return -0.12;
    const side = Math.sign(off);
    const tilt = lapWave(route, i, 0.35, 0.8) * side; // -1..1: which bank is steeper
    const w1 = w01(i, 1.4, side * 1.3);
    const w2 = w01(i, 0.6, 2.0 + side);
    let dy = -0.12 + smooth(EDGE + 0.8, 14, a) * (0.4 + 1.6 * w1);
    dy += Math.max(0, a - 12) * (0.12 + 0.1 * tilt + 0.1 * w2);
    dy += smooth(60, 260, a) * (10 + 30 * w2);
    dy += Math.sin(i * 0.05 + a * 0.06) * 1.5 * smooth(15, 40, a); // hummocks
    return dy;
  };
  const { offs, roadCol } = mirroredColumns([EDGE, 6.5, 8.5, 11, 15, 20, 27, 36, 48, 64, 86, 115, 155, 210, 280, 360]);

  const duff = new THREE.Color('#5b4430');
  const duffD = new THREE.Color('#463424');
  const moss = new THREE.Color('#566d2f');
  const sorrel = new THREE.Color('#4f7a2c');
  const verge = new THREE.Color('#5d5a3e');
  const model: TerrainModel = {
    cols: offs.length,
    roadCol,
    colOff: (_i, c) => offs[c],
    height,
    color(i, off, _dy, out) {
      const a = Math.abs(off);
      const t = 0.5 + 0.5 * Math.sin(i * 0.037 + off * 0.08);
      out.copy(duff).lerp(duffD, t);
      const green = 0.5 + 0.5 * Math.sin(i * 0.021 + Math.floor(off / 18) * 2.1);
      out.lerp(sorrel, smooth(0.45, 0.85, green) * 0.75 * (1 - smooth(60, 160, a)));
      out.lerp(moss, 0.25);
      if (a < EDGE + 0.8) out.copy(verge);
    },
    map: detailTex(23, (g, rr) => {
      for (let i = 0; i < 9000; i++) {
        const v = 120 + rr() * 135;
        g.fillStyle = `rgb(${v},${v - 6},${v - 20})`;
        g.save();
        g.translate(rr() * 256, rr() * 256);
        g.rotate(rr() * Math.PI);
        g.fillRect(0, 0, 1 + rr() * 2, 3 + rr() * 6);
        g.restore();
      }
    }),
  };
  const out: THREE.Object3D[] = [buildTerrainMesh(route, model)];

  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const spot = (i: number, off0: number, sink = 0.4) => {
    const off = clampOff(route, i, off0);
    return worldAt(route, i, off, height(i, off) - sink);
  };
  const density = opts.high ? 1 : 0.5;

  // --- redwoods
  const trunks: Inst[] = [];
  const crowns: Inst[] = [];
  const crownsB: Inst[] = [];
  const tanoaks: Inst[] = [];
  const tanoakTrunks: Inst[] = [];
  const ferns: Inst[] = [];
  const logs: Inst[] = [];
  for (let i = 0; i < n; i += 2) {
    const grove = 0.6 + 0.4 * w01(i, 0.9, 1.1); // denser groves and slightly open glades
    for (const side of [-1, 1]) {
      // giants: a few per 10 m per side, clustered towards the road (fairy rings near the verge)
      const count = (0.55 + 0.85 * grove) * density;
      let k = Math.floor(count) + (r() < count % 1 ? 1 : 0);
      while (k-- > 0) {
        const a = EDGE + 3.5 + Math.min(190, -Math.log(1 - r() * 0.995) * 45);
        const off = side * a;
        const p = spot(i, off, 0.6);
        jitterAlong(p, route, i, 9, r);
        const big = r();
        const h = 0.62 + big * 0.7; // reference tree 64 m → ~40-85 m
        const girth = (0.7 + big * 0.9) * (0.85 + r() * 0.3);
        q.setFromAxisAngle(up, r() * 6.3);
        const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(girth, h, girth));
        trunks.push({ i, m, c: new THREE.Color().setHSL(0.03 + r() * 0.03, 0.42 + r() * 0.12, 0.3 + r() * 0.1) });
        const cm = new THREE.Matrix4().compose(p, q, new THREE.Vector3(0.85 + r() * 0.4, h, 0.85 + r() * 0.4));
        const cc = new THREE.Color().setHSL(0.26 + r() * 0.07, 0.33, 0.13 + r() * 0.06);
        (r() < 0.5 ? crowns : crownsB).push({ i, m: cm, c: cc });
      }
      // mid-storey tanoak / bay laurel
      if (r() < 0.35 * density) {
        const a = EDGE + 4 + r() * 70;
        const p = spot(i, side * a);
        const s = 0.7 + r() * 0.7;
        const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.9 + r() * 0.4), s));
        tanoaks.push({ i, m, c: new THREE.Color().setHSL(0.22 + r() * 0.06, 0.4, 0.22 + r() * 0.08) });
        tanoakTrunks.push({ i, m });
      }
      // sword ferns, thick near the verge
      const nf = 2.2 * density * (0.6 + grove * 0.6);
      let f = Math.floor(nf) + (r() < nf % 1 ? 1 : 0);
      while (f-- > 0) {
        const s = 0.8 + r() * 0.9;
        // keep fronds (≈1.1 m reach × scale) off the asphalt
        const a = EDGE + 1.2 + 1.1 * s + Math.pow(r(), 2.2) * 40;
        const p = spot(i, side * a, 0.1);
        // jitter along the road only, never sideways onto it
        const along = (r() - 0.5) * 8;
        p.x += Math.cos(route.heading[i]) * along;
        p.z += Math.sin(route.heading[i]) * along;
        ferns.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.8 + r() * 0.4), s)), c: new THREE.Color().setHSL(0.24 + r() * 0.07, 0.42, 0.13 + r() * 0.07) });
      }
      // fallen giants lying along the slope
      if (r() < 0.02 * density) {
        const a = EDGE + 8 + r() * 60;
        const p = spot(i, side * a, 0.2);
        p.y += 0.9;
        const len = 15 + r() * 25;
        const yaw = -route.heading[i] + (r() - 0.5) * 1.2;
        const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, Math.PI / 2 + (r() - 0.5) * 0.1, 'YXZ'));
        logs.push({ i, m: new THREE.Matrix4().compose(p, qq, new THREE.Vector3(0.9 + r() * 0.6, len, 0.9 + r() * 0.6)) });
      }
    }
  }

  // reference redwood: 64 m tall, ~1.8 m base radius, flared, crown from ~45% height
  const segs = 7;
  const trunkGeo = merge([
    new THREE.CylinderGeometry(0.22, 1.25, 60, segs, 1, true).translate(0, 34, 0),
    new THREE.CylinderGeometry(1.25, 2.1, 4, segs, 1, true).translate(0, 2, 0),
  ]);
  const barkTex = canvasTex(128, 512, (g) => {
    g.fillStyle = '#c9a08a';
    g.fillRect(0, 0, 128, 512);
    const rr = rng(31);
    for (let k = 0; k < 160; k++) {
      const x = rr() * 128;
      const v = 0.55 + rr() * 0.5;
      g.fillStyle = `rgba(${Math.round(110 * v)},${Math.round(60 * v)},${Math.round(45 * v)},${0.35 + rr() * 0.4})`;
      g.fillRect(x, 0, 1 + rr() * 5, 512);
    }
    for (let k = 0; k < 500; k++) {
      g.fillStyle = `rgba(40,20,14,${0.15 + rr() * 0.3})`;
      g.fillRect(rr() * 128, rr() * 512, 1 + rr() * 2, 10 + rr() * 50);
    }
  });
  barkTex.repeat.set(2, 6);
  const trunkMat = new THREE.MeshLambertMaterial({ map: barkTex });
  out.push(chunkedInstances(route, trunkGeo, trunkMat, trunks, { chunkM: 500 }));

  // narrow, slightly ragged crowns of drooping branch-clumps
  // tiers of drooping branch sprays: flat, tilted, off-centre skirts (irregular silhouette)
  const crownGeo = (seed: number) => {
    const rr = rng(seed);
    const tiers: THREE.BufferGeometry[] = [];
    const nT = 7;
    for (let k = 0; k < nT; k++) {
      const t = k / (nT - 1);
      const y = 30 + t * 30;
      const rad = (5.6 - t * 3.6) * (0.75 + rr() * 0.5);
      const g = new THREE.ConeGeometry(rad, 3.6 + rr() * 3, 5, 1, true);
      g.rotateX((rr() - 0.5) * 0.5);
      g.rotateZ((rr() - 0.5) * 0.5);
      g.rotateY(rr() * 6.3);
      const o = (1 - t) * 1.8;
      g.translate((rr() - 0.5) * o, y, (rr() - 0.5) * o);
      tiers.push(g);
    }
    tiers.push(new THREE.ConeGeometry(1.4, 7, 5, 1, true).translate(0, 62.5, 0));
    return merge(tiers);
  };
  const crownA = crownGeo(101);
  const crownB = crownGeo(202);
  // crowns start ~30 m up on 60 m trees: only the tops sway, slowly
  const crownMat = windy(new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide }), 64, 0.9);
  out.push(chunkedInstances(route, crownA, crownMat, crowns, { chunkM: 500 }));
  out.push(chunkedInstances(route, crownB, crownMat, crownsB, { chunkM: 500 }));

  // tanoaks: short trunk with a loose rounded crown
  out.push(chunkedInstances(route, new THREE.CylinderGeometry(0.15, 0.25, 6, 5, 1, true).translate(0, 3, 0), new THREE.MeshLambertMaterial({ color: '#57493a' }), tanoakTrunks, { shadow: false }));
  out.push(
    chunkedInstances(
      route,
      merge([new THREE.IcosahedronGeometry(2.4, 0).scale(1.2, 0.8, 1).translate(0, 6.5, 0), new THREE.IcosahedronGeometry(1.8, 0).translate(1.4, 5.2, 0.8)]),
      windy(new THREE.MeshLambertMaterial({ flatShading: true }), 8, 0.2),
      tanoaks,
      { shadow: false },
    ),
  );

  // sword fern: a rosette of arching fronds (double-sided quads)
  const frond = (ang: number, tilt: number) => {
    const g = new THREE.PlaneGeometry(0.55, 1.5, 1, 2);
    const pa = g.attributes.position;
    for (let v = 0; v < pa.count; v++) {
      const y = pa.getY(v) + 0.75; // 0..1.5 along the frond
      pa.setXYZ(v, pa.getX(v) * (1 - y / 1.75), y * 1.05 - 0.24 * y * y, -0.45 * y); // arch outwards and droop
    }
    g.rotateX(-tilt);
    g.rotateY(ang);
    return g;
  };
  const fernGeo = merge([0, 1, 2, 3, 4, 5, 6].map((k) => frond((k / 7) * Math.PI * 2 + k * 0.3, 0.1 + (k % 3) * 0.15)));
  fernGeo.computeVertexNormals();
  out.push(chunkedInstances(route, fernGeo, windy(new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), 1.4, 0.12), ferns, { shadow: false }));

  // fallen logs (moss-tinged)
  out.push(chunkedInstances(route, new THREE.CylinderGeometry(1, 1.2, 1, 8), new THREE.MeshLambertMaterial({ color: '#6a4a36', map: barkTex }), logs, { shadow: true, receive: true }));

  // --- sun shafts through the canopy (additive, crossed planes along the sun direction)
  const sunDir = new THREE.Vector3(80, 140, 50).normalize(); // matches the scene's sun offset
  const shafts: Inst[] = [];
  const shaftQ = new THREE.Quaternion().setFromUnitVectors(up, sunDir);
  for (let i = 0; i < n; i += Math.round(30 / route.step)) {
    if (r() > 0.55) continue;
    const off = (r() - 0.5) * 50;
    const p = spot(i, off, 0);
    const len = 55 + r() * 30;
    const wdt = 2 + r() * 5;
    const qq = shaftQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(up, r() * 3));
    shafts.push({ i, m: new THREE.Matrix4().compose(p, qq, new THREE.Vector3(wdt, len, wdt)) });
  }
  const shaftTex = canvasTex(
    64,
    256,
    (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.25, 'rgba(255,255,255,0.7)');
      gr.addColorStop(0.8, 'rgba(255,255,255,0.9)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 256);
      g.globalCompositeOperation = 'destination-in';
      const gx = g.createLinearGradient(0, 0, 64, 0);
      gx.addColorStop(0, 'rgba(0,0,0,0)');
      gx.addColorStop(0.5, 'rgba(0,0,0,1)');
      gx.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gx;
      g.fillRect(0, 0, 64, 256);
    },
    false,
  );
  const shaftGeo = merge([new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI / 2)]);
  // shafts slowly brighten and fade (breathingShafts) and are bright enough to catch the bloom
  const shaftMat = breathingShafts(
    new THREE.MeshBasicMaterial({ map: shaftTex, color: new THREE.Color('#ffe2a0').multiplyScalar(1.6), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  out.push(chunkedInstances(route, shaftGeo, shaftMat, shafts, { shadow: false, chunkM: 400 }));

  // dust and pollen hanging in the light around the rider
  out.push(buildDustMotes({ count: opts.high ? 1800 : 600, box: 60, color: '#ffe6b0', size: 1.8, opacity: 1.2 }));

  // --- low mist banks drifting between the trunks
  const mistTex = canvasTex(
    128,
    64,
    (g) => {
      const rr = rng(13);
      for (let k = 0; k < 12; k++) {
        const x = 20 + rr() * 88;
        const y = 26 + rr() * 14;
        const rad = 14 + rr() * 18;
        const gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'rgba(255,255,255,0.5)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 128, 64);
      }
    },
    false,
  );
  const mist = new THREE.Group();
  for (let i = 0; i < n; i += Math.round(70 / route.step)) {
    if (r() > 0.6) continue;
    const off = (r() < 0.5 ? -1 : 1) * (12 + r() * 60);
    const p = spot(i, off, -3 - r() * 4);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, color: '#dfe7dc', transparent: true, opacity: 0.2 + r() * 0.2, depthWrite: false }));
    sp.position.copy(p);
    const s = 30 + r() * 40;
    sp.scale.set(s, s * 0.3, 1);
    mist.add(sp);
  }
  out.push(mist);
  return out;
}
