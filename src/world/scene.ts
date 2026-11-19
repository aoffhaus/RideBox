import * as THREE from 'three';
import type { RideSession } from '../app/session';
import type { Route } from './route';
import { rng } from './route';
import { MotionSmoother } from './smoother';
import { exaggerateRoute } from './route';
import { CAMERA_RIGS, cameraTargets, type CameraMode } from './camera';
import { themeFor } from './themes';
import { applyWorldFx, fxTime, windy } from './fx';
import { PostFX, DEFAULT_BLOOM } from './postfx';
import { DEFAULT_SKY, bakeEnvironment, buildPhysicalSky, sunDirection } from './sky';
import { formatDuration, intervalFtpFraction, toWatts, zoneFor } from '../workout/model';

const ROAD_HALF = 4.5;
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

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], colors?: THREE.Color[], shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, mats.length));
  m.count = mats.length;
  mats.forEach((x, k) => m.setMatrixAt(k, x));
  colors?.forEach((c, k) => m.setColorAt(k, c));
  m.castShadow = shadow;
  m.receiveShadow = false;
  return m;
}

function buildVegetation(route: Route, density = 1): THREE.Group {
  const n = route.x.length;
  const r = rng(route.seed * 31 + 7);
  const g = new THREE.Group();
  const pines: THREE.Matrix4[] = [];
  const pineCol: THREE.Color[] = [];
  const broad: THREE.Matrix4[] = [];
  const broadCol: THREE.Color[] = [];
  const trunksP: THREE.Matrix4[] = [];
  const trunksB: THREE.Matrix4[] = [];
  const rocks: THREE.Matrix4[] = [];
  const bushes: THREE.Matrix4[] = [];
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
        if (r() < 0.55 + 0.3 * forest) {
          pines.push(m);
          trunksP.push(m);
          pineCol.push(new THREE.Color().setHSL(0.31 + r() * 0.05, 0.45, 0.17 + r() * 0.08));
        } else {
          broad.push(m);
          trunksB.push(m);
          broadCol.push(new THREE.Color().setHSL(0.2 + r() * 0.1, 0.5, 0.25 + r() * 0.12));
        }
      }
      if (r() < 0.08) {
        const p = spotPos(route, { i, off: side * (ROAD_HALF + 3 + r() * 40) }, 4, r);
        const s = 0.4 + r() * 1.6;
        q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3));
        rocks.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(s, s * 0.7, s)));
      }
      if (r() < 0.25) {
        const p = spotPos(route, { i, off: side * (ROAD_HALF + 2.5 + r() * 12) }, 3, r);
        const s = 0.4 + r() * 0.7;
        bushes.push(new THREE.Matrix4().compose(p, q.identity(), new THREE.Vector3(s * 1.4, s, s * 1.4)));
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
  g.add(instanced(trunkGeo, trunkMat, [...trunksP, ...trunksB]));
  g.add(instanced(pineGeo, leafMat, pines, pineCol));
  g.add(instanced(broadGeo, windy(leafMat.clone(), 6, 0.26), broad, broadCol));
  g.add(instanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#8e8c84', flatShading: true }), rocks));
  g.add(instanced(new THREE.IcosahedronGeometry(1, 0).translate(0, 0.5, 0), windy(new THREE.MeshLambertMaterial({ color: '#4f7f36', flatShading: true }), 1.1, 0.07), bushes, undefined, false));
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
  const bodies: THREE.Matrix4[] = [];
  const bodyCol: THREE.Color[] = [];
  const roofs: THREE.Matrix4[] = [];
  const roofCol: THREE.Color[] = [];
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
      bodies.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(w, h, d)));
      bodyCol.push(new THREE.Color(barn ? '#9c2f24' : ['#efe6d2', '#e4d3b0', '#d9dfe4', '#c9b79a'][Math.floor(r() * 4)]));
      roofs.push(new THREE.Matrix4().compose(p.clone().add(new THREE.Vector3(0, h, 0)), q, new THREE.Vector3(w * 1.05, h * 0.55, d * 1.1)));
      roofCol.push(new THREE.Color(barn ? '#5b5b5b' : ['#7a3a2a', '#45484f', '#6b4b33'][Math.floor(r() * 3)]));
    }
  }
  const g = new THREE.Group();
  const body = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // triangular prism roof: ridge along local x
  const roof = new THREE.CylinderGeometry(0.5, 0.5, 1, 3, 1).rotateZ(Math.PI / 2).rotateX(Math.PI / 6 + Math.PI / 2).scale(1, 1.15, 1.15).translate(0, 0.28, 0);
  g.add(instanced(body, new THREE.MeshLambertMaterial(), bodies, bodyCol));
  g.add(instanced(roof, new THREE.MeshLambertMaterial({ flatShading: true }), roofs, roofCol));
  return g;
}

