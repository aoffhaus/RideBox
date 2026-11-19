// Patagonia: a weathered steppe road through golden tussock country. In the middle
// of the loop rises a granite massif: pale, sheer towers and horns with dark
// sedimentary caps, snow in the couloirs and hanging glaciers, standing on dark
// rock shoulders. Milky-turquoise glacial lakes lie between the road and the
// mountains, ruffled by the wind. Lenga trees grow flag-shaped, bent hard
// downwind; calafate shrubs and guanacos dot the hills; a further ring of snowy
// ranges and spires closes the horizon under lens-shaped (lenticular) clouds.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clampOff,
  detailTex,
  foldLimits,
  jitterAlong,
  lerp,
  loopInfo,
  merge,
    rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { fxTime, windy } from '../fx';
import { sunDirection } from '../sky';

export const PATAGONIA_SUN = { elevation: 35, azimuth: 205 };

// The prevailing westerly: flag trees grow towards local +x rotated by this yaw.
const WIND_YAW = 0.35;

export function patagoniaRoad() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#5f5d59';
    g.fillRect(0, 0, 256, 512);
    const r = rng(77);
    // aggregate: grey stones with a little warm dust
    for (let i = 0; i < 11000; i++) {
      const v = 60 + r() * 70;
      const warm = r() < 0.3 ? 14 : 0;
      g.fillStyle = `rgb(${v + warm},${v + warm * 0.6},${v - 2})`;
      g.fillRect(r() * 256, r() * 512, 1.4 + r(), 1.4 + r());
    }
    // patched repairs and wheel-polished tracks
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `rgba(40,40,42,${0.12 + r() * 0.12})`;
      g.fillRect(20 + r() * 180, r() * 512, 30 + r() * 60, 20 + r() * 90);
    }
    g.fillStyle = 'rgba(30,30,32,0.14)';
    for (const x of [50, 84, 170, 204]) g.fillRect(x, 0, 20, 512);
    // cracks
    g.strokeStyle = 'rgba(25,24,22,0.55)';
    for (let i = 0; i < 16; i++) {
      g.lineWidth = 0.8 + r();
      g.beginPath();
      let x = r() * 256;
      let y = r() * 512;
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (r() - 0.5) * 30;
        y += r() * 30;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // wind-blown dust / gravel along both margins
    for (const [x0, dir] of [
      [0, 1],
      [256, -1],
    ] as const) {
      const gr = g.createLinearGradient(x0, 0, x0 + dir * 26, 0);
      gr.addColorStop(0, 'rgba(178,156,116,0.85)');
      gr.addColorStop(1, 'rgba(178,156,116,0)');
      g.fillStyle = gr;
      g.fillRect(Math.min(x0, x0 + dir * 26), 0, 26, 512);
    }
    // faded, broken edge lines
    for (const x of [10, 240]) {
      for (let y = 0; y < 512; y += 4) {
        g.fillStyle = `rgba(232,230,218,${r() < 0.25 ? 0.12 : 0.4 + r() * 0.15})`;
        g.fillRect(x, y, 6, 4);
      }
    }
    // faded dashed yellow centre line
    for (let y = 0; y < 200; y += 4) {
      g.fillStyle = `rgba(214,176,70,${r() < 0.2 ? 0.15 : 0.5 + r() * 0.15})`;
      g.fillRect(125, y, 6, 4);
    }
  });
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------
function makeNoise(seed: number) {
  const hash = (ix: number, iz: number) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const vn = (x: number, z: number) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    let fx = x - ix;
    let fz = z - iz;
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz);
    const b = hash(ix + 1, iz);
    const c = hash(ix, iz + 1);
    const d = hash(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
  const fbm = (x: number, z: number, oct = 3) => {
    let s = 0;
    let a = 0.5;
    let f = 1;
    let t = 0;
    for (let o = 0; o < oct; o++) {
      s += a * vn(x * f + o * 17.3, z * f - o * 9.1);
      t += a;
      a *= 0.5;
      f *= 2.03;
    }
    return s / t;
  };
  const ridged = (x: number, z: number, oct = 3) => {
    let s = 0;
    let a = 0.5;
    let f = 1;
    let t = 0;
    for (let o = 0; o < oct; o++) {
      const v = 1 - Math.abs(2 * vn(x * f + o * 31.7, z * f + o * 11.3) - 1);
      s += a * v * v;
      t += a;
      a *= 0.5;
      f *= 2.1;
    }
    return s / t;
  };
  return { vn, fbm, ridged };
}

// ---------------------------------------------------------------------------
// Granite towers
// ---------------------------------------------------------------------------
type SpireKind = 'spire' | 'horn' | 'block';
interface SpireSpec {
  kind: SpireKind;
  H: number; // height (m)
  R: number; // base radius (m)
  cap: number; // fraction of H where the dark cap begins (>1 = none)
  lean: number; // tip offset as a fraction of H (horns hook over)
  squash: number; // cross-section aspect (z / x)
  seed: number;
}

const GRANITE = new THREE.Color('#bdb3a4');
const GRANITE_WARM = new THREE.Color('#cbbb9f');
const CAP = new THREE.Color('#3b302a');
const CAP_MID = new THREE.Color('#7a6a5a');
const SCREE = new THREE.Color('#8e877d');
const SNOW = new THREE.Color('#f1f5fa');
const ICE = new THREE.Color('#cfe2ee');

