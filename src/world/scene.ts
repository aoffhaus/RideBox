import * as THREE from 'three';
import type { RideSession } from '../app/session';
import type { Route } from './route';
import { rng } from './route';
import { chunkedInstances, type Inst } from './themes/common';
import { MotionSmoother } from './smoother';
import { exaggerateRoute } from './route';
import { CAMERA_RIGS, cameraTargets, type CameraMode } from './camera';
import { themeFor, type Theme } from './themes';
import { PORTAL_VIOLET, animatePortal, buildPortal, setPortalZone, type PortalObj } from './portal';
import type { ViewHook } from './themes/common';
import { registerWorld, releaseWorld } from './worldMap';
import { applyWorldFx, fxBuild, fxSurge, fxTime, windy } from './fx';
import { EffortMeter } from './effort';
import { PostFX, DEFAULT_BLOOM } from './postfx';
import { AdaptiveQuality, qualityLevels } from './adaptive';
import { ArchFollower } from './arches';
import { DEFAULT_SKY, bakeEnvironment, buildPhysicalSky, sunDirection } from './sky';
import { formatDuration, intervalFtpFraction, toWatts, zoneFor } from '../workout/model';

const ROAD_HALF = 4.5;
/** Half-size (m) of the sun's shadow box, and how far up the road from the rider it is centred. */
const SHADOW_HALF = 32;
const SHADOW_AHEAD = 22;
const SKY_TOP = new THREE.Color('#3f86d6');
const SKY_HORIZON = new THREE.Color('#cfe5f5');
const HAZE = new THREE.Color('#b9d3e6');

// ---------------------------------------------------------------------------
// Terrain shape beside the road (shared by ground, trees, buildings, rocks).
// Gentle verges, rolling fields, then valley sides that rise away from the road.
// ---------------------------------------------------------------------------
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export function terrainBump(i: number, off: number): number {
  const a = Math.abs(off);
  if (a < ROAD_HALF + 1.2) return -0.12;
  const side = Math.sign(off);
  const wave = 0.5 + 0.5 * (Math.sin(i * 0.011 + side * 1.7) * 0.6 + Math.sin(i * 0.043 + off * 0.017) * 0.4);
  const fields = smooth(ROAD_HALF + 1.2, 30, a) * (1.5 + 3 * wave) * Math.min(1, a / 60);
  const hills = smooth(40, 220, a) * (10 + 45 * wave);
  const valley = a > 200 ? (a - 200) * (0.12 + 0.18 * wave) : 0;
  return -0.12 + fields + hills + valley;
}

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true) {
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

/** Asphalt with solid edge lines and a dashed centre line (one tile = 12 m). */
function roadTexture() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#44474d';
    g.fillRect(0, 0, 256, 512);
    const r = rng(42);
    for (let i = 0; i < 9000; i++) {
      const v = 45 + r() * 50;
      g.fillStyle = `rgb(${v},${v},${v + 3})`;
      g.fillRect(r() * 256, r() * 512, 1.6, 1.6);
    }
    // tyre-worn lanes
    g.fillStyle = 'rgba(20,20,22,0.18)';
    for (const x of [52, 84, 172, 204]) g.fillRect(x, 0, 18, 512);
    g.fillStyle = '#ececec';
    g.fillRect(8, 0, 7, 512);
    g.fillRect(241, 0, 7, 512);
    g.fillRect(125, 0, 6, 200); // dash ~4.7 m, gap ~7.3 m
  });
}

/** Neutral grass detail: multiplied with per-vertex colour. */
function grassTexture() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, 256, 256);
    const r = rng(7);
    for (let i = 0; i < 14000; i++) {
      const v = 150 + r() * 105;
      g.fillStyle = `rgb(${v},${v + 8},${v - 10})`;
      g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 2 + r() * 3);
    }
  });
}

function cloudTexture() {
  return canvasTex(
    128,
    128,
    (g) => {
      const r = rng(3);
      for (let k = 0; k < 9; k++) {
        const x = 30 + r() * 68;
        const y = 50 + r() * 30;
        const rad = 18 + r() * 26;
        const gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'rgba(255,255,255,0.9)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 128, 128);
      }
    },
    false,
  );
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------
function buildRoad(route: Route, map: THREE.Texture = roadTexture()): THREE.Mesh {
  const n = route.x.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx: number[] = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const h = route.heading[i];
    const lx = -Math.sin(h);
    const lz = Math.cos(h);
    for (let s = 0; s < 2; s++) {
      const off = s === 0 ? -ROAD_HALF : ROAD_HALF;
      const o = (k * 2 + s) * 3;
      pos[o] = route.x[i] + lx * off;
      pos[o + 1] = route.y[i] + 0.03;
      pos[o + 2] = route.z[i] + lz * off;
      uv[(k * 2 + s) * 2] = s;
      uv[(k * 2 + s) * 2 + 1] = (k * route.step) / 12;
    }
    if (k < n) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // counter-clockwise from above → normals up
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map }));
  m.receiveShadow = true;
  return m;
}

function buildTerrain(route: Route): THREE.Mesh {
  const n = route.x.length;
  const offs = [-420, -300, -210, -150, -100, -65, -40, -24, -14, -8, -ROAD_HALF - 0.2, ROAD_HALF + 0.2, 8, 14, 24, 40, 65, 100, 150, 210, 300, 420];
  const roadCol = offs.indexOf(-ROAD_HALF - 0.2);
  const cols = offs.length;
  const step = 2;
  const rows = Math.ceil(n / step) + 1;
  const pos = new Float32Array(rows * cols * 3);
  const col = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const idx: number[] = [];
  const grassA = new THREE.Color('#4c8a35');
  const grassB = new THREE.Color('#7aa84a');
  const field = new THREE.Color('#a8a956');
  const dark = new THREE.Color('#3b6b2e');
  const rock = new THREE.Color('#8b8a80');
  const verge = new THREE.Color('#7d8a55');
  const tmp = new THREE.Color();
  for (let r = 0; r < rows; r++) {
    const i = (r * step) % n;
    const h = route.heading[i];
    const lx = -Math.sin(h);
    const lz = Math.cos(h);
    for (let c = 0; c < cols; c++) {
      const off = offs[c];
      const o = (r * cols + c) * 3;
      const y = route.y[i] + terrainBump(i, off);
      pos[o] = route.x[i] + lx * off;
      pos[o + 1] = y;
      pos[o + 2] = route.z[i] + lz * off;
      uv[(r * cols + c) * 2] = pos[o] / 7;
      uv[(r * cols + c) * 2 + 1] = pos[o + 2] / 7;
      const a = Math.abs(off);
      // patchwork fields near the road, darker woods & rock higher up
      const patch = Math.sin(i * 0.02 + Math.floor(off / 35)) > 0.55;
      tmp.copy(grassA).lerp(grassB, 0.5 + 0.5 * Math.sin(i * 0.031 + off * 0.04));
      if (patch && a > 12 && a < 160) tmp.lerp(field, 0.55);
      if (a > 160) tmp.lerp(dark, smooth(160, 300, a) * 0.7);
      if (y - route.y[i] > 90) tmp.lerp(rock, smooth(90, 160, y - route.y[i]) * 0.8);
      if (a < ROAD_HALF + 1) tmp.copy(verge);
      col[o] = tmp.r;
      col[o + 1] = tmp.g;
      col[o + 2] = tmp.b;
    }
    if (r < rows - 1) {
      for (let c = 0; c < cols - 1; c++) {
        if (c === roadCol) continue;
        const a = r * cols + c;
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
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, map: grassTexture() }));
  m.receiveShadow = true;
  return m;
}