/** White roadside posts with reflectors every 25 m — they stream past and sell speed. */
function buildPosts(route: Route): THREE.Group {
  const posts: THREE.Matrix4[] = [];
  const refl: THREE.Matrix4[] = [];
  const every = Math.max(1, Math.round(25 / route.step));
  const q = new THREE.Quaternion();
  for (let i = 0; i < route.x.length; i += every) {
    for (const side of [-1, 1]) {
      const off = side * (ROAD_HALF + 1.1);
      const h = route.heading[i];
      const p = new THREE.Vector3(route.x[i] - Math.sin(h) * off, route.y[i], route.z[i] + Math.cos(h) * off);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -h);
      posts.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
      refl.push(new THREE.Matrix4().compose(p.clone().add(new THREE.Vector3(0, 0.85, 0)), q, new THREE.Vector3(1, 1, 1)));
    }
  }
  const g = new THREE.Group();
  g.add(instanced(new THREE.BoxGeometry(0.12, 1.1, 0.12).translate(0, 0.55, 0), new THREE.MeshLambertMaterial({ color: '#f4f4f4' }), posts, undefined, false));
  g.add(instanced(new THREE.BoxGeometry(0.14, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: '#ff3b2f' }), refl, undefined, false));
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
  const tall = route.preset.id === 'mountain' || route.preset.id === 'hilly';
  for (const [ring, count, hMin, hMax, color] of [
    [R + 1600, 46, tall ? 500 : 180, tall ? 1300 : 420, '#7f97ad'],
    [R + 3000, 40, tall ? 900 : 300, tall ? 2000 : 700, '#a3b7c9'],
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

function buildClouds(route: Route): THREE.Group {
  const r = rng(route.seed + 5);
  const tex = cloudTexture();
  const g = new THREE.Group();
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
  for (let k = 0; k < 40; k++) {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75 + r() * 0.2, fog: false, depthWrite: false });
    const s = new THREE.Sprite(mat);
    const a = r() * Math.PI * 2;
    const d = 800 + r() * 4500;
    s.position.set(cx + Math.cos(a) * d, maxY + 500 + r() * 700, cz + Math.sin(a) * d);
    const sc = 500 + r() * 900;
    s.scale.set(sc * 1.8, sc * 0.7, 1);
    g.add(s);
  }
  return g;
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

  // wheels with visible spokes so rotation reads clearly
  const wheels: THREE.Group[] = [];
  for (const x of [-0.5, 0.5]) {
    const w = new THREE.Group();
    w.position.set(x, 0.34, 0);
    const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.025, 8, 32), black);
    tyre.castShadow = true;
    w.add(tyre, new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 6, 32), silver));
    for (let k = 0; k < 6; k++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.6, 0.008), silver);
      s.rotation.z = (k / 6) * Math.PI;
      w.add(s);
    }
    w.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 10).rotateX(Math.PI / 2), silver));
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
  bike.add(bar(V(-0.17, 0.82), V(-0.2, 0.92), 0.012, silver)); // seatpost
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.12), black);
  saddle.position.set(-0.19, 0.94, 0);
  bike.add(saddle);
  bike.add(bar(V(0.36, 0.8), V(0.42, 0.95), 0.014, silver)); // stem
  bike.add(bar(V(0.42, 0.95, -0.21), V(0.42, 0.95, 0.21), 0.012, black)); // bars
  for (const z of [-0.21, 0.21]) bike.add(bar(V(0.42, 0.95, z), V(0.5, 0.83, z), 0.012, black)); // drops

  // crank + pedals
  const crank = new THREE.Group();
  crank.position.copy(bb);
  bike.add(crank);
  crank.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 20).rotateX(Math.PI / 2).translate(0, 0, 0.06), silver));
  const pedals: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.015), silver);
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
  group.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return { group, bike, wheels, crank, pedals, legs, torso };
}