function spireGeometry(s: SpireSpec, hi: boolean): THREE.BufferGeometry {
  const rs = hi ? 22 : 14;
  const hs = hi ? 44 : 24;
  const r = rng(s.seed);
  const ph = Array.from({ length: 10 }, () => r() * Math.PI * 2);
  const pos: number[] = [];
  const grooveA: number[] = [];
  const ledgeH = [0.18 + r() * 0.1, 0.38 + r() * 0.1, 0.55 + r() * 0.1];
  for (let k = 0; k <= hs; k++) {
    const t = k / hs;
    let prof: number;
    if (s.kind === 'spire') prof = (1 - 0.38 * t) * (t > 0.84 ? Math.sqrt(Math.max(0, 1 - ((t - 0.84) / 0.16) ** 2)) : 1);
    else if (s.kind === 'horn') prof = Math.pow(Math.max(0, 1 - t), 0.7) * (1 + 0.12 * Math.sin(t * 8 + ph[0]));
    else prof = (1 - 0.15 * t) * (t > 0.72 ? Math.pow(Math.max(0, 1 - ((t - 0.72) / 0.28) ** 3), 0.5) : 1);
    const flare = 1 + 0.75 * Math.pow(1 - smooth(0, 0.2, t), 2);
    let ledge = 1;
    if (s.kind !== 'block') for (const lh of ledgeH) ledge -= 0.05 * smooth(lh, lh + 0.012, t) * (1 - smooth(lh + 0.04, lh + 0.06, t));
    const cx = s.lean * s.H * t * t;
    for (let j = 0; j < rs; j++) {
      const th = (j / rs) * Math.PI * 2;
      const sec = 1 + 0.15 * Math.sin(2 * th + ph[1]) + 0.09 * Math.sin(3 * th + ph[2]) + 0.05 * Math.sin(5 * th + ph[3] + t * 2.5);
      const g = Math.pow(Math.max(0, Math.sin(5 * th + ph[4] + t * 1.3)), 10);
      // facets that run vertically (joints and cracks), not in horizontal rings
      const jit = 0.05 * Math.sin(9 * th + ph[5] + t * 2) + 0.03 * Math.sin(15 * th + ph[6] - t * 4) + (r() - 0.5) * 0.025;
      const rad = s.R * prof * flare * ledge * (sec - 0.2 * g + jit);
      pos.push(cx + Math.cos(th) * rad, t * s.H, Math.sin(th) * rad * s.squash);
      grooveA.push(g);
    }
  }
  const top = pos.length / 3;
  pos.push(s.lean * s.H, s.H * (s.kind === 'block' ? 1.0 : 1.01), 0);
  grooveA.push(0);
  const idx: number[] = [];
  for (let k = 0; k < hs; k++) {
    for (let j = 0; j < rs; j++) {
      const a = k * rs + j;
      const b = k * rs + ((j + 1) % rs);
      idx.push(a, a + rs, b, b, a + rs, b + rs);
    }
  }
  for (let j = 0; j < rs; j++) idx.push(hs * rs + j, top, hs * rs + ((j + 1) % rs));
  const ig = new THREE.BufferGeometry();
  ig.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  ig.setAttribute('groove', new THREE.Float32BufferAttribute(grooveA, 1));
  ig.setIndex(idx);
  const geo = ig.toNonIndexed();
  geo.computeVertexNormals();
  const P = geo.getAttribute('position');
  const N = geo.getAttribute('normal');
  const G = geo.getAttribute('groove');
  const col = new Float32Array(P.count * 3);
  const c = new THREE.Color();
  for (let f = 0; f < P.count; f += 3) {
    const y = (P.getY(f) + P.getY(f + 1) + P.getY(f + 2)) / 3;
    const x = (P.getX(f) + P.getX(f + 1) + P.getX(f + 2)) / 3 - s.lean * y * y / s.H;
    const z = (P.getZ(f) + P.getZ(f + 1) + P.getZ(f + 2)) / 3;
    const t = y / s.H;
    const th = Math.atan2(z, x);
    const ny = N.getY(f);
    const g = (G.getX(f) + G.getX(f + 1) + G.getX(f + 2)) / 3;
    const contact = s.cap + 0.04 * Math.sin(2 * th + ph[5]) + 0.02 * Math.sin(5 * th + ph[6]) + 0.03 * Math.cos(th + ph[7]);
    const v = r();
    if (t > contact) c.copy(CAP).multiplyScalar(0.85 + v * 0.35);
    else if (t > contact - 0.025) c.copy(CAP_MID).multiplyScalar(0.9 + v * 0.2);
    else {
      c.copy(GRANITE).lerp(GRANITE_WARM, 0.5 + 0.5 * Math.sin(th * 3 + t * 1.5 + ph[8]));
      // vertical water / lichen streaks
      const streak = Math.pow(Math.max(0, Math.sin(th * 13 + ph[9] + Math.sin(t * 6) * 0.3)), 6);
      c.multiplyScalar(0.9 + v * 0.08 - streak * 0.22);
    }
    if (t < 0.12) c.lerp(SCREE, smooth(0.12, 0.04, t));
    let snow = 0;
    if (ny > 0.58 && t > 0.06) snow = 1;
    else if (g > 0.5 && t > 0.12 && t < 0.93) snow = v < 0.85 ? 1 : 0;
    else if (ny > 0.3 && t > 0.3 && v < 0.3) snow = 0.85;
    if (s.kind === 'block' && t > 0.86 && ny > 0.15) snow = 1;
    if (snow > 0) c.lerp(g > 0.5 && t < 0.5 ? ICE : SNOW, snow);
    for (let k = 0; k < 3; k++) {
      col[(f + k) * 3] = c.r;
      col[(f + k) * 3 + 1] = c.g;
      col[(f + k) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('groove');
  return geo;
}

// ---------------------------------------------------------------------------
// Water and cloud shaders
// ---------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
float pgHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float pgNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(pgHash(i), pgHash(i + vec2(1.0, 0.0)), u.x), mix(pgHash(i + vec2(0.0, 1.0)), pgHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

function lakeMaterial(cloudShadows: number) {
  const sun = sunDirection(PATAGONIA_SUN.elevation, PATAGONIA_SUN.azimuth);
  const u = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uSun: { value: sun },
      uDeep: { value: new THREE.Color('#0f8c94') },
      uMilky: { value: new THREE.Color('#3fd0c6') },
      uSkyLo: { value: new THREE.Color('#8fb8e0') },
      uSkyHi: { value: new THREE.Color('#3f7fd0') },
      uSunCol: { value: new THREE.Color('#fff2dc') },
    },
  ]);
  u.fxTime = fxTime;
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: u,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float fxTime;
      uniform vec3 uSun, uDeep, uMilky, uSkyLo, uSkyHi, uSunCol;
      varying vec3 vWorld;
      ${GLSL_NOISE}
      void main(){
        vec2 p = vWorld.xz;
        float t = fxTime;
        // gusts (cat's paws) racing across the lake with the westerly
        float gust = pgNoise(p / 70.0 + vec2(-t * 0.16, t * 0.05)) * 0.7 + pgNoise(p / 23.0 + vec2(-t * 0.35, t * 0.1)) * 0.3;
        gust = smoothstep(0.3, 0.8, gust);
        float amp = 0.35 + 1.1 * gust;
        vec2 g = vec2(0.0);
        // a few wind-driven wave trains plus noise chop
        vec2 d1 = normalize(vec2(-0.94, 0.34)), d2 = normalize(vec2(-0.7, -0.71)), d3 = normalize(vec2(-0.99, 0.12)), d4 = normalize(vec2(-0.45, 0.89));
        g += d1 * cos(dot(d1, p) * 0.9 + t * 2.6) * 0.09;
        g += d2 * cos(dot(d2, p) * 1.7 + t * 3.4) * 0.06;
        g += d3 * cos(dot(d3, p) * 3.1 + t * 4.9) * 0.05;
        g += d4 * cos(dot(d4, p) * 5.3 + t * 6.1) * 0.035;
        float e = 0.6;
        vec2 q = p * 1.3 + vec2(t * 1.6, -t * 0.5);
        float n0 = pgNoise(q);
        g += vec2(pgNoise(q + vec2(e, 0.0)) - n0, pgNoise(q + vec2(0.0, e)) - n0) * 0.35;
        g *= amp;
        float dist = length(cameraPosition - vWorld);
        g *= 1.0 / (1.0 + dist / 400.0); // calmer-looking far away (avoids shimmer)
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 V = normalize(cameraPosition - vWorld);
        float ndv = max(dot(N, V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);
        vec3 sky = mix(uSkyLo, uSkyHi, smoothstep(0.0, 0.5, R.y));
        // milky glacial flour: bright turquoise body, deeper where we look straight down
        vec3 body = mix(uMilky, uDeep, 0.35 * ndv + 0.25 * gust);
        // cloud shadows (same field as the land)
        vec2 cp = vWorld.xz / 420.0 + vec2(t * 0.011, t * 0.006);
        float cs = pgNoise(cp) * 0.65 + pgNoise(cp * 2.3 + 7.1) * 0.35;
        float shade = smoothstep(0.52, 0.68, cs) * ${cloudShadows.toFixed(3)};
        body *= (0.55 + 0.45 * max(uSun.y, 0.0) * 1.6) * (1.0 - shade * 0.6);
        vec3 col = mix(body, sky, fres * 0.45);
        float sd = max(dot(R, uSun), 0.0);
        float spec = pow(sd, 260.0) * 5.0 + pow(sd, 2400.0) * 30.0;
        float glint = step(0.82, pgNoise(p * 4.0 + vec2(t * 3.0, -t * 2.0)));
        spec += pow(sd, 60.0) * glint * 6.0;
        col += uSunCol * spec * (1.0 - shade);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

function lenticularMaterial(haze: THREE.Color) {
  const sun = sunDirection(PATAGONIA_SUN.elevation, PATAGONIA_SUN.azimuth);
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { fxTime, uSun: { value: sun }, uHaze: { value: haze } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal; varying vec3 vN; varying vec3 vWorld;
      void main(){
        vLocal = position;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime; uniform vec3 uSun; uniform vec3 uHaze;
      varying vec3 vLocal; varying vec3 vN; varying vec3 vWorld;
      ${GLSL_NOISE}
      void main(){
        float rxz = length(vLocal.xz);
        // ragged-but-smooth lens edge, gently shimmering
        float edge = 0.78 + 0.12 * pgNoise(vLocal.xz * 3.0 + fxTime * 0.02);
        float a = 1.0 - smoothstep(edge - 0.12, edge, rxz);
        // fine striations along the flow
        float str = 0.94 + 0.06 * pgNoise(vec2(vLocal.x * 2.0, vLocal.z * 26.0 + fxTime * 0.03));
        vec3 N = normalize(vN);
        float lit = 0.62 + 0.38 * clamp(N.y * 0.8 + 0.2, 0.0, 1.0) + 0.35 * max(dot(N, uSun), 0.0);
        vec3 under = vec3(0.62, 0.68, 0.78);
        vec3 top = vec3(1.25, 1.22, 1.18);
        vec3 col = mix(under, top, clamp(lit - 0.45, 0.0, 1.0)) * str;
        float dist = length(cameraPosition - vWorld);
        col = mix(col, uHaze, smoothstep(2000.0, 14000.0, dist) * 0.6);
        gl_FragColor = vec4(col, a * 0.92);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
interface Lake {
  x: number;
  z: number;
  h: number; // heading of the long axis
  ra: number;
  rb: number;
  level: number; // absolute water level
  depth: number;
}

export function buildPatagonia(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const step = route.step;
  const r = rng(route.seed * 71 + 13);
  const N = makeNoise(route.seed * 13 + 5);
  const G0 = L.minY - 30; // the ground disc level
  const inward = L.inward;
  const out: THREE.Object3D[] = [];
  const hi = opts.high;
  const haze = new THREE.Color('#b4cbe4');

  // --- road radius from the centre, binned by angle (inner and outer envelopes)
  const BINS = 360;
  const rMin = new Float32Array(BINS).fill(1e9);
  const rMax = new Float32Array(BINS).fill(0);
  for (let i = 0; i < n; i++) {
    const dx = route.x[i] - L.cx;
    const dz = route.z[i] - L.cz;
    const b = Math.floor(((Math.atan2(dz, dx) / (Math.PI * 2) + 1) % 1) * BINS) % BINS;
    const d = Math.hypot(dx, dz);
    rMin[b] = Math.min(rMin[b], d);
    rMax[b] = Math.max(rMax[b], d);
  }
  const smoothBins = (a: Float32Array, fn: (x: number, y: number) => number) => {
    const o = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      let v = a[b];
      for (let d = -6; d <= 6; d++) v = fn(v, a[(b + d + BINS) % BINS]);
      o[b] = v;
    }
    return o;
  };
  // fill empty bins, then take the conservative envelope over neighbours
  for (let pass = 0; pass < 3; pass++)
    for (let b = 0; b < BINS; b++) {
      if (rMin[b] > 1e8) rMin[b] = Math.min(rMin[(b + 1) % BINS], rMin[(b - 1 + BINS) % BINS]);
      if (rMax[b] === 0) rMax[b] = Math.max(rMax[(b + 1) % BINS], rMax[(b - 1 + BINS) % BINS]);
    }
  const rIn = smoothBins(rMin, Math.min);
  const rOut = smoothBins(rMax, Math.max);
  const binOf = (th: number) => Math.floor(((th / (Math.PI * 2) + 1) % 1) * BINS) % BINS;
  const roadInner = (th: number) => {
    const f = ((th / (Math.PI * 2) + 1) % 1) * BINS;
    const b = Math.floor(f) % BINS;
    return lerp(rIn[b], rIn[(b + 1) % BINS], f - Math.floor(f));
  };

  const roadOuter = (th: number) => {
    const f = ((th / (Math.PI * 2) + 1) % 1) * BINS;
    const b = Math.floor(f) % BINS;
    return lerp(rOut[b], rOut[(b + 1) % BINS], f - Math.floor(f));
  };

  // --- mountain heights: the central massif inside the loop, and the ranges all round outside it
  const massifH = (x: number, z: number) => {
    const dx = x - L.cx;
    const dz = z - L.cz;
    const rc = Math.hypot(dx, dz);
    const th = Math.atan2(dz, dx);
    const env = smooth(520, 1500, roadInner(th) - rc);
    if (env <= 0) return G0 - 40;
    const wob = 1 + 0.3 * (N.vn(Math.cos(th) * 2 + 5, Math.sin(th) * 2 + 5) - 0.5);
    const core = 1 - smooth(300, 2500, rc * wob);
    const rid = N.ridged(x / 760, z / 760, 4);
    const base = N.fbm(x / 420, z / 420, 3);
    return G0 - 40 + env * (60 + 180 * base + core * (260 + 700 * rid));
  };
  const outerH = (x: number, z: number) => {
    const dx = x - L.cx;
    const dz = z - L.cz;
    const th = Math.atan2(dz, dx);
    const dOut = Math.hypot(dx, dz) - roadOuter(th);
    const env = smooth(600, 1900, dOut);
    if (env <= 0) return G0 - 40;
    const big = 0.35 + 0.65 * N.vn(Math.cos(th) * 2.5 + 20, Math.sin(th) * 2.5 + 20);
    const far = 1 - 0.3 * smooth(3800, 5500, dOut);
    const rid = N.ridged(x / 900, z / 900, 4);
    const base = N.fbm(x / 450, z / 450, 3);
    return G0 - 40 + env * far * (70 + 200 * base + big * (280 + 760 * rid));
  };

  // shared colouring: steppe foothills, lenga forest, dark rock, scree, glaciers and snow
  const MC = {
    rock: new THREE.Color('#4e4642'),
    rockLo: new THREE.Color('#77695b'),
    scree: new THREE.Color('#968c7f'),
    forest: new THREE.Color('#3d5229'),
    steppe: new THREE.Color('#b39760'),
    ice: new THREE.Color('#dae8f2'),
    crev: new THREE.Color('#a3c8dc'),
  };
  const mountainColor = (h: number, slope: number, x: number, z: number, c: THREE.Color) => {
    const nz = N.vn(x / 90, z / 90);
    c.copy(MC.steppe);
    c.lerp(MC.forest, smooth(40, 90, h) * (1 - smooth(260, 340, h)) * smooth(0.3, 0.55, nz) * (1 - smooth(0.6, 1.0, slope)));
    c.lerp(MC.rockLo, smooth(120, 300, h + nz * 80));
    c.lerp(MC.scree, smooth(0.35, 0.6, slope) * (1 - smooth(500, 700, h)) * 0.6);
    c.lerp(MC.rock, smooth(380, 520, h + nz * 120));
    // glaciers and snowfields on the gentler ground up high, crevassed where it steepens
    const snowLine = 440 + 140 * (nz - 0.5);
    const ice = smooth(snowLine - 30, snowLine + 60, h) * (1 - smooth(0.75, 1.15, slope));
    c.lerp(nz > 0.62 && slope > 0.35 ? MC.crev : MC.ice, ice);
    c.lerp(MC.ice, smooth(snowLine + 220, snowLine + 320, h) * (1 - smooth(1.2, 1.7, slope)));
    c.multiplyScalar(0.92 + 0.14 * N.vn(x / 25, z / 25));
  };
  /** A (u, v) grid of world points lifted to H(x, z), flat shaded and coloured by height and slope. */
  const heightMesh = (nu: number, nv: number, at: (u: number, v: number) => [number, number], H: (x: number, z: number) => number) => {
    const cnt = (nu + 1) * (nv + 1);
    const pos = new Float32Array(cnt * 3);
    for (let u = 0; u <= nu; u++)
      for (let v = 0; v <= nv; v++) {
        const [x, z] = at(u, v);
        const o = (u * (nv + 1) + v) * 3;
        pos[o] = x;
        pos[o + 1] = H(x, z);
        pos[o + 2] = z;
      }
    const col = new Float32Array(cnt * 3);
    const c = new THREE.Color();
    const id = (u: number, v: number) => Math.min(nu, Math.max(0, u)) * (nv + 1) + Math.min(nv, Math.max(0, v));
    const grad = (a: number, b: number) => {
      const d = Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 2] - pos[b * 3 + 2]) || 1;
      return (pos[a * 3 + 1] - pos[b * 3 + 1]) / d;
    };
    for (let u = 0; u <= nu; u++)
      for (let v = 0; v <= nv; v++) {
        const k = id(u, v);
        const slope = Math.hypot(grad(id(u + 1, v), id(u - 1, v)), grad(id(u, v + 1), id(u, v - 1)));
        mountainColor(pos[k * 3 + 1] - G0, slope, pos[k * 3], pos[k * 3 + 2], c);
        col.set([c.r, c.g, c.b], k * 3);
      }
    const idx: number[] = [];
    for (let u = 0; u < nu; u++)
      for (let v = 0; v < nv; v++) {
        const a = u * (nv + 1) + v;
        const b = a + nv + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  };
  {
    // a disc reaching to just inside the road all round (polar, so no straight cut edges show)
    const ca = hi ? 420 : 260;
    const cr = hi ? 110 : 70;
    out.push(
      heightMesh(
        ca,
        cr,
        (u, v) => {
          const th = (u / ca) * Math.PI * 2;
          const rad = (roadInner(th) - 480) * Math.pow(v / cr, 0.85);
          return [L.cx + Math.cos(th) * rad, L.cz + Math.sin(th) * rad];
        },
        massifH,
      ),
    );
    const na = hi ? 640 : 360;
    const nv = hi ? 40 : 26;
    out.push(
      heightMesh(
        na,
        nv,
        (u, v) => {
          const th = (u / na) * Math.PI * 2;
          const rad = roadOuter(th) + 560 + Math.pow(v / nv, 1.4) * 5200;
          return [L.cx + Math.cos(th) * rad, L.cz + Math.sin(th) * rad];
        },
        outerH,
      ),
    );
  }

  // --- the towers and horns: sculpted granite spires standing on the massifs' fronts
  {
    const specs: { s: SpireSpec; x: number; z: number; rot: number; H: (x: number, z: number) => number }[] = [];
    let seed = route.seed * 1000;
    /** back > 0: that far in from the inner edge of the road; back < 0: that far out beyond the outer edge. */
    const place = (ang: number, back: number, s: Omit<SpireSpec, 'seed'>) => {
      const rad = back > 0 ? Math.max(200, roadInner(ang) - back) : roadOuter(ang) - back;
      specs.push({ s: { ...s, seed: seed++ }, x: L.cx + Math.cos(ang) * rad, z: L.cz + Math.sin(ang) * rad, rot: r() * Math.PI * 2, H: back > 0 ? massifH : outerH });
    };
    const spread = (back: number) => 1 / (1 + Math.abs(back) / 4000);
    const towers = (ang: number, back: number, sgn: number) => {
      for (let k = 0; k < 3; k++) place(ang + (k - 1) * 0.05 * spread(back), back + sgn * r() * 150, { kind: 'spire', H: 820 + r() * 260, R: 105 + r() * 30, cap: 1.5, lean: (r() - 0.5) * 0.05, squash: 0.75 + r() * 0.3 });
    };
    const horns = (ang: number, back: number, sgn: number) => {
      for (let k = 0; k < 4; k++) place(ang + (k - 1.5) * 0.09 * spread(back), back + sgn * r() * 300, { kind: 'horn', H: 650 + r() * 280, R: 200 + r() * 70, cap: 0.56 + r() * 0.12, lean: 0.06 + r() * 0.1, squash: 0.7 + r() * 0.3 });
    };
    const block = (ang: number, back: number) => place(ang, back, { kind: 'block', H: 800 + r() * 150, R: 500 + r() * 80, cap: 0.64 + r() * 0.06, lean: 0, squash: 0.65 });
    const needles = (ang: number, back: number, sgn: number) => {
      place(ang, back, { kind: 'spire', H: 1050 + r() * 200, R: 170 + r() * 30, cap: r() < 0.5 ? 1.5 : 0.85, lean: 0, squash: 0.8 });
      for (let k = 0; k < 5; k++) {
        const kind: SpireKind = r() < 0.7 ? 'spire' : 'horn';
        place(ang + (r() - 0.5) * 0.12 * spread(back), back + sgn * (r() - 0.3) * 500, {
          kind,
          H: 480 + r() * 380,
          R: kind === 'spire' ? 80 + r() * 40 : 150 + r() * 60,
          cap: kind === 'horn' ? 0.55 + r() * 0.15 : r() < 0.4 ? 0.82 : 1.5,
          lean: kind === 'horn' ? (r() - 0.3) * 0.15 : 0,
          squash: 0.7 + r() * 0.3,
        });
      }
    };
    // inside the loop: the hero massif
    const a0 = r() * Math.PI * 2;
    towers(a0, 1850, 1);
    horns(a0 + 1.9, 1700, 1);
    block(a0 + 3.6, 2300);
    needles(a0 + 5.0, 1800, 1);
    // outside the loop: more groups all round, so one is usually ahead of the rider
    const groups = [towers, horns, needles, towers, horns, needles];
    const b0 = r() * Math.PI * 2;
    groups.forEach((fn, k) => {
      const ang = b0 + ((k + (r() - 0.5) * 0.4) / groups.length) * Math.PI * 2;
      if (k === 5) block(ang + 0.15, -2600);
      fn(ang, -(2100 + r() * 500), -1);
    });
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    for (const { s, x, z, rot, H } of specs) {
      const m = new THREE.Mesh(spireGeometry(s, hi), mat);
      m.position.set(x, H(x, z) - s.R * 0.25, z);
      m.rotation.y = rot;
      m.name = 'spire';
      out.push(m);
    }
  }

  // --- glacial lakes beside the road at the foot of the mountains (on both sides)
  const lakes: Lake[] = [];
  {
    const want = 5;
    for (let k = 0; k < want; k++) {
      const side = k % 2 === 0 ? inward : -inward;
      const lim = foldLimits(route)[side > 0 ? 1 : 0];
      let best = -1;
      let bestScore = -Infinity;
      for (let t = 0; t < 40; t++) {
        const i = Math.floor(((k + 0.1 + r() * 0.8) / want) * n);
        const score = Math.min(lim[i], 2500) - route.y[i] * 2;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      const i = best;
      const big = k === 0;
      const ra = big ? 1100 + r() * 300 : 520 + r() * 300;
      const rb = big ? 250 + r() * 30 : 160 + r() * 80;
      const offC = side * (rb + 16 + r() * 22);
      const p = worldAt(route, i, offC, 0);
      let lowest = Infinity;
      const span = Math.round((ra * 1.2) / step);
      for (let d = -span; d <= span; d++) lowest = Math.min(lowest, route.y[(i + d + n) % n]);
      lakes.push({ x: p.x, z: p.z, h: route.heading[i], ra, rb, level: lowest - 3.2, depth: 9 });
    }
  }
  const lakeF = (lk: Lake, x: number, z: number) => {
    const dx = x - lk.x;
    const dz = z - lk.z;
    const u = dx * Math.cos(lk.h) + dz * Math.sin(lk.h);
    const v = -dx * Math.sin(lk.h) + dz * Math.cos(lk.h);
    const f = Math.hypot(u / lk.ra, v / lk.rb);
    return f * (1 + 0.16 * (N.vn(x / 110, z / 110) - 0.5));
  };

  // --- steppe terrain
  // ~700 m of rolling steppe each side, then a moraine and a skirt diving under the mountains' foot
  const mags = [EDGE, EDGE + 0.6, 7, 10, 14, 19, 25, 33, 43, 56, 72, 92, 118, 150, 185, 225, 270, 320, 380, 450, 530, 620, 700, 780];
  const offs = [...mags.map((m) => -m).reverse(), ...mags];
  const roadCol = mags.length - 1;
  // On tight bends the inside of the ribbon would fold over; squeeze all columns
  // proportionally there (instead of letting buildTerrainMesh clamp them into spikes).
  const limits = foldLimits(route);
  const squeeze = (i: number, side: number) => Math.min(1, (limits[side > 0 ? 1 : 0][i] - EDGE) / (790 - EDGE));
  const sqOff = (i: number, off: number) => {
    const a = Math.abs(off);
    if (a <= EDGE + 0.7) return off;
    return Math.sign(off) * (EDGE + (a - EDGE) * squeeze(i, Math.sign(off)));
  };
  const p0 = new THREE.Vector3();
  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    worldAt(route, i, off, 0, p0);
    const x = p0.x;
    const z = p0.z;
    const near = -0.1 + smooth(EDGE + 0.6, 8, a) * 0.35;
    const amp = 3 + 24 * smooth(10, 220, a) + 22 * smooth(220, 650, a);
    const hills = (N.fbm(x / 520, z / 520, 3) - 0.42) * 1.2 + (N.vn(x / 120, z / 120) - 0.5) * 0.25;
    let dy = near + hills * amp * smooth(5, 45, a) + a * 0.012;
    const an = EDGE + (a - EDGE) / Math.max(0.05, squeeze(i, Math.sign(off) || 1)); // nominal (unsqueezed) offset
    dy += 15 * smooth(480, 690, an) - 45 * smooth(700, 780, an); // moraine, then a skirt
    const roadY = route.y[i];
    const floorNear = roadY + near - Math.max(0, a - EDGE - 3) * 0.55;
    for (const lk of lakes) {
      const f = lakeF(lk, x, z);
      if (f > 3) continue;
      const B = lk.level - lk.depth + (lk.depth + 9) * f * f;
      const abs = roadY + dy;
      const carved = Math.min(abs, Math.max(B, floorNear));
      dy = lerp(carved, abs, smooth(2.2, 3, f)) - roadY;
    }
    return dy;
  };
  const hCache = new Map<number, number>();
  const heightC = (i: number, off: number) => {
    const key = i * 4096 + Math.round(off * 4);
    let v = hCache.get(key);
    if (v === undefined) hCache.set(key, (v = height(i, off)));
    return v;
  };
  const gold = new THREE.Color('#c3a265');
  const pale = new THREE.Color('#d8c48d');
  const olive = new THREE.Color('#8d8a55');
  const ochre = new THREE.Color('#a17f48');
  const verge = new THREE.Color('#a69d8b');
  const beach = new THREE.Color('#c2bcad');
  const under = new THREE.Color('#5fb2aa');
  const model: TerrainModel = {
    cols: offs.length,
    roadCol,
    colOff: (i, c) => sqOff(i, offs[c]),
    height: heightC,
    // tufted grass: little shadowed clumps of pale blades
    map: detailTex(9, (g, rr) => {
      for (let k = 0; k < 1400; k++) {
        const v = 150 + rr() * 105;
        g.strokeStyle = `rgba(${v},${v * 0.95},${v * 0.8},0.45)`;
        g.lineWidth = 1;
        const x = rr() * 256;
        const y = rr() * 256;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + 2 + rr() * 2, y - 3 - rr() * 4);
        g.stroke();
      }
      for (let k = 0; k < 170; k++) {
        const x = rr() * 256;
        const y = rr() * 256;
        const s = 3 + rr() * 5;
        for (let b = 0; b < 9; b++) {
          const ang = -Math.PI / 2 + (rr() - 0.5) * 2.2;
          const len = s * (0.8 + rr() * 0.8);
          const v = 215 + rr() * 40;
          g.strokeStyle = `rgba(${v},${v * 0.94},${v * 0.75},0.7)`;
          g.lineWidth = 1 + rr() * 0.6;
          g.beginPath();
          g.moveTo(x + (rr() - 0.5) * s * 0.6, y);
          g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          g.stroke();
        }
      }
    }),
    color(i, off, dy, o) {
      const a = Math.abs(off);
      worldAt(route, i, off, 0, p0);
      const x = p0.x;
      const z = p0.z;
      o.copy(gold).lerp(pale, N.vn(x / 60, z / 60) * 0.7);
      o.lerp(olive, smooth(0.55, 0.8, N.fbm(x / 220, z / 220, 2)) * 0.7);
      o.lerp(ochre, smooth(0.6, 0.85, N.vn(x / 35 + 3, z / 35)) * 0.5);
      o.multiplyScalar(0.92 + 0.12 * N.vn(x / 9, z / 9));
      const abs = route.y[i] + dy;
      for (const lk of lakes) {
        if (abs < lk.level + 2.2 && lakeF(lk, x, z) < 1.2) {
          o.lerp(beach, smooth(lk.level + 2.2, lk.level + 0.6, abs));
          if (abs < lk.level - 0.5) o.copy(under);
        }
      }
      if (a < EDGE + 0.7) o.copy(verge);
      else if (a < 9) o.lerp(verge, smooth(9, EDGE + 0.7, a) * 0.6);
    },
  };
  out.push(buildTerrainMesh(route, model));

  // --- lake surfaces and icebergs
  {
    const mat = lakeMaterial(0.55);
    for (const lk of lakes) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2), mat);
      m.scale.set(lk.ra, 1, lk.rb);
      m.rotation.y = -lk.h;
      m.position.set(lk.x, lk.level, lk.z);
      m.name = 'lake';
      out.push(m);
    }
    // icebergs drifting on the second lake
    const lk = lakes[1];
    const bergs: Inst[] = [];
    const q = new THREE.Quaternion();
    for (let k = 0; k < (hi ? 26 : 12); k++) {
      const u = (r() * 2 - 1) * 0.6;
      const v = (r() * 2 - 1) * 0.45;
      const x = lk.x + Math.cos(lk.h) * u * lk.ra - Math.sin(lk.h) * v * lk.rb;
      const z = lk.z + Math.sin(lk.h) * u * lk.ra + Math.cos(lk.h) * v * lk.rb;
      if (lakeF(lk, x, z) > 0.6) continue;
      const s = 1.2 + Math.pow(r(), 2.5) * 9;
      q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, r() * 6, (r() - 0.5) * 0.4));
      bergs.push({ i: 0, m: new THREE.Matrix4().compose(new THREE.Vector3(x, lk.level - s * 0.25, z), q, new THREE.Vector3(s * (1 + r()), s * (0.5 + r() * 0.5), s)), c: new THREE.Color().setHSL(0.52, 0.45, 0.82 + r() * 0.1) });
    }
    if (bergs.length) out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), bergs, { shadow: false }));
  }

  // --- vegetation, boulders and guanacos
  const density = hi ? 1 : 0.45;
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const inLake = (x: number, z: number, pad: number) => lakes.some((lk) => lakeF(lk, x, z) < 0.72 + pad);
  const spot = (i: number, off0: number, sink = 0.15) => {
    const off = clampOff(route, i, off0);
    return worldAt(route, i, off, height(i, off) - sink);
  };
  const tussocks: Inst[] = [];
  const shrubs: Inst[] = [];
  const trees: Inst[] = [];
  const snags: Inst[] = [];
  const boulders: Inst[] = [];
  const guanacos: Inst[] = [];
  const windQ = (jit: number) => q.setFromAxisAngle(up, WIND_YAW + (r() - 0.5) * jit).clone();
  const count = (x: number) => Math.floor(x) + (r() < x % 1 ? 1 : 0);
  for (let i = 0; i < n; i += 2) {
    for (const side of [-1, 1]) {
      // tussock grass: dense near the road, sparser and bigger further out
      const bands: [number, number, number, number][] = [
        [EDGE + 1.2, 16, 4.6, 1.0],
        [16, 70, 3.4, 1.25],
        [70, 260, 1.8, 1.6],
      ];
      for (const [a0, a1, cnt, sc] of bands) {
        let k = count(cnt * density);
        while (k-- > 0) {
          const a = a0 + r() * (a1 - a0);
          const p = spot(i, side * a, 0.12);
          if (inLake(p.x, p.z, 0.05)) continue;
          jitterAlong(p, route, i, 9, r);
          const s = sc * (0.6 + r() * 0.7);
          tussocks.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.8 + r() * 0.5), s)), c: new THREE.Color().setHSL(0.105 + r() * 0.03, 0.5 + r() * 0.15, 0.68 + r() * 0.1) });
        }
      }
      // calafate and mata negra shrubs
      let k = count(0.9 * density);
      while (k-- > 0) {
        const a = EDGE + 3 + Math.pow(r(), 1.6) * 300;
        const p = spot(i, side * a, 0.2);
        if (inLake(p.x, p.z, 0.08)) continue;
        jitterAlong(p, route, i, 9, r);
        const s = 0.5 + r() * 0.9;
        shrubs.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s * 1.3, s * (0.7 + r() * 0.3), s * 1.3)), c: new THREE.Color().setHSL(0.2 + r() * 0.1, 0.18 + r() * 0.12, 0.3 + r() * 0.1) });
      }
      // granite erratics
      if (r() < 0.12 * density) {
        const a = EDGE + 8 + Math.pow(r(), 1.5) * 400;
        const p = spot(i, side * a, 0.3);
        if (!inLake(p.x, p.z, 0.0)) {
          const s = 0.5 + Math.pow(r(), 2.5) * 4;
          boulders.push({ i, m: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s * 1.3, s * 0.8, s)), c: new THREE.Color().setHSL(0.09, 0.06, 0.55 + r() * 0.15) });
        }
      }
    }
    // groves of flag-shaped lenga in sheltered hollows (and near the lakes)
    if (i % 20 === 0 && r() < 0.6 * (0.5 + density * 0.5)) {
      const side = r() < 0.6 ? inward : -inward;
      const c0 = 18 + Math.pow(r(), 1.4) * 320;
      const cnt = 4 + Math.floor(r() * 12 * density);
      const autumn = r() < 0.35;
      for (let t = 0; t < cnt; t++) {
        const j = (i + Math.floor((r() - 0.5) * 18) + n) % n;
        const a = Math.max(EDGE + 6, c0 + (r() - 0.5) * 60);
        const p = spot(j, side * a, 0.3);
        if (inLake(p.x, p.z, 0.1)) continue;
        const s = 1.0 + r() * 0.9;
        const m = new THREE.Matrix4().compose(p, windQ(0.35), new THREE.Vector3(s, s * (0.8 + r() * 0.4), s));
        if (r() < 0.1) {
          snags.push({ i: j, m, c: new THREE.Color('#b8b2a8') });
          continue;
        }
        const red = autumn && r() < 0.7;
        trees.push({ i: j, m, c: red ? new THREE.Color().setHSL(0.015 + r() * 0.045, 0.6, 0.3 + r() * 0.08) : new THREE.Color().setHSL(0.22 + r() * 0.06, 0.4, 0.24 + r() * 0.08) });
      }
    }
    // a few small guanaco herds on the hillsides
    if (i % 400 === 0 && r() < 0.8) {
      const side = r() < 0.5 ? 1 : -1;
      const c0 = 28 + r() * 90;
      const cnt = 2 + Math.floor(r() * 5);
      for (let t = 0; t < cnt; t++) {
        const j = (i + Math.floor((r() - 0.5) * 10) + n) % n;
        const p = spot(j, side * (c0 + (r() - 0.5) * 20), 0.02);
        if (inLake(p.x, p.z, 0.1)) continue;
        const s = 0.9 + r() * 0.2;
        guanacos.push({ i: j, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s, s)) });
      }
    }
  }

  // geometries
  const colorize = (g: THREE.BufferGeometry, fn: (y: number) => number | THREE.Color) => {
    const P = g.getAttribute('position');
    const c = new Float32Array(P.count * 3);
    for (let k = 0; k < P.count; k++) {
      const v = fn(P.getY(k));
      if (typeof v === 'number') c.fill(v, k * 3, k * 3 + 3);
      else c.set([v.r, v.g, v.b], k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  };
  // tussock: a fountain of blades leaning outwards (and a little downwind)
  const blades: THREE.BufferGeometry[] = [];
  const br = rng(5);
  for (let k = 0; k < 13; k++) {
    const h = 0.5 + br() * 0.55;
    const ang = (k / 13) * Math.PI * 2 + br() * 0.4;
    const tilt = 0.12 + br() * 0.5;
    const b = new THREE.ConeGeometry(0.045, h, 3, 1, true).translate(0, h / 2, 0);
    b.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.sin(ang) * tilt, 0, -Math.cos(ang) * tilt - 0.15)));
    b.translate(Math.cos(ang) * 0.08, 0, Math.sin(ang) * 0.08);
    blades.push(b.toNonIndexed());
  }
  const tussockGeo = colorize(merge(blades), (y) => 0.6 + Math.min(1, y / 0.8) * 0.75);
  out.push(chunkedInstances(route, tussockGeo, windy(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: '#3b2f16' }), 0.9, 0.22), tussocks, { shadow: false }));
  const shrubGeo = merge([
    new THREE.IcosahedronGeometry(0.8, 0).scale(1.2, 0.7, 1).translate(0, 0.4, 0),
    new THREE.IcosahedronGeometry(0.6, 0).scale(1, 0.8, 1.1).translate(0.5, 0.45, 0.3),
    new THREE.IcosahedronGeometry(0.5, 0).translate(-0.45, 0.35, -0.3),
  ]);
  out.push(chunkedInstances(route, shrubGeo, windy(new THREE.MeshLambertMaterial({ flatShading: true }), 1, 0.08), shrubs, { shadow: hi }));
  out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0).translate(0, 0.25, 0), new THREE.MeshLambertMaterial({ flatShading: true }), boulders, { shadow: true, receive: true }));

  // flag trees: a trunk bent hard downwind (+x) and the whole crown streaming off one side
  const bend = (a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.CylinderGeometry(r1, r0, d.length(), 5, 1, true).translate(0, d.length() / 2, 0);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())));
    return g.translate(a.x, a.y, a.z);
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const trunkGeo = merge([
    bend(V(0, -0.3, 0), V(0.5, 1.8, 0), 0.28, 0.22),
    bend(V(0.5, 1.8, 0), V(1.9, 3.3, 0.1), 0.22, 0.14),
    bend(V(1.9, 3.3, 0.1), V(3.9, 3.9, -0.2), 0.14, 0.06),
    bend(V(1.2, 2.7, 0), V(2.6, 4.4, 0.6), 0.1, 0.05),
    bend(V(0.9, 2.3, 0), V(2.4, 2.6, -0.9), 0.09, 0.04),
  ]);
  // a ragged wedge of foliage, thick at the trunk and thinning as it streams downwind
  const lobes: THREE.BufferGeometry[] = [];
  {
    const lr = rng(11);
    for (let k = 0; k < 15; k++) {
      const u = k / 14; // 0 at the trunk, 1 at the downwind tip
      const sz = lerp(0.95, 0.45, u) * (0.8 + lr() * 0.4);
      const x = 0.9 + u * 4.2 + (lr() - 0.5) * 0.5;
      const y = 3.75 - u * 0.6 + (lr() - 0.5) * lerp(1.6, 0.6, u);
      const z = (lr() - 0.5) * lerp(2.2, 1.0, u);
      lobes.push(new THREE.IcosahedronGeometry(sz, hi ? 1 : 0).scale(1.45, 0.7, 1.1).translate(x, y, z));
    }
  }
  let crownGeo = merge(lobes);
  {
    const flat = crownGeo.index ? crownGeo.toNonIndexed() : crownGeo;
    const P = flat.getAttribute('position');
    const cc = new Float32Array(P.count * 3);
    const cr = rng(3);
    for (let f = 0; f < P.count; f += 3) {
      const y = (P.getY(f) + P.getY(f + 1) + P.getY(f + 2)) / 3;
      const v = (0.62 + 0.45 * smooth(2.6, 4.8, y)) * (0.85 + cr() * 0.3);
      cc.fill(v, f * 3, f * 3 + 9);
    }
    flat.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    crownGeo = flat;
  }
  const trunkMat = windy(new THREE.MeshLambertMaterial({ color: '#8e877c' }), 4.5, 0.42);
  out.push(chunkedInstances(route, trunkGeo, trunkMat, trees.map((t) => ({ i: t.i, m: t.m }))));
  out.push(chunkedInstances(route, crownGeo, windy(new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true }), 4.5, 0.42), trees));
  if (snags.length) out.push(chunkedInstances(route, trunkGeo, windy(new THREE.MeshLambertMaterial({ color: '#c4beb4' }), 4.5, 0.2), snags));

  // guanaco: low-poly, tan back, pale belly, grey face
  if (guanacos.length) {
    const tan = new THREE.Color('#a86f3e');
    const belly = new THREE.Color('#e9dfcc');
    const face = new THREE.Color('#5f5650');
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color | ((y: number) => THREE.Color), rz = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (rz) g.rotateZ(rz);
      g.translate(x, y, z);
      return colorize(g, typeof c === 'function' ? c : () => c);
    };
    const geo = merge([
      box(1.35, 0.55, 0.45, 0, 1.2, 0, (y) => (y < 1.05 ? belly : tan)),
      box(0.22, 0.85, 0.22, 0.72, 1.7, 0, (y) => (y < 1.6 ? tan : tan), -0.25),
      box(0.4, 0.2, 0.2, 0.92, 2.12, 0, face),
      box(0.05, 0.14, 0.05, 0.82, 2.28, 0.06, face),
      box(0.05, 0.14, 0.05, 0.82, 2.28, -0.06, face),
      box(0.12, 0.15, 0.12, -0.72, 1.3, 0, tan, 0.6),
      box(0.12, 1.0, 0.12, 0.5, 0.5, 0.15, (y) => (y < 0.6 ? belly : tan)),
      box(0.12, 1.0, 0.12, 0.5, 0.5, -0.15, (y) => (y < 0.6 ? belly : tan)),
      box(0.12, 1.0, 0.12, -0.5, 0.5, 0.15, (y) => (y < 0.6 ? belly : tan)),
      box(0.12, 1.0, 0.12, -0.5, 0.5, -0.15, (y) => (y < 0.6 ? belly : tan)),
    ]);
    out.push(chunkedInstances(route, geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), guanacos));
  }

  // --- lenticular clouds: stacked, lens-shaped saucers parked over the peaks
  {
    const mat = lenticularMaterial(haze);
    const lens = new THREE.SphereGeometry(1, 40, 10);
    const stack = (x: number, z: number, y: number, size: number, rot: number) => {
      const layers = 3 + Math.floor(r() * 3);
      for (let k = 0; k < layers; k++) {
        const f = 1 - k * (0.16 + r() * 0.08);
        const m = new THREE.Mesh(lens, mat);
        m.scale.set(size * f * (1.6 + r() * 0.4), size * (0.075 + r() * 0.03), size * f * (0.7 + r() * 0.2));
        m.position.set(x + (r() - 0.5) * size * 0.15, y + k * size * 0.12, z + (r() - 0.5) * size * 0.1);
        m.rotation.y = rot + (r() - 0.5) * 0.1;
        m.renderOrder = 2;
        m.frustumCulled = false;
        m.name = 'lens';
        out.push(m);
      }
    };
    for (let k = 0; k < 3; k++) {
      const a = r() * Math.PI * 2;
      const d = 300 + r() * 1100;
      stack(L.cx + Math.cos(a) * d, L.cz + Math.sin(a) * d, G0 + 2600 + r() * 300, 1200 + r() * 500, -WIND_YAW + (r() - 0.5) * 0.3);
    }
    for (let k = 0; k < 6; k++) {
      const a = ((k + r() * 0.6) / 6) * Math.PI * 2;
      const d = rOut[binOf(a)] + 4300 + r() * 1500;
      stack(L.cx + Math.cos(a) * d, L.cz + Math.sin(a) * d, G0 + 2150 + r() * 400, 1600 + r() * 700, -WIND_YAW + (r() - 0.5) * 0.3);
    }
  }

  // --- fair-weather cumulus, kept well above the summits (the shared clouds would sit among the towers)
  {
    const tex = canvasTex(
      256,
      128,
      (g) => {
        const cr = rng(21);
        for (let k = 0; k < 26; k++) {
          const x = 40 + cr() * 176;
          const y = 50 + cr() * 40 - Math.sin(((x - 40) / 176) * Math.PI) * 22;
          const rad = 14 + cr() * 26;
          const gr = g.createRadialGradient(x, y, 0, x, y, rad);
          gr.addColorStop(0, 'rgba(255,255,255,0.9)');
          gr.addColorStop(0.6, 'rgba(250,252,255,0.55)');
          gr.addColorStop(1, 'rgba(240,244,250,0)');
          g.fillStyle = gr;
          g.fillRect(0, 0, 256, 128);
        }
        // flat bases
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = 'rgba(0,0,0,1)';
        g.fillRect(0, 100, 256, 28);
      },
      false,
    );
    for (let k = 0; k < 34; k++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.8 + r() * 0.2, fog: false, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      const a = r() * Math.PI * 2;
      const d = 1500 + r() * 8000;
      sp.position.set(L.cx + Math.cos(a) * d, G0 + 2350 + r() * 900, L.cz + Math.sin(a) * d);
      const sc = 600 + r() * 900;
      sp.scale.set(sc * 2, sc, 1);
      sp.name = 'cumulus';
      out.push(sp);
    }
  }
  return out;
}