interface Spot {
  i: number;
  off: number;
}
function spotPos(route: Route, s: Spot, jitter = 0, r?: () => number) {
  const h = route.heading[s.i];
  const jx = r ? (r() - 0.5) * jitter : 0;
  const jz = r ? (r() - 0.5) * jitter : 0;
  return new THREE.Vector3(route.x[s.i] - Math.sin(h) * s.off + jx, route.y[s.i] + terrainBump(s.i, s.off) - 0.2, route.z[s.i] + Math.cos(h) * s.off + jz);
}

function buildVegetation(route: Route, density = 1): THREE.Group {
  const n = route.x.length;
  const r = rng(route.seed * 31 + 7);
  const g = new THREE.Group();
  const pines: Inst[] = [];
  const broad: Inst[] = [];
  const trunks: Inst[] = [];
  const rocks: Inst[] = [];
  const bushes: Inst[] = [];
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i += 2) {
    // forest density varies along the route
    const forest = 0.5 + 0.5 * Math.sin(i * 0.006 + route.seed);
    for (const side of [-1, 1]) {
      if (r() < (0.2 + forest * 0.55) * density) {
        const off = side * (ROAD_HALF + 6 + Math.pow(r(), 1.3) * 260);
        const p = spotPos(route, { i, off }, 8, r);
        const s = 0.7 + r() * 1.0;
        q.setFromAxisAngle(up, r() * Math.PI * 2);
        const m = new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s * (0.85 + r() * 0.4), s));
        trunks.push({ i, m });
        if (r() < 0.55 + 0.3 * forest) pines.push({ i, m, c: new THREE.Color().setHSL(0.31 + r() * 0.05, 0.45, 0.17 + r() * 0.08) });
        else broad.push({ i, m, c: new THREE.Color().setHSL(0.2 + r() * 0.1, 0.5, 0.25 + r() * 0.12) });
      }
      if (r() < 0.08) {
        const p = spotPos(route, { i, off: side * (ROAD_HALF + 3 + r() * 40) }, 4, r);
        const s = 0.4 + r() * 1.6;
        q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
        rocks.push({ i, m: new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s * 0.7, s)) });
      }
      if (r() < 0.25) {
        const p = spotPos(route, { i, off: side * (ROAD_HALF + 2.5 + r() * 12) }, 3, r);
        const s = 0.4 + r() * 0.7;
        bushes.push({ i, m: new THREE.Matrix4().compose(p, q.identity(), new THREE.Vector3(s * 1.4, s, s * 1.4)) });
      }
    }
  }
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.2, 6).translate(0, 1.1, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#5e4128' });
  // pine: three stacked cones
  const pineParts = [
    new THREE.ConeGeometry(2.0, 3.2, 7).translate(0, 3.0, 0),
    new THREE.ConeGeometry(1.6, 2.8, 7).translate(0, 4.6, 0),
    new THREE.ConeGeometry(1.1, 2.4, 7).translate(0, 6.0, 0),
  ];
  const pineGeo = mergeGeos(pineParts);
  const broadGeo = new THREE.IcosahedronGeometry(2.1, 0).scale(1, 0.9, 1).translate(0, 3.6, 0);
  const leafMat = windy(new THREE.MeshLambertMaterial({ flatShading: true }), 7, 0.22);
  // split into ~800 m chunks so trees out of view (or out of the shadow frustum) are culled
  g.add(chunkedInstances(route, trunkGeo, trunkMat, trunks));
  g.add(chunkedInstances(route, pineGeo, leafMat, pines));
  g.add(chunkedInstances(route, broadGeo, windy(leafMat.clone(), 6, 0.26), broad));
  g.add(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#8e8c84', flatShading: true }), rocks));
  g.add(chunkedInstances(route, new THREE.IcosahedronGeometry(1, 0).translate(0, 0.5, 0), windy(new THREE.MeshLambertMaterial({ color: '#4f7f36', flatShading: true }), 1.1, 0.07), bushes, { shadow: false }));
  return g;
}

/** Merge non-indexed copies of simple geometries (avoids importing BufferGeometryUtils). */
function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => g.toNonIndexed());
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, o);
    o += p.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

/** Farms: houses & barns set back from the road, facing it. */
function buildBuildings(route: Route): THREE.Group {
  const n = route.x.length;
  const r = rng(route.seed * 97 + 11);
  const bodies: Inst[] = [];
  const roofs: Inst[] = [];
  const every = Math.round(350 / route.step);
  for (let i = 0; i < n; i += every) {
    if (r() < 0.35) continue;
    const side = r() < 0.5 ? -1 : 1;
    const off = side * (ROAD_HALF + 22 + r() * 90);
    const base = spotPos(route, { i, off }, 10, r);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -route.heading[i] + (r() - 0.5) * 0.4);
    const count = 1 + Math.floor(r() * 3);
    for (let k = 0; k < count; k++) {
      const barn = k === 0 && r() < 0.5;
      const w = barn ? 12 : 7 + r() * 3;
      const d = barn ? 8 : 6 + r() * 2;
      const h = barn ? 6 : 3.2 + r() * 1.5;
      const p = base.clone().add(new THREE.Vector3((r() - 0.5) * 30, 0, (r() - 0.5) * 30));
      bodies.push({ i, m: new THREE.Matrix4().compose(p, q, new THREE.Vector3(w, h, d)), c: new THREE.Color(barn ? '#9c2f24' : ['#efe6d2', '#e4d3b0', '#d9dfe4', '#c9b79a'][Math.floor(r() * 4)]) });
      roofs.push({ i, m: new THREE.Matrix4().compose(p.clone().add(new THREE.Vector3(0, h, 0)), q, new THREE.Vector3(w * 1.05, h * 0.55, d * 1.1)), c: new THREE.Color(barn ? '#5b5b5b' : ['#7a3a2a', '#45484f', '#6b4b33'][Math.floor(r() * 3)]) });
    }
  }
  const g = new THREE.Group();
  const body = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // triangular prism roof: ridge along local x
  const roof = new THREE.CylinderGeometry(0.5, 0.5, 1, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6 + Math.PI / 2).scale(1, 1.15, 1.15).translate(0, 0.28, 0);
  g.add(chunkedInstances(route, body, new THREE.MeshLambertMaterial(), bodies));
  g.add(chunkedInstances(route, roof, new THREE.MeshLambertMaterial({ flatShading: true }), roofs));
  return g;
}

/** White roadside posts with reflectors every 25 m — they stream past and sell speed. */
function buildPosts(route: Route): THREE.Group {
  const posts: Inst[] = [];
  const refl: Inst[] = [];
  const every = Math.max(1, Math.round(25 / route.step));
  const q = new THREE.Quaternion();
  for (let i = 0; i < route.x.length; i += every) {
    for (const side of [-1, 1]) {
      const off = side * (ROAD_HALF + 1.1);
      const h = route.heading[i];
      const p = new THREE.Vector3(route.x[i] - Math.sin(h) * off, route.y[i], route.z[i] + Math.cos(h) * off);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -h);
      posts.push({ i, m: new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)) });
      refl.push({ i, m: new THREE.Matrix4().compose(p.clone().add(new THREE.Vector3(0, 0.85, 0)), q, new THREE.Vector3(1, 1, 1)) });
    }
  }
  const g = new THREE.Group();
  g.add(chunkedInstances(route, new THREE.BoxGeometry(0.12, 1.1, 0.12).translate(0, 0.55, 0), new THREE.MeshLambertMaterial({ color: '#f4f4f4' }), posts, { shadow: false, chunkM: 3000 }));
  g.add(chunkedInstances(route, new THREE.BoxGeometry(0.14, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: '#ff3b2f' }), refl, { shadow: false, chunkM: 3000 }));
  return g;
}