// ---------------------------------------------------------------------------
// Arches
// ---------------------------------------------------------------------------
interface ArchObj {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  lastText: string;
}

function buildArch(opacity: number): ArchObj {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#f2c94c', emissive: '#f2c94c', emissiveIntensity: 0.55, transparent: opacity < 1, opacity, roughness: 0.4 });
  // rounded arch: half torus over the road + legs
  const span = ROAD_HALF + 0.9;
  const arc = new THREE.Mesh(new THREE.TorusGeometry(span, 0.32, 10, 40, Math.PI), mat);
  arc.rotation.y = Math.PI / 2;
  arc.position.y = 3.2;
  g.add(arc);
  for (const z of [-span, span]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 3.2, 12).translate(0, 1.6, 0), mat);
    leg.position.z = z;
    g.add(leg);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, side: THREE.DoubleSide }));
  sign.rotation.y = -Math.PI / 2;
  sign.position.set(-0.4, 3.2 + span - 0.6, 0);
  g.add(sign);
  return { group: g, mat, canvas, tex, lastText: '' };
}

function drawLabel(a: ArchObj, big: string, small: string, color: string) {
  const text = big + '|' + small + '|' + color;
  if (text === a.lastText) return;
  a.lastText = text;
  const g = a.canvas.getContext('2d')!;
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = 'rgba(10,12,16,0.88)';
  g.beginPath();
  g.roundRect(8, 8, 1008, 240, 40);
  g.fill();
  g.fillStyle = color;
  g.fillRect(8, 8, 26, 240);
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
      x.dispose();
    });
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
  });
}