/** Yellow grade signs at the start of each sustained climb ("▲ 7%  1.2 km"). */
function buildClimbSigns(route: Route): THREE.Group {
  const g = new THREE.Group();
  const n = route.x.length;
  const look = Math.round(400 / route.step);
  const ty = (route.base ?? route).y; // labels use true elevations
  const avg = (i: number, len: number) => (ty[(i + len) % n] - ty[i]) / (len * route.step);
  const texCache = new Map<string, THREE.Texture>();
  let i = 0;
  let placed = 0;
  while (i < n && placed < 40) {
    const g400 = avg(i, look);
    if (g400 >= 0.035) {
      // find climb length: until the 200 m average drops below 1.5 %
      let j = i;
      while (j < i + n && avg(j % n, Math.round(200 / route.step)) > 0.015) j += 4;
      const lenM = (j - i) * route.step;
      if (lenM >= 300) {
        const gradeAvg = Math.round(((ty[j % n] - ty[i]) / lenM) * 100);
        const label = `▲ ${gradeAvg}%|${lenM >= 1000 ? (lenM / 1000).toFixed(1) + ' km' : Math.round(lenM / 10) * 10 + ' m'}`;
        let tex = texCache.get(label);
        if (!tex) {
          tex = canvasTex(
            256,
            256,
            (c) => {
              const [a, b] = label.split('|');
              c.fillStyle = '#f2c230';
              c.beginPath();
              c.moveTo(128, 6);
              c.lineTo(250, 128);
              c.lineTo(128, 250);
              c.lineTo(6, 128);
              c.closePath();
              c.fill();
              c.lineWidth = 8;
              c.strokeStyle = '#111';
              c.stroke();
              c.fillStyle = '#111';
              c.textAlign = 'center';
              c.font = 'bold 64px system-ui, sans-serif';
              c.fillText(a, 128, 128);
              c.font = 'bold 34px system-ui, sans-serif';
              c.fillText(b, 128, 178);
            },
            false,
          );
          texCache.set(label, tex);
        }
        const signI = (i - Math.round(60 / route.step) + n) % n; // 60 m before the climb
        const off = ROAD_HALF + 2.2;
        const h = route.heading[signI];
        const p = new THREE.Vector3(route.x[signI] - Math.sin(h) * off, route.y[signI], route.z[signI] + Math.cos(h) * off);
        const sign = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6).translate(0, 1.2, 0), new THREE.MeshLambertMaterial({ color: '#9aa0a6' }));
        const board = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
        board.position.y = 2.9;
        board.rotation.y = -Math.PI / 2; // face oncoming rider
        sign.add(pole, board);
        sign.position.copy(p);
        sign.rotation.y = -h;
        g.add(sign);
        placed++;
        i = j;
        continue;
      }
    }
    i += 4;
  }
  return g;
}

/** Sky dome with a vertical gradient (drawn behind everything, no fog). */
function buildSky(top: THREE.Color = SKY_TOP, horizon: THREE.Color = SKY_HORIZON): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: top }, horizon: { value: horizon } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir;
      void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.55)); gl_FragColor = vec4(c, 1.0); }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), mat);
  m.renderOrder = -10;
  return m;
}

/** Ring of distant hazy mountains around the course (horizon reference for climbing). */
function buildMountains(route: Route): THREE.Group {
  let cx = 0;
  let cz = 0;
  let minY = Infinity;
  for (let i = 0; i < route.x.length; i++) {
    cx += route.x[i];
    cz += route.z[i];
    minY = Math.min(minY, route.y[i]);
  }
  cx /= route.x.length;
  cz /= route.x.length;
  let R = 0;
  for (let i = 0; i < route.x.length; i++) R = Math.max(R, Math.hypot(route.x[i] - cx, route.z[i] - cz));
  const r = rng(route.seed + 99);
  const g = new THREE.Group();
  for (const [ring, count, hMin, hMax, color] of [
    [R + 1600, 46, 180, 420, '#7f97ad'],
    [R + 3000, 40, 300, 700, '#a3b7c9'],
  ] as const) {
    const mat = new THREE.MeshLambertMaterial({ color, flatShading: true, fog: false });
    const snow = new THREE.MeshLambertMaterial({ color: '#f4f7fb', flatShading: true, fog: false });
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + r() * 0.1;
      const d = ring + (r() - 0.5) * 600;
      // keep every mountain's base well clear of the course
      const w = Math.min((d - R) * 0.75, (hMin + r() * (hMax - hMin)) * (1.2 + r() * 1.2));
      const h = Math.max(hMin * 0.6, Math.min(hMax, w / (1.2 + r() * 0.6)));
      const geo = new THREE.ConeGeometry(w, h, 5 + Math.floor(r() * 3), 1);
      const peak = new THREE.Mesh(geo, mat);
      peak.position.set(cx + Math.cos(a) * d, minY + h / 2 - 40, cz + Math.sin(a) * d);
      peak.rotation.y = r() * Math.PI;
      g.add(peak);
      if (h > 700) {
        const capH = h * 0.22;
        const cap = new THREE.Mesh(new THREE.ConeGeometry(w * 0.22 * 1.02, capH, geo.parameters.radialSegments, 1), snow);
        cap.position.copy(peak.position).add(new THREE.Vector3(0, h / 2 - capH / 2 + 1, 0));
        cap.rotation.y = peak.rotation.y;
        g.add(cap);
      }
    }
  }
  return g;
}

/**
 * Cumulus layer: 40 camera-facing quads in ONE draw call (40 sprites were 40 draws).
 * All clouds are the same white, so blending them unsorted gives the same result.
 */
function buildClouds(route: Route, height = 500): THREE.Mesh {
  const r = rng(route.seed + 5);
  const tex = cloudTexture();
  let cx = 0;
  let cz = 0;
  let maxY = -Infinity;
  for (let i = 0; i < route.x.length; i++) {
    cx += route.x[i];
    cz += route.z[i];
    maxY = Math.max(maxY, route.y[i]);
  }
  cx /= route.x.length;
  cz /= route.x.length;
  const N = 40;
  const corner = new Float32Array(N * 4 * 3);
  const uv = new Float32Array(N * 4 * 2);
  const center = new Float32Array(N * 4 * 3);
  const size = new Float32Array(N * 4 * 2);
  const alpha = new Float32Array(N * 4);
  const idx: number[] = [];
  const CORNERS = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
  for (let k = 0; k < N; k++) {
    const op = 0.75 + r() * 0.2;
    const a = r() * Math.PI * 2;
    const d = 800 + r() * 4500;
    const px = cx + Math.cos(a) * d;
    const py = maxY + height + r() * 700;
    const pz = cz + Math.sin(a) * d;
    const sc = 500 + r() * 900;
    for (let v = 0; v < 4; v++) {
      const o = k * 4 + v;
      corner.set([CORNERS[v * 2], CORNERS[v * 2 + 1], 0], o * 3);
      uv.set([CORNERS[v * 2] + 0.5, CORNERS[v * 2 + 1] + 0.5], o * 2);
      center.set([px, py, pz], o * 3);
      size.set([sc * 1.8, sc * 0.7], o * 2);
      alpha[o] = op;
    }
    const b = k * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(corner, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('center', new THREE.BufferAttribute(center, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 2));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { map: { value: tex } },
    vertexShader: /* glsl */ `
      attribute vec3 center; attribute vec2 size; attribute float alpha;
      varying vec2 vUv; varying float vAlpha;
      void main(){
        vUv = uv; vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(center, 1.0);
        mv.xy += position.xy * size; // billboard: offset in view space, like a sprite
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv; varying float vAlpha;
      void main(){
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(t.rgb, t.a * vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false; // one draw for the whole sky; bounds would only be approximate anyway
  return m;
}

// ---------------------------------------------------------------------------
// Rider
// ---------------------------------------------------------------------------
interface RiderModel {
  group: THREE.Group; // positioned on the road, yaw only
  bike: THREE.Group; // pitched to the grade
  wheels: THREE.Group[];
  crank: THREE.Group;
  pedals: THREE.Object3D[];
  legs: THREE.Mesh[]; // thighL, thighR, shinL, shinR
  torso: THREE.Group;
}

function buildRider(): RiderModel {
  const group = new THREE.Group();
  const bike = new THREE.Group();
  group.add(bike);
  const frameMat = new THREE.MeshStandardMaterial({ color: '#d7362b', metalness: 0.5, roughness: 0.35 });
  const black = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.8 });
  const silver = new THREE.MeshStandardMaterial({ color: '#c9ced6', metalness: 0.8, roughness: 0.3 });
  const skin = new THREE.MeshStandardMaterial({ color: '#d9a982', roughness: 0.8 });
  const jersey = new THREE.MeshStandardMaterial({ color: '#1f6feb', roughness: 0.6 });
  const shorts = new THREE.MeshStandardMaterial({ color: '#16181c', roughness: 0.7 });

  const bar = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, r2 = r) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, a.distanceTo(b), 8), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = true;
    return m;
  };
  const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);
  const small = <T extends THREE.Object3D>(o: T) => ((o.userData.noShadow = true), o);

  // wheels with visible spokes so rotation reads clearly
  const wheels: THREE.Group[] = [];
  for (const x of [-0.5, 0.5]) {
    const w = new THREE.Group();
    w.position.set(x, 0.34, 0);
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.025, 8, 32), black);
    tyre.castShadow = true;
    w.add(tyre, small(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 6, 32), silver)));
    for (let k = 0; k < 6; k++) {
      const s = small(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.6, 0.008), silver));
      s.rotation.z = (k / 6) * Math.PI;
      w.add(s);
    }
    w.add(small(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 10).rotateX(Math.PI / 2), silver)));
    bike.add(w);
    wheels.push(w);
  }

  const bb = V(0, 0.3);
  const seatTop = V(-0.17, 0.82);
  const headTop = V(0.36, 0.8);
  const headBot = V(0.4, 0.66);
  [
    [bb, seatTop, 0.022],
    [bb, headBot, 0.026],
    [seatTop, headTop, 0.02],
    [V(-0.5, 0.34), bb, 0.016],
    [V(-0.5, 0.34), V(-0.15, 0.78), 0.014],
    [headBot, V(0.5, 0.34), 0.016],
    [headTop, headBot, 0.026],
  ].forEach(([a, b, r]) => bike.add(bar(a as THREE.Vector3, b as THREE.Vector3, r as number, frameMat)));
  bike.add(small(bar(V(-0.17, 0.82), V(-0.2, 0.92), 0.012, silver))); // seatpost
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.12), black);
  saddle.position.set(-0.19, 0.94, 0);
  bike.add(saddle);
  bike.add(small(bar(V(0.36, 0.8), V(0.42, 0.95), 0.014, silver))); // stem
  bike.add(small(bar(V(0.42, 0.95, -0.21), V(0.42, 0.95, 0.21), 0.012, black))); // bars
  for (const z of [-0.21, 0.21]) bike.add(small(bar(V(0.42, 0.95, z), V(0.5, 0.83, z), 0.012, black))); // drops

  // crank + pedals
  const crank = new THREE.Group();
  crank.position.copy(bb);
  bike.add(crank);
  crank.add(small(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 20).rotateX(Math.PI / 2).translate(0, 0, 0.06), silver)));
  const pedals: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const arm = small(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.015), silver));
    arm.position.set(0, (0.17 / 2) * side, 0.08 * side);
    crank.add(arm);
    const pedal = new THREE.Object3D();
    pedal.position.set(0, 0.17 * side, 0.11 * side);
    crank.add(pedal);
    pedals.push(pedal);
  }

  // upper body (leans more on climbs/efforts — animated)
  const torso = new THREE.Group();
  torso.position.set(-0.17, 0.98, 0);
  bike.add(torso);
  torso.add(bar(V(0, 0), V(0.42, 0.33), 0.14, jersey, 0.16));
  torso.add(bar(V(-0.02, -0.02, 0), V(0.05, 0.02, 0), 0.15, shorts));
  for (const z of [-0.17, 0.17]) {
    torso.add(bar(V(0.4, 0.3, z * 0.9), V(0.52, 0.12, z * 1.1), 0.045, jersey));
    torso.add(bar(V(0.52, 0.12, z * 1.1), V(0.6, -0.04, z * 1.2), 0.038, skin));
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), skin);
  head.position.set(0.52, 0.46, 0);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.128, 14, 10, 0, Math.PI * 2, 0, Math.PI / 1.8), new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.4 }));
  helmet.position.copy(head.position).add(V(-0.01, 0.015));
  helmet.scale.set(1.25, 1, 1);
  torso.add(head, helmet);

  const legs: THREE.Mesh[] = [];
  for (let k = 0; k < 4; k++) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(k < 2 ? 0.065 : 0.048, k < 2 ? 0.05 : 0.04, 1, 8), k < 2 ? shorts : skin);
    m.castShadow = true;
    bike.add(m);
    legs.push(m);
  }
  // only the parts big enough to read in a shadow cast one (spokes, cockpit and crank don't)
  group.traverse((o) => ((o as THREE.Mesh).castShadow = !o.userData.noShadow));
  return { group, bike, wheels, crank, pedals, legs, torso };
}

// ---------------------------------------------------------------------------
// Arches
// ---------------------------------------------------------------------------
interface ArchObj {
  group: THREE.Group;
  /** the frame: solid, lit, glowing in the zone colour */
  mat: THREE.MeshStandardMaterial;
  /** additive glow pieces (curtain, ground strip) tinted with the zone colour */
  glow: THREE.MeshBasicMaterial[];
  /** shimmering curtain texture (scrolled each frame) */
  curtainTex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  lastText: string;
}

/** Height of the gantry's crossbar centreline above the road (m). */
const ARCH_H = 5.4;

/** Grayscale curtain: bright at the base and under the crossbar, faint in the middle, with soft vertical bands. */
function curtainTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(255,255,255,0.55)');
  v.addColorStop(0.22, 'rgba(255,255,255,0.12)');
  v.addColorStop(0.7, 'rgba(255,255,255,0.18)');
  v.addColorStop(1, 'rgba(255,255,255,0.85)');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = v;
  g.fillRect(0, 0, 256, 256);
  // soft bands that scroll upwards
  g.globalCompositeOperation = 'lighter';
  for (let y = 0; y < 256; y += 32) {
    const b = g.createLinearGradient(0, y, 0, y + 32);
    b.addColorStop(0, 'rgba(255,255,255,0)');
    b.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    b.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = b;
    g.fillRect(0, y, 256, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Soft-edged glow for the strip across the road (bright line, fading either side). */
function stripTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 128);
  v.addColorStop(0, '#000');
  v.addColorStop(0.42, '#555');
  v.addColorStop(0.5, '#fff');
  v.addColorStop(0.58, '#555');
  v.addColorStop(1, '#000');
  g.fillStyle = v;
  g.fillRect(0, 0, 8, 128);
  return new THREE.CanvasTexture(c);
}

/**
 * Interval gate: a broad, flat-topped gantry with rounded corners spanning the
 * road, a translucent glowing curtain to ride through, a light strip across the
 * road at the exact finish line and a countdown banner on the crossbar.
 * Local frame: +x is the direction of travel, z is across the road.
 */
function buildArch(opacity: number): ArchObj {
  const g = new THREE.Group();
  const faded = opacity < 1;
  const mat = new THREE.MeshStandardMaterial({ color: '#f2c94c', emissive: '#f2c94c', emissiveIntensity: 0.7, transparent: faded, opacity, roughness: 0.35, metalness: 0.1 });
  const half = ROAD_HALF + 1.1;
  const r = 1.3; // corner radius

  // frame: one tube along a rounded rectangle (legs + crossbar), in the z-y plane
  const path = new THREE.Path();
  path.moveTo(-half, 0);
  path.lineTo(-half, ARCH_H - r);
  path.absarc(-half + r, ARCH_H - r, r, Math.PI, Math.PI / 2, true);
  path.lineTo(half - r, ARCH_H);
  path.absarc(half - r, ARCH_H - r, r, Math.PI / 2, 0, true);
  path.lineTo(half, 0);
  const pts = path.getSpacedPoints(160).map((p) => new THREE.Vector3(0, p.y, p.x));
  const frame = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 200, 0.3, 12, false), mat);
  frame.castShadow = !faded;
  g.add(frame);
  // a slimmer inner rail, set in from the frame, for depth
  const inner = path.getSpacedPoints(160).map((p) => new THREE.Vector3(0, p.y * 0.93, p.x * 0.93));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(inner, false, 'centripetal'), 200, 0.09, 8, false), mat));
  // feet
  for (const z of [-half, half]) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.25, 1.1).translate(0, 0.12, 0), mat);
    foot.position.z = z;
    g.add(foot);
  }

  // curtain: translucent, additive, tinted with the zone colour
  const curtainTex = curtainTexture();
  const glowBase = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false } as const;
  const curtainMat = new THREE.MeshBasicMaterial({ ...glowBase, map: curtainTex, color: '#f2c94c', opacity: 0.8 * opacity });
  const curtain = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 * 0.93, ARCH_H * 0.93).translate(0, (ARCH_H * 0.93) / 2, 0), curtainMat);
  curtain.rotation.y = Math.PI / 2;
  g.add(curtain);

  // light strip across the road at the line
  const stripMat = new THREE.MeshBasicMaterial({ ...glowBase, map: stripTexture(), color: '#f2c94c', opacity: opacity });
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(3, half * 2), stripMat);
  strip.rotation.x = -Math.PI / 2;
  strip.position.y = 0.04;
  g.add(strip);

  // countdown banner on the crossbar, facing the oncoming rider
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.8), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, side: THREE.DoubleSide }));
  sign.rotation.y = -Math.PI / 2;
  sign.position.set(-0.4, ARCH_H - 0.55, 0);
  g.add(sign);
  return { group: g, mat, glow: [curtainMat, stripMat], curtainTex, canvas, tex, lastText: '' };
}

function setArchColor(a: ArchObj, color: string) {
  a.mat.color.set(color);
  a.mat.emissive.set(color);
  for (const m of a.glow) m.color.set(color);
}

/** Curtain shimmer drifts upward; the strip breathes gently. */
function animateArch(a: ArchObj, time: number, opacity: number) {
  a.curtainTex.offset.y = -time * 0.35;
  a.glow[1].opacity = opacity * (0.75 + 0.25 * Math.sin(time * 4));
}

function drawLabel(a: Pick<ArchObj, 'canvas' | 'tex' | 'lastText'>, big: string, small: string, color: string) {
  const text = big + '|' + small + '|' + color;
  if (text === a.lastText) return;
  a.lastText = text;
  const g = a.canvas.getContext('2d')!;
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = 'rgba(10,12,16,0.88)';
  g.beginPath();
  g.roundRect(10, 10, 1004, 236, 40);
  g.fill();
  g.strokeStyle = color;
  g.lineWidth = 12;
  g.stroke();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 120px system-ui, sans-serif';
  g.fillText(big, 520, 100);
  g.font = '600 52px system-ui, sans-serif';
  g.fillStyle = '#cfd6e0';
  g.fillText(small, 520, 200);
  a.tex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Free GPU resources (geometries, materials, their textures) under `root`. */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    mats.forEach((x) => {
      (x as THREE.MeshBasicMaterial).map?.dispose();
      // custom shaders hold their textures in uniforms
      const u = (x as THREE.ShaderMaterial).uniforms;
      if (u) for (const k in u) (u[k]?.value as THREE.Texture | undefined)?.isTexture && (u[k].value as THREE.Texture).dispose();
      x.dispose();
    });
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
  });
}

// scratch objects for the per-frame rider animation (no garbage per frame)
const LEG_TMP = { hip: new THREE.Vector3(), foot: new THREE.Vector3(), knee: new THREE.Vector3(), dir: new THREE.Vector3(), fwd: new THREE.Vector3(), inv: new THREE.Matrix4() };
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _limbDir = new THREE.Vector3();
/** Stretch a unit-length, y-aligned cylinder between a and b. */
function setLimb(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.scale.set(1, a.distanceTo(b), 1);
  m.quaternion.setFromUnitVectors(Y_AXIS, _limbDir.subVectors(b, a).normalize());
}

/** The 3D world view. Reads the session each frame; never changes it. */
/** Draws on top of a screenshot (e.g. the ride's stats); w × h is the photo size. */
export type CaptureOverlay = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export class WorldView {
  private renderer: THREE.WebGLRenderer;
  /** pending screenshot requests, served right after the next frame renders */
  private captures: { maxWidth: number; overlay?: CaptureOverlay; resolve: (b: Blob | null) => void }[] = [];
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.3, 12000);
  private rider: RiderModel;
  private arch: ArchObj;
  private nextArch: ArchObj;
  private portal: PortalObj;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /** unit vector towards the sun (the light and the physical sky share it) */
  private sunDir = new THREE.Vector3(80, 140, 50).normalize();
  private sky: THREE.Mesh | null = null;
  private post: PostFX | null = null;
  private envMap: THREE.Texture | null = null;
  private t0 = performance.now();
  /** live effort → world reactions (wind, clouds, grading, glow, camera) */
  private effortMeter = new EffortMeter();
  private reactivity = 1;
  private sprintK = 1;
  private archFollow = new ArchFollower();
  private nextArchFollow = new ArchFollower();
  /** lowers resolution (then AO) when the frame rate drops; see adaptive.ts */
  private adaptive: AdaptiveQuality;
  /** headlamp + rider fill (night themes); separate from the rider so it stays on in first person */
  private lampRig: THREE.Group | null = null;
  private raf = 0;
  private ro: ResizeObserver;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  /** reused output of cameraTargets */
  private camTgt = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  private crankAngle = 0;
  private wheelAngle = 0;
  private last = performance.now();
  // Smoothed render state (the ride logic updates at 10 Hz; we render at display rate)
  private motion = new MotionSmoother();
  private speed = 0;
  private pitch = 0;
  private cadence = 0;
  /** what's drawn: the route with exaggerated elevation */
  private route: ReturnType<typeof exaggerateRoute>;
  private camMode: CameraMode = 'chase';
  private effort = 0;
  private exaggeration: number;
  private theme!: ReturnType<typeof themeFor>;
  private high = true;
  /** everything built from the (exaggerated) route: terrain, road, scenery, ground */
  private world = Object.assign(new THREE.Group(), { name: 'route-world' });
  private viewHooks: ViewHook[] = [];
  /** the session route the world was built for (portal runs replace it mid-ride) */
  private builtFor: Route;
  private routeEpoch: number;
  /** a portal swap is under way: the old world is gone, the new one compiling, the flash covering it */
  private swapping = false;
  private disposed = false;
  /** the flash is showing the approach wash */
  private washing = false;
  /** last frame's portal charge, for the camera's FOV pull */
  private portalPull = 0;
  /** full-screen flash that hides a portal swap */
  private flash: HTMLDivElement;

  constructor(
    private container: HTMLElement,
    private session: RideSession,
    quality: 'high' | 'low' = 'high',
    exaggeration = 1.8,
  ) {
    this.exaggeration = exaggeration;
    this.route = exaggerateRoute(session.route, exaggeration);
    const high = quality === 'high';
    // High quality renders through the post chain, whose multisampled HDR target does the
    // antialiasing; a multisampled canvas would just be an unused buffer (and Low never had one).
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.adaptive = new AdaptiveQuality(qualityLevels(quality, window.devicePixelRatio));
    this.renderer.setPixelRatio(this.adaptive.level.pixelRatio);
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.high = high;
    this.builtFor = session.route;
    this.routeEpoch = session.routeEpoch;
    this.hemi = new THREE.HemisphereLight();
    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    // The shadow box is centred SHADOW_AHEAD metres up the road (see loop): the camera looks
    // forward, so a box centred on the rider spent almost half its texels behind the lens.
    const sm = this.adaptive.level.shadowMap;
    this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.bias = -0.0005;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_HALF;
    sc.right = SHADOW_HALF;
    sc.top = SHADOW_HALF;
    sc.bottom = -SHADOW_HALF;
    sc.far = 400;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.applyTheme(themeFor(session.route));

    this.scene.add(this.world);
    this.buildWorld();
    if (high) this.post = new PostFX(this.renderer, this.scene, this.camera, this.theme.bloom ?? DEFAULT_BLOOM);

    this.rider = buildRider();
    this.scene.add(this.rider.group);
    this.arch = buildArch(1);
    this.nextArch = buildArch(0.35);
    this.portal = buildPortal(stripTexture());
    this.portal.group.visible = false;
    this.scene.add(this.arch.group, this.nextArch.group, this.portal.group);

    this.flash = document.createElement('div');
    Object.assign(this.flash.style, { position: 'absolute', inset: '0', pointerEvents: 'none', opacity: '0', background: '#fff' });
    container.appendChild(this.flash);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    this.placeAt(session.snapshot().routeDistance);
    this.camera.fov = CAMERA_RIGS[this.camMode].fov;
    this.camera.updateProjectionMatrix();
    this.loop();
  }

  /**
   * Sky, fog, lights, exposure, glow and headlamp for a theme. Called once at start and
   * again whenever a portal takes you into another world.
   */
  private applyTheme(theme: Theme) {
    this.theme = theme;
    const high = this.high;
    this.renderer.toneMappingExposure = theme.exposure;
    const haze = theme.id === 'countryside' ? HAZE : new THREE.Color(theme.haze);
    this.scene.fog = new THREE.Fog(haze, theme.fogNear, theme.fogFar);
    this.sunDir.set(80, 140, 50).normalize();
    if (theme.sun) sunDirection(theme.sun.elevation, theme.sun.azimuth, this.sunDir);

    if (this.sky) {
      this.scene.remove(this.sky);
      disposeTree(this.sky);
    }
    this.envMap?.dispose();
    this.envMap = null;
    this.scene.environment = null;
    if (theme.physicalSky !== false) {
      const sky = buildPhysicalSky({ ...DEFAULT_SKY, ...theme.sky }, this.sunDir, haze);
      this.sky = sky;
      // image-based lighting from the sky for the PBR materials (rider, arches)
      this.envMap = bakeEnvironment(this.renderer, sky);
      this.scene.environment = this.envMap;
      this.scene.environmentIntensity = 0.55;
    } else {
      this.sky = theme.id === 'countryside' ? buildSky() : buildSky(new THREE.Color(theme.skyTop), new THREE.Color(theme.skyHorizon));
    }
    this.scene.add(this.sky);

    this.hemi.color.set(theme.hemiSky);
    this.hemi.groundColor.set(theme.hemiGround);
    this.hemi.intensity = theme.hemiIntensity;
    this.sun.color.set(theme.sunColor);
    this.sun.intensity = theme.sunIntensity;
    this.post?.setBloom(theme.bloom ?? DEFAULT_BLOOM);

    if (this.lampRig) {
      this.scene.remove(this.lampRig);
      disposeTree(this.lampRig);
      this.lampRig = null;
    }
    if (theme.headlamp) {
      // a cool-white lamp on the bars throwing a soft pool ~20 m up the road
      const lamp = new THREE.SpotLight('#f4f1ff', high ? 60 : 45, 70, 0.42, 0.75, 1.4);
      lamp.position.set(0.45, 1.0, 0);
      lamp.target.position.set(22, 0, 0);
      this.lampRig = new THREE.Group();
      this.lampRig.add(lamp, lamp.target);
      this.scene.add(this.lampRig);
      // short-range fill so the rider reads against the dark (falls off before the scenery)
      const fill = new THREE.PointLight('#c9d6ff', 2.2, 7, 2);
      fill.position.set(-3, 2.5, 1.5);
      this.lampRig.add(fill);
    }
  }

  /** Jump the smoothed motion and the camera to a route distance (start, or arriving through a portal). */
  private placeAt(d: number) {
    this.motion = new MotionSmoother(d);
    this.archFollow = new ArchFollower();
    this.nextArchFollow = new ArchFollower();
    const t0 = cameraTargets(this.route, d, 1.7, CAMERA_RIGS[this.camMode]);
    this.camPos.copy(t0.pos);
    this.camLook.copy(t0.look);
    this.pitch = 0;
  }

  /**
   * A portal moved the session to another world. The flash goes fully white, then (once
   * the browser has painted it) the old world is torn down and the new one built, its
   * shaders compiled off the main thread where the GPU driver allows, and the flash fades
   * out over the new world. The build itself blocks for a moment, but behind solid white.
   */
  private beginSwap() {
    this.swapping = true;
    this.washing = false;
    this.routeEpoch = this.session.routeEpoch;
    this.flash.style.transition = 'none';
    this.flash.style.background = '#fff';
    this.flash.style.opacity = '1';
    // two frames: the first paints the white, the second runs after it is on screen
    requestAnimationFrame(() => requestAnimationFrame(() => void this.finishSwap()));
  }

  private async finishSwap() {
    if (this.disposed) return;
    releaseWorld(this.builtFor);
    for (const child of [...this.world.children]) {
      this.world.remove(child);
      disposeTree(child);
    }
    this.builtFor = this.session.route;
    this.routeEpoch = this.session.routeEpoch;
    this.route = exaggerateRoute(this.session.route, this.exaggeration);
    this.applyTheme(themeFor(this.session.route));
    this.buildWorld();
    this.post?.invalidateScene();
    this.placeAt(this.session.snapshot().routeDistance);
    this.portal.group.visible = false;
    this.arch.group.visible = false;
    this.nextArch.group.visible = false;
    try {
      // compile the new world's materials before showing it (bounded, in case a driver stalls)
      await Promise.race([this.renderer.compileAsync(this.scene, this.camera), new Promise((r) => setTimeout(r, 4000))]);
    } catch {
      // first frames compile whatever is left
    }
    if (this.disposed) return;
    this.swapping = false;
    this.last = performance.now();
    this.flash.style.transition = 'opacity 0.9s ease-out';
    this.flash.style.opacity = '0';
  }

  /** (Re)build all route-derived scenery into `this.world` from `this.route`. */
  private buildWorld() {
    const route = this.route; // drawn with visual grade exaggeration
    const theme = this.theme;
    const high = this.high;
    const w = this.world;
    // the landscape itself (not road furniture, clouds or far backdrops): also drawn on the minimap
    let land: THREE.Object3D[];
    if (theme.build) {
      // themed landscape: the theme supplies terrain & scenery; road furniture is shared
      land = theme.build(route, { high, sunDir: this.sunDir.clone() });
      w.add(...land, buildRoad(route, theme.roadTexture?.()), buildClimbSigns(route));
      if (theme.posts !== false) w.add(buildPosts(route));
      if (theme.clouds) w.add(buildClouds(route, theme.cloudHeight));
    } else {
      land = [buildTerrain(route), buildVegetation(route, high ? 1 : 0.45), buildBuildings(route)];
      w.add(...land, buildRoad(route), buildPosts(route), buildClimbSigns(route), buildMountains(route), buildClouds(route));
    }
    let minY = Infinity;
    for (const y of route.y) minY = Math.min(minY, y);
    if (theme.groundColor) {
      const ground = new THREE.Mesh(new THREE.CircleGeometry(12000, 48), new THREE.MeshLambertMaterial({ color: theme.groundColor }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = minY - 30;
      w.add(ground);
      land.push(ground);
    }
    registerWorld(this.builtFor, route, land);
    // shader-level life: drifting cloud shadows over everything, wind in the foliage
    applyWorldFx(w, { cloudShadows: theme.cloudShadows ?? (theme.clouds ? 0.45 : 0), wind: true });
    // per-frame camera hooks (e.g. distance LOD for instanced scenery)
    this.viewHooks = [];
    w.traverse((o) => {
      if (o.userData.onView) this.viewHooks.push(o.userData.onView as ViewHook);
    });
  }

  /**
   * Change the visual hill exaggeration live. Rebuilds every route-derived mesh
   * (terrain, road, scenery, signs, ground); the rider, arches and camera follow
   * `this.route` each frame so they pick up the new heights automatically.
   * Purely visual: the session (physics, trainer, HUD grade) uses the true route.
   */
  setGradeExaggeration(k: number) {
    k = Math.min(3, Math.max(1, k));
    if (Math.abs(k - this.exaggeration) < 1e-6) return;
    this.exaggeration = k;
    this.route = exaggerateRoute(this.builtFor, k);
    for (const child of [...this.world.children]) {
      this.world.remove(child);
      disposeTree(child);
    }
    this.buildWorld();
    this.post?.invalidateScene();
    // the camera eases its height toward the new road (see loop), so no pop
  }
  /** Sprint "rush" strength (speed blur, FOV kick, glow flare): 0 = off, 1 = normal, up to 1.5. */
  setSprintEffect(k: number) {
    this.sprintK = Math.min(1.5, Math.max(0, k));
  }

  /** Live render stats for the in-ride FPS readout. */
  get stats() {
    const l = this.adaptive.level;
    return { fps: this.adaptive.fps, pixelRatio: l.pixelRatio, ao: !!this.post && l.ao, level: this.adaptive.index, levels: this.adaptive.levels.length };
  }

  private applyQuality() {
    const l = this.adaptive.level;
    this.renderer.setPixelRatio(l.pixelRatio);
    if (this.post) {
      this.post.composer.setPixelRatio(l.pixelRatio);
      this.post.setQuality(l);
    }
    if (this.sun.shadow.mapSize.x !== l.shadowMap) {
      this.sun.shadow.mapSize.set(l.shadowMap, l.shadowMap);
      // drop the old map; the renderer allocates one at the new size next frame
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.resize();
  }

  /** How strongly the world reacts to effort: 0 = off, 1 = normal, up to 1.5 = dramatic. */
  setEffortReactions(k: number) {
    this.reactivity = Math.min(1.5, Math.max(0, k));
  }

  get gradeExaggeration() {
    return this.exaggeration;
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.post?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private place(obj: THREE.Object3D, distance: number, lateral = 0) {
    const p = this.route.at(distance);
    obj.position.set(p.x - Math.sin(p.heading) * lateral, p.y, p.z + Math.cos(p.heading) * lateral);
    obj.rotation.set(0, -p.heading, 0);
    return p;
  }

  /** Switch camera: 'chase' (Zwift-style default), 'close', or 'first' person. */
  setCamera(mode: CameraMode) {
    this.camMode = mode;
  }
  get cameraMode() {
    return this.camMode;
  }

  private updateLegs() {
    const r = this.rider;
    const { hip, foot, knee, dir, fwd, inv } = LEG_TMP;
    r.bike.updateMatrixWorld(true);
    inv.copy(r.bike.matrixWorld).invert();
    r.pedals.forEach((pd, k) => {
      const side = k === 0 ? 1 : -1;
      pd.getWorldPosition(foot);
      foot.applyMatrix4(inv);
      foot.z = 0.11 * side;
      // hip follows the torso (which moves forward when standing / pushing)
      hip.set(-0.17 + r.torso.position.x + 0.17, r.torso.position.y - 0.02, 0.09 * side);
      const L = 0.45;
      const d = Math.min(hip.distanceTo(foot), 2 * L - 0.002);
      const hgt = Math.sqrt(Math.max(0, L * L - (d / 2) * (d / 2)));
      dir.subVectors(foot, hip).normalize();
      fwd.set(-dir.y, dir.x, 0); // knee points forward/up
      if (fwd.x < 0) fwd.negate();
      knee.addVectors(hip, foot).multiplyScalar(0.5).addScaledVector(fwd, hgt);
      setLimb(r.legs[k], hip, knee);
      setLimb(r.legs[k + 2], knee, foot);
    });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(0.1, rawDt);
    this.last = now;
    if (this.swapping) return;
    const s = this.session.snapshot();
    // a portal moved you to another world: rebuild behind the flash
    if (s.routeEpoch !== this.routeEpoch) return this.beginSwap();
    if (this.adaptive.frame(rawDt)) this.applyQuality();
    const route = this.route;

    // --- smooth motion: predict with speed, gently correct toward the true distance
    const d = this.motion.update(dt, s.routeDistance, s.speed);
    this.speed = this.motion.speed;
    const trace = (window as unknown as { __rbTrace?: number[] }).__rbTrace;
    if (trace) trace.push(d, now);

    // --- rider
    this.place(this.rider.group, d, 1.7);
    if (this.lampRig) {
      this.lampRig.position.copy(this.rider.group.position);
      this.lampRig.rotation.copy(this.rider.group.rotation);
    }
    // pitch from the local road slope over the wheelbase, smoothed
    const slope = Math.atan2(route.at(d + 0.6).y - route.at(d - 0.6).y, 1.2);
    this.pitch += (slope - this.pitch) * (1 - Math.exp(-dt * 8));
    this.rider.bike.rotation.z = this.pitch;
    this.wheelAngle -= (this.speed / 0.34) * dt;
    this.rider.wheels.forEach((w) => (w.rotation.z = this.wheelAngle));
    this.cadence += ((s.cadence || 0) - this.cadence) * (1 - Math.exp(-dt * 4));
    this.crankAngle -= (this.cadence / 60) * Math.PI * 2 * dt;
    this.rider.crank.rotation.z = this.crankAngle;
    // body: lean forward with effort & climbing (torso stays steady, no side-to-side rock)
    const ftp = this.session.engine?.ftp ?? this.session.ftp ?? 200;
    const effortTarget = Math.min(1.5, (s.power3s || 0) / ftp);
    this.effort += (effortTarget - this.effort) * (1 - Math.exp(-dt * 2));
    const climbing = Math.max(0, Math.min(1, (s.grade - 0.04) / 0.05)) * Math.min(1, this.effort); // true grade
    const bikeRock = Math.sin(this.crankAngle) * 0.06 * climbing; // bike rocks when climbing hard
    this.rider.bike.rotation.x = bikeRock;
    // the torso is parented to the bike, so cancel the bike's rock to keep it upright
    this.rider.torso.rotation.set(-bikeRock, 0, -0.08 * this.effort - 0.05 * climbing);
    this.rider.torso.position.set(-0.17 + 0.12 * climbing, 0.98 + 0.08 * climbing, 0);
    this.updateLegs();

    // --- camera (Zwift-style rigs; see camera.ts). Sits in the road's frame so
    // climbs look like climbs; smoothed so it glides rather than snaps.
    const rig = CAMERA_RIGS[this.camMode];
    this.rider.group.visible = rig.showRider;
    const tgt = cameraTargets(route, d, 1.7, rig, this.camTgt);
    // Follow exactly along the road (d is already smooth, so no lag at speed);
    // only ease the heights so bumps in the terrain don't jolt the view.
    const k = 1 - Math.exp(-dt * (this.camMode === 'first' ? 12 : 5));
    this.camPos.set(tgt.pos.x, this.camPos.y + (tgt.pos.y - this.camPos.y) * k, tgt.pos.z);
    this.camLook.set(tgt.look.x, this.camLook.y + (tgt.look.y - this.camLook.y) * k, tgt.look.z);
    if (Math.abs(this.camPos.y - tgt.pos.y) > 30) this.camPos.y = tgt.pos.y; // after jumps
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // a sprint widens the view for a rush of speed (and so does the pull of a portal)
    const fovTarget = rig.fov + 7 * fxSurge.value + 14 * this.portalPull;
    if (Math.abs(this.camera.fov - fovTarget) > 0.05) {
      this.camera.fov += (fovTarget - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }

    this.sky!.position.copy(this.camera.position);
    // shadow box centred up the road, where the camera is looking
    const ahead = route.at(d + SHADOW_AHEAD);
    this.sun.target.position.set(ahead.x, ahead.y, ahead.z);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 170);

    // --- arches: placed from the smoothed rider distance and the workout clock run
    // forward to this frame (it only ticks at 10 Hz), so they hold still in the world
    // instead of creeping forward with you and snapping back every tick.
    const st = s.workout;
    const vArch = this.session.arch.projectedSpeed;
    const age = s.started && !s.paused ? Math.min(0.2, Math.max(0, (now - this.session.tickAt) / 1000)) : 0;
    const archAt = (remaining: number) => d + vArch * Math.max(0, remaining - age);
    const archD = this.archFollow.update(dt, st && s.archDistance != null && st.interval ? archAt(st.remaining) : undefined);
    const nextD = this.nextArchFollow.update(dt, st && s.nextArchDistance != null && st.next ? archAt(st.remaining + st.next.duration) : undefined);
    let charge = 0;
    if (st && archD != null && st.interval) {
      const next = st.next;
      const color = next ? (next.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(next, ftp)).color) : '#ffffff';
      const intensity = st.intensity / 100;
      const nextTxt = next
        ? next.free
          ? `Next: ${formatDuration(next.duration)} free ride`
          : `Next: ${formatDuration(next.duration)} @ ${Math.round(toWatts((next.powerStart + next.powerEnd) / 2, next.unit, ftp) * intensity)} W`
        : 'Workout complete!';
      if (s.portal) {
        // portal run: the gate is a portal, charging up over the last couple of seconds
        this.arch.group.visible = false;
        this.portal.group.visible = true;
        this.place(this.portal.group, archD);
        const left = Math.max(0, st.remaining - age);
        charge = s.paused ? 0 : Math.max(0, Math.min(1, 1 - left / 2.5)) ** 2;
        setPortalZone(this.portal, color);
        animatePortal(this.portal, (now - this.t0) / 1000, dt, charge);
        drawLabel(this.portal, formatDuration(Math.ceil(st.remaining)), nextTxt, color);
      } else {
        this.portal.group.visible = false;
        this.arch.group.visible = true;
        this.place(this.arch.group, archD);
        setArchColor(this.arch, color);
        animateArch(this.arch, (now - this.t0) / 1000, 1);
        drawLabel(this.arch, formatDuration(Math.ceil(st.remaining)), nextTxt, color);
      }
      if (nextD != null && next) {
        this.nextArch.group.visible = true;
        this.place(this.nextArch.group, nextD);
        const nn = this.session.engine!.intervals[next.index + 1];
        const c2 = nn ? (nn.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(nn, ftp)).color) : '#ffffff';
        setArchColor(this.nextArch, c2);
        animateArch(this.nextArch, (now - this.t0) / 1000, 0.35);
        drawLabel(this.nextArch, formatDuration(Math.ceil(st.remaining + next.duration)), nn ? 'End of next interval' : 'Finish', c2);
      } else this.nextArch.group.visible = false;
    } else {
      this.arch.group.visible = false;
      this.nextArch.group.visible = false;
      this.portal.group.visible = false;
    }
    // the last half-second into a portal: the screen washes out in its colour
    const wash = Math.max(0, (charge - 0.75) / 0.25);
    if (wash > 0) {
      const c = PORTAL_VIOLET;
      this.flash.style.transition = 'none';
      this.flash.style.background = `radial-gradient(circle at 50% 55%, #fff 0%, #fff ${Math.round(20 + 40 * wash)}%, ${c} 100%)`;
      this.flash.style.opacity = (0.95 * wash * wash).toFixed(3);
      this.washing = true;
    } else if (this.washing) {
      // e.g. paused or skipped back just short of the portal
      this.washing = false;
      this.flash.style.transition = 'opacity 0.3s';
      this.flash.style.opacity = '0';
    }

    this.portalPull = charge;
    const time = (now - this.t0) / 1000;
    fxTime.value = time;
    // stopped or paused counts as zero power, so the world calms down
    const effort = this.effortMeter.update(dt, s.paused ? 0 : s.power3s || 0, ftp);
    const kR = this.reactivity;
    fxBuild.value = Math.min(1, effort.build * kR);
    fxSurge.value = Math.min(1, effort.surge * this.sprintK);
    this.theme.update?.(time, { ...effort, build: fxBuild.value, surge: fxSurge.value, level: Math.max(fxBuild.value, fxSurge.value) });
    for (const h of this.viewHooks) h(this.camera);
    if (this.post) this.post.render(dt);
    else this.renderer.render(this.scene, this.camera);
    if (this.captures.length) this.serveCaptures();
    if (trace) {
      (window as unknown as { __rbInfo?: unknown }).__rbInfo = { ...this.renderer.info.render };
      (window as unknown as { __rbScene?: unknown }).__rbScene = this.scene;
      (window as unknown as { __rbSession?: unknown }).__rbSession = this.session;
      (window as unknown as { __rbView?: unknown }).__rbView = this;
    }
  };

  /**
   * A JPEG of the 3D view (not the HTML HUD), at most `maxWidth` px wide, with
   * `overlay` drawn on top if given. Taken right after the
   * next frame renders, while the drawing buffer still holds it (the canvas isn't
   * created with preserveDrawingBuffer). Resolves null if no frame renders soon,
   * e.g. the tab is in the background.
   */
  capture(maxWidth = 1280, overlay?: CaptureOverlay): Promise<Blob | null> {
    return new Promise((resolve) => {
      let done = false;
      const once = (b: Blob | null) => {
        if (!done) {
          done = true;
          resolve(b);
        }
      };
      this.captures.push({ maxWidth, overlay, resolve: once });
      setTimeout(() => once(null), 10_000);
    });
  }

  private serveCaptures() {
    const src = this.renderer.domElement;
    const reqs = this.captures;
    this.captures = [];
    for (const r of reqs) {
      try {
        const k = Math.min(1, r.maxWidth / src.width);
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k);
        c.height = Math.round(src.height * k);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(src, 0, 0, c.width, c.height);
        r.overlay?.(ctx, c.width, c.height);
        c.toBlob((b) => r.resolve(b), 'image/jpeg', 0.88);
      } catch {
        r.resolve(null);
      }
    }
  }

  dispose() {
    for (const r of this.captures) r.resolve(null);
    this.captures = [];
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    releaseWorld(this.builtFor);
    this.flash.remove();
    this.ro.disconnect();
    disposeTree(this.scene);
    this.post?.dispose();
    this.envMap?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