/** The 3D world view. Reads the session each frame; never changes it. */
export class WorldView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.3, 12000);
  private rider: RiderModel;
  private arch: ArchObj;
  private nextArch: ArchObj;
  private sun: THREE.DirectionalLight;
  /** unit vector towards the sun (the light and the physical sky share it) */
  private sunDir = new THREE.Vector3(80, 140, 50).normalize();
  private sky: THREE.Mesh;
  private post: PostFX | null = null;
  private envMap: THREE.Texture | null = null;
  private t0 = performance.now();
  private raf = 0;
  private ro: ResizeObserver;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
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

  constructor(
    private container: HTMLElement,
    private session: RideSession,
    quality: 'high' | 'low' = 'high',
    exaggeration = 1.8,
  ) {
    this.exaggeration = exaggeration;
    this.route = exaggerateRoute(session.route, exaggeration);
    const high = quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: high, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(high ? Math.min(window.devicePixelRatio, 2) : 1);
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    const theme = themeFor(session.route);
    this.renderer.toneMappingExposure = theme.exposure;
    this.scene.fog = new THREE.Fog(theme.id === 'countryside' ? HAZE : new THREE.Color(theme.haze), theme.fogNear, theme.fogFar);
    if (theme.sun) sunDirection(theme.sun.elevation, theme.sun.azimuth, this.sunDir);
    const haze = theme.id === 'countryside' ? HAZE : new THREE.Color(theme.haze);
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
    this.scene.add(new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity));
    this.sun = new THREE.DirectionalLight(theme.sunColor, theme.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    const sc = this.sun.shadow.camera;
    sc.left = -45;
    sc.right = 45;
    sc.top = 45;
    sc.bottom = -45;
    sc.far = 400;
    this.scene.add(this.sun, this.sun.target);

    this.theme = theme;
    this.high = high;
    this.scene.add(this.world);
    this.buildWorld();
    if (high) this.post = new PostFX(this.renderer, this.scene, this.camera, theme.bloom ?? DEFAULT_BLOOM);

    this.rider = buildRider();
    this.scene.add(this.rider.group);
    this.arch = buildArch(1);
    this.nextArch = buildArch(0.35);
    this.scene.add(this.arch.group, this.nextArch.group);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    const s = session.snapshot();
    this.motion = new MotionSmoother(s.distance);
    const t0 = cameraTargets(this.route, s.distance, 1.7, CAMERA_RIGS[this.camMode]);
    this.camPos.copy(t0.pos);
    this.camLook.copy(t0.look);
    this.camera.fov = CAMERA_RIGS[this.camMode].fov;
    this.camera.updateProjectionMatrix();
    this.loop();
  }

  /** (Re)build all route-derived scenery into `this.world` from `this.route`. */
  private buildWorld() {
    const route = this.route; // drawn with visual grade exaggeration
    const theme = this.theme;
    const high = this.high;
    const w = this.world;
    if (theme.build) {
      // themed landscape: the theme supplies terrain & scenery; road furniture is shared
      w.add(...theme.build(route, { high }), buildRoad(route, theme.roadTexture?.()), buildClimbSigns(route));
      if (theme.posts !== false) w.add(buildPosts(route));
      if (theme.clouds) w.add(buildClouds(route));
    } else {
      w.add(buildTerrain(route), buildRoad(route), buildVegetation(route, high ? 1 : 0.45), buildBuildings(route), buildPosts(route), buildClimbSigns(route), buildMountains(route), buildClouds(route));
    }
    let minY = Infinity;
    for (const y of route.y) minY = Math.min(minY, y);
    if (theme.groundColor) {
      const ground = new THREE.Mesh(new THREE.CircleGeometry(12000, 48), new THREE.MeshLambertMaterial({ color: theme.groundColor }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = minY - 30;
      w.add(ground);
    }
    // shader-level life: drifting cloud shadows over everything, wind in the foliage
    applyWorldFx(w, { cloudShadows: theme.cloudShadows ?? (theme.clouds ? 0.45 : 0), wind: true });
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
    this.route = exaggerateRoute(this.session.route, k);
    for (const child of [...this.world.children]) {
      this.world.remove(child);
      disposeTree(child);
    }
    this.buildWorld();
    // the camera eases its height toward the new road (see loop), so no pop
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
    const set = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.scale.set(1, a.distanceTo(b), 1);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    };
    r.bike.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(r.bike.matrixWorld).invert();
    r.pedals.forEach((pd, k) => {
      const side = k === 0 ? 1 : -1;
      const foot = new THREE.Vector3();
      pd.getWorldPosition(foot);
      foot.applyMatrix4(inv);
      foot.z = 0.11 * side;
      // hip follows the torso (which moves forward when standing / pushing)
      const hip = new THREE.Vector3(-0.17 + r.torso.position.x + 0.17, r.torso.position.y - 0.02, 0.09 * side);
      const L = 0.45;
      const d = Math.min(hip.distanceTo(foot), 2 * L - 0.002);
      const mid = hip.clone().add(foot).multiplyScalar(0.5);
      const hgt = Math.sqrt(Math.max(0, L * L - (d / 2) * (d / 2)));
      const dir = foot.clone().sub(hip).normalize();
      const fwd = new THREE.Vector3(-dir.y, dir.x, 0); // knee points forward/up
      if (fwd.x < 0) fwd.negate();
      const knee = mid.add(fwd.multiplyScalar(hgt));
      set(r.legs[k], hip, knee);
      set(r.legs[k + 2], knee, foot);
    });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const s = this.session.snapshot();
    const route = this.route;

    // --- smooth motion: predict with speed, gently correct toward the true distance
    const d = this.motion.update(dt, s.distance, s.speed);
    this.speed = this.motion.speed;
    const trace = (window as unknown as { __rbTrace?: number[] }).__rbTrace;
    if (trace) trace.push(d, now);

    // --- rider
    const p = this.place(this.rider.group, d, 1.7);
    // pitch from the local road slope over the wheelbase, smoothed
    const slope = Math.atan2(route.at(d + 0.6).y - route.at(d - 0.6).y, 1.2);
    this.pitch += (slope - this.pitch) * (1 - Math.exp(-dt * 8));
    this.rider.bike.rotation.z = this.pitch;
    this.wheelAngle -= (this.speed / 0.34) * dt;
    this.rider.wheels.forEach((w) => (w.rotation.z = this.wheelAngle));
    this.cadence += ((s.cadence || 0) - this.cadence) * (1 - Math.exp(-dt * 4));
    this.crankAngle -= (this.cadence / 60) * Math.PI * 2 * dt;
    this.rider.crank.rotation.z = this.crankAngle;
    // body: lean forward with effort & climbing, slight rock with each pedal stroke
    const ftp = this.session.engine?.ftp ?? 200;
    const effortTarget = Math.min(1.5, (s.power3s || 0) / ftp);
    this.effort += (effortTarget - this.effort) * (1 - Math.exp(-dt * 2));
    const climbing = Math.max(0, Math.min(1, (s.grade - 0.04) / 0.05)) * Math.min(1, this.effort); // true grade
    const rock = Math.sin(this.crankAngle * 2) * 0.03 * (0.4 + this.effort);
    this.rider.torso.rotation.set(rock, 0, -0.08 * this.effort - 0.05 * climbing);
    this.rider.torso.position.set(-0.17 + 0.12 * climbing, 0.98 + 0.08 * climbing, 0);
    this.rider.bike.rotation.x = Math.sin(this.crankAngle) * 0.06 * climbing; // bike rocks when climbing hard
    this.updateLegs();

    // --- camera (Zwift-style rigs; see camera.ts). Sits in the road's frame so
    // climbs look like climbs; smoothed so it glides rather than snaps.
    const rig = CAMERA_RIGS[this.camMode];
    this.rider.group.visible = rig.showRider;
    const tgt = cameraTargets(route, d, 1.7, rig);
    // Follow exactly along the road (d is already smooth, so no lag at speed);
    // only ease the heights so bumps in the terrain don't jolt the view.
    const k = 1 - Math.exp(-dt * (this.camMode === 'first' ? 12 : 5));
    this.camPos.set(tgt.pos.x, this.camPos.y + (tgt.pos.y - this.camPos.y) * k, tgt.pos.z);
    this.camLook.set(tgt.look.x, this.camLook.y + (tgt.look.y - this.camLook.y) * k, tgt.look.z);
    if (Math.abs(this.camPos.y - tgt.pos.y) > 30) this.camPos.y = tgt.pos.y; // after jumps
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (Math.abs(this.camera.fov - rig.fov) > 0.05) {
      this.camera.fov += (rig.fov - this.camera.fov) * Math.min(1, dt * 6);
      this.camera.updateProjectionMatrix();
    }

    this.sky.position.copy(this.camera.position);
    this.sun.position.set(p.x, p.y, p.z).addScaledVector(this.sunDir, 170);
    this.sun.target.position.set(p.x, p.y, p.z);

    // --- arches (positions are relative to the smoothed rider distance)
    const st = s.workout;
    const shift = d - s.distance;
    if (st && s.archDistance != null && st.interval) {
      this.arch.group.visible = true;
      this.place(this.arch.group, s.archDistance + shift);
      const next = st.next;
      const color = next ? (next.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(next, ftp)).color) : '#ffffff';
      this.arch.mat.color.set(color);
      this.arch.mat.emissive.set(color);
      const intensity = st.intensity / 100;
      const nextTxt = next
        ? next.free
          ? `Next: ${formatDuration(next.duration)} free ride`
          : `Next: ${formatDuration(next.duration)} @ ${Math.round(toWatts((next.powerStart + next.powerEnd) / 2, next.unit, ftp) * intensity)} W`
        : 'Workout complete!';
      drawLabel(this.arch, formatDuration(Math.ceil(st.remaining)), nextTxt, color);
      if (s.nextArchDistance != null && next) {
        this.nextArch.group.visible = true;
        this.place(this.nextArch.group, s.nextArchDistance + shift);
        const nn = this.session.engine!.intervals[next.index + 1];
        const c2 = nn ? (nn.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(nn, ftp)).color) : '#ffffff';
        this.nextArch.mat.color.set(c2);
        this.nextArch.mat.emissive.set(c2);
        drawLabel(this.nextArch, formatDuration(Math.ceil(st.remaining + next.duration)), nn ? 'End of next interval' : 'Finish', c2);
      } else this.nextArch.group.visible = false;
    } else {
      this.arch.group.visible = false;
      this.nextArch.group.visible = false;
    }

    const time = (now - this.t0) / 1000;
    fxTime.value = time;
    this.theme.update?.(time);
    if (this.post) this.post.render(dt);
    else this.renderer.render(this.scene, this.camera);
    if (trace) {
      (window as unknown as { __rbInfo?: unknown }).__rbInfo = { ...this.renderer.info.render };
      (window as unknown as { __rbScene?: unknown }).__rbScene = this.scene;
      (window as unknown as { __rbSession?: unknown }).__rbSession = this.session;
    }
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    disposeTree(this.scene);
    this.post?.dispose();
    this.envMap?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
