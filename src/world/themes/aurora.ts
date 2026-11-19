// Arctic aurora night (after the Lofoten islands of northern Norway): a snowy coast
// road along a black fjord at night. Jagged dark peaks rise steeply inland and
// across the water; red wooden fishing cabins (rorbuer) stand on stilts at the
// water's edge with warm glowing windows whose light streaks across the fjord;
// stockfish drying racks, snow poles and faintly glowing reflector posts line the
// road. Overhead, tall rippling curtains of green-to-violet aurora fold slowly
// across a deep starfield with a faint Milky Way and a low moon.
//
// The sky, stars, moon and aurora live in a camera-following frame (they are
// "at infinity"), so the aurora keeps its compass bearing as the rider loops.
// Everything bright (aurora, windows, reflectors, moon) is pushed above 1.0 so the
// bloom pass picks it up. All animation runs off the shared `fxTime` uniform.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  ROAD_HALF,
  beamMatrix,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clamp01,
  clampOff,
  detailTex,
  foldLimits,
  lapWave,
  loopDelta,
  loopInfo,
  merge,
  radialTex,
  rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { fxBuild, fxSurge, fxTime } from '../fx';
import { sunDirection } from '../sky';

// ---------------------------------------------------------------------------
// Palette / settings shared with the registry entry
// ---------------------------------------------------------------------------
export const AURORA = {
  skyTop: '#02040b',
  skyHorizon: '#13243a',
  haze: '#0a1624', // fog: the deep blue of the air over the fjord at night
  moon: { elevation: 17, azimuth: 205 },
};

/** Curtain layout in the camera-following frame: centre azimuth, span (rad), distance, base/top heights, brightness. */
const CURTAINS = [
  { az: 0.25, span: 1.7, R: 4300, base: 420, top: 2700, k: 1.0 },
  { az: 2.05, span: 1.35, R: 3700, base: 470, top: 2400, k: 0.9 },
  { az: -1.55, span: 1.6, R: 4500, base: 430, top: 2900, k: 1.0 },
  { az: 1.15, span: 2.3, R: 1900, base: 1150, top: 2500, k: 0.65 },
  { az: 3.55, span: 1.1, R: 4700, base: 520, top: 2300, k: 0.7 },
];

const C = (h: string) => new THREE.Color(h);
const hot = (h: string, k: number) => new THREE.Color(h).multiplyScalar(k);

/** vec4(cos az, sin az, half-span, strength) per curtain: lets the sky and water glow in the aurora's directions. */
const AUR_DIRS = CURTAINS.map((c) => new THREE.Vector4(Math.cos(c.az), Math.sin(c.az), c.span * 0.5, c.k));

// GLSL: hashes, value noise, and the analytic "aurora glow in direction d" used by sky and water.
const NOISE = /* glsl */ `
float aHash(float n) { return fract(sin(n) * 43758.5453123); }
float aHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float aNoise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(aHash(i), aHash(i + 1.0), f); }
float aNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = aHash(dot(i, vec2(1.0, 57.0)));
  float b = aHash(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)));
  float c = aHash(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)));
  float d = aHash(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float aNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n = dot(i, vec3(1.0, 57.0, 113.0));
  return mix(mix(mix(aHash(n), aHash(n + 1.0), u.x), mix(aHash(n + 57.0), aHash(n + 58.0), u.x), u.y),
             mix(mix(aHash(n + 113.0), aHash(n + 114.0), u.x), mix(aHash(n + 170.0), aHash(n + 171.0), u.x), u.y), u.z);
}
`;

const AUR_GLOW = /* glsl */ `
uniform vec4 uAur[${CURTAINS.length}];
/** Rough aurora brightness seen in direction d (0..~1): bands of light at the curtains' bearings. */
float auroraGlow(vec3 d, float t) {
  float az = atan(d.z, d.x);
  float g = 0.0;
  for (int k = 0; k < ${CURTAINS.length}; k++) {
    float ca = atan(uAur[k].y, uAur[k].x);
    float da = abs(mod(az - ca + 3.14159265, 6.2831853) - 3.14159265);
    g += uAur[k].w * (1.0 - smoothstep(uAur[k].z * 0.55, uAur[k].z * 1.05, da));
  }
  float rays = 0.55 + 0.45 * aNoise(az * 38.0 + t * 0.5);
  return g * rays;
}
`;

// ---------------------------------------------------------------------------
// Road: dark asphalt, snow drifted onto the edges, white edge lines, dashed yellow centre
// ---------------------------------------------------------------------------
export function auroraRoad() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#464a52';
    g.fillRect(0, 0, 256, 512);
    const r = rng(311);
    for (let i = 0; i < 9000; i++) {
      const v = 54 + r() * 50;
      g.fillStyle = `rgb(${v},${v + 1},${v + 5})`;
      g.fillRect(r() * 256, r() * 512, 1.6, 1.6);
    }
    // wheel tracks: darker, polished
    g.fillStyle = 'rgba(8,9,12,0.22)';
    for (const x of [50, 84, 170, 204]) g.fillRect(x, 0, 20, 512);
    // packed snow along both edges, thinning towards the lanes
    for (const side of [0, 1]) {
      const gr = g.createLinearGradient(side ? 256 : 0, 0, side ? 210 : 46, 0);
      gr.addColorStop(0, 'rgba(225,232,240,0.85)');
      gr.addColorStop(0.35, 'rgba(210,220,232,0.35)');
      gr.addColorStop(1, 'rgba(210,220,232,0)');
      g.fillStyle = gr;
      g.fillRect(side ? 210 : 0, 0, 46, 512);
      for (let i = 0; i < 400; i++) {
        const x = side ? 256 - Math.pow(r(), 2) * 40 : Math.pow(r(), 2) * 40;
        g.fillStyle = `rgba(230,236,244,${0.06 + r() * 0.18})`;
        g.beginPath();
        g.ellipse(x, r() * 512, 0.6 + r() * 2, 2 + r() * 8, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = 'rgba(236,236,236,0.9)';
    g.fillRect(14, 0, 6, 512);
    g.fillRect(236, 0, 6, 512);
    g.fillStyle = '#d9a72a';
    g.fillRect(125, 0, 6, 200);
    // salt/frost glitter
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `rgba(200,215,235,${0.15 + r() * 0.25})`;
      g.fillRect(r() * 256, r() * 512, 1, 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Camera-following helpers
// ---------------------------------------------------------------------------
function stickToCamera(m: THREE.Object3D) {
  m.frustumCulled = false;
  m.onBeforeRender = (_r, _s, camera) => {
    m.position.copy(camera.position);
    m.updateMatrixWorld();
  };
}

// ---------------------------------------------------------------------------
// Sky: night gradient, stars, Milky Way, moon, aurora airglow
// ---------------------------------------------------------------------------
function buildSky(moonDir: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      fxTime,
      uAur: { value: AUR_DIRS },
      uMoonDir: { value: moonDir.clone().normalize() },
      uHaze: { value: C(AURORA.haze) },
      uHorizon: { value: C('#142a40') },
      uMid: { value: C('#07101e') },
      uTop: { value: C('#010208') },
      uGreen: { value: C('#2bff9a') },
      uMoon: { value: hot('#e8eeff', 1.3) },
      uMilky: { value: C('#9aa8d0') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform vec3 uMoonDir, uHaze, uHorizon, uMid, uTop, uGreen, uMoon, uMilky;
      varying vec3 vDir;
      ${NOISE}
      ${AUR_GLOW}
      float stars(vec3 d, float scale, float density, float seed) {
        vec3 sp = d * scale;
        vec3 cell = floor(sp);
        float h = aHash3(cell + seed);
        if (h < density) return 0.0;
        vec3 at = vec3(aHash3(cell + 1.3 + seed), aHash3(cell + 2.7 + seed), aHash3(cell + 4.1 + seed)) * 0.6 + 0.2;
        float r = length(fract(sp) - at);
        float fw = length(fwidth(sp));
        float w = max(0.07, fw * 0.75);
        float tw = 0.65 + 0.35 * sin(fxTime * (1.2 + h * 25.0) + h * 300.0);
        float mag = pow(fract(h * 97.31), 3.0);
        return smoothstep(w, 0.0, r) * tw * (0.25 + 2.8 * mag) * min(1.0, w > 0.07 ? 0.07 / w * 1.4 : 1.0);
      }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        float t = fxTime;
        vec3 col = mix(uHaze, uHorizon, smoothstep(-0.03, 0.01, y));
        col = mix(col, uMid, smoothstep(0.02, 0.3, y));
        col = mix(col, uTop, smoothstep(0.25, 0.9, y));

        // aurora airglow: a green wash low in the sky beneath the curtains
        float ag = auroraGlow(d, t);
        col += uGreen * ag * (0.045 * exp(-max(y, 0.0) * 5.0) + 0.012) * smoothstep(-0.04, 0.03, y);

        float above = smoothstep(0.0, 0.12, y);
        // Milky Way: a faint, mottled band across the sky with a dark dust lane
        vec3 N = normalize(vec3(0.42, 0.62, -0.66));
        float b = dot(d, N);
        float band = exp(-b * b / 0.022);
        float mott = aNoise3(d * 9.0) * 0.6 + aNoise3(d * 23.0) * 0.4;
        float lane = 1.0 - 0.75 * exp(-pow(b - 0.025, 2.0) / 0.0016) * smoothstep(0.3, 0.7, aNoise3(d * 6.0 + 3.0));
        float milky = band * (0.35 + 0.9 * mott * mott) * lane;
        col += uMilky * milky * 0.055 * above;

        // stars: a dense faint field plus scattered bright ones, extra rich in the Milky Way
        float s = stars(d, 340.0, 0.9 - 0.1 * band, 0.0) * 0.55 + stars(d, 150.0, 0.965, 7.0) * 1.1;
        float hue = aHash3(floor(d * 150.0) + 9.0);
        vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.88, 0.75), hue);
        col += sc * s * above;

        // moon: a bright disc with faint maria, a soft halo and a wide glow
        float md = dot(d, uMoonDir);
        float ang = acos(clamp(md, -1.0, 1.0));
        float rad = 0.022;
        float fw = fwidth(ang);
        float disc = 1.0 - smoothstep(rad - fw, rad + fw, ang);
        vec3 mr = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
        vec3 mu = cross(mr, uMoonDir);
        vec2 mp = vec2(dot(d, mr), dot(d, mu)) / rad;
        float maria = smoothstep(0.45, 0.75, aNoise2(mp * 2.2 + 4.0)) * 0.35;
        col = mix(col, uMoon * (1.0 - maria), disc);
        col += vec3(0.5, 0.6, 0.85) * (exp(-max(ang - rad, 0.0) * 90.0) * 0.12 + exp(-ang * 8.0) * 0.03) * (1.0 - disc);

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(6500, 48, 24), mat);
  m.renderOrder = -9; // after the engine's own gradient dome (-10)
  stickToCamera(m);
  return m;
}

// ---------------------------------------------------------------------------
// Aurora curtains: tall rippling ribbons, additive, drawn just after the sky
// ---------------------------------------------------------------------------
function buildCurtain(c: (typeof CURTAINS)[number], seed: number, r: () => number): THREE.Mesh {
  const segs = 160;
  const rows = 4;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const ph1 = r() * 6.28;
  const ph2 = r() * 6.28;
  // the curtain's footprint: an arc at distance R with a lazy S-shaped meander
  const foot = (f: number) => {
    const th = c.az + (f - 0.5) * c.span;
    const rr = c.R * (1 + 0.14 * Math.sin(f * 5.1 + ph1) + 0.06 * Math.sin(f * 13.0 + ph2));
    return new THREE.Vector2(Math.cos(th) * rr, Math.sin(th) * rr);
  };
  let along = 0;
  let prev = foot(0);
  for (let j = 0; j <= segs; j++) {
    const f = j / segs;
    const p = foot(f);
    along += p.distanceTo(prev);
    prev = p;
    const q = foot(Math.min(1, f + 0.002));
    const q0 = foot(Math.max(0, f - 0.002));
    const tx = q.x - q0.x;
    const tz = q.y - q0.y;
    const tl = Math.hypot(tx, tz) || 1;
    // the base sags and lifts a little along the curtain
    const base = c.base * (1 + 0.25 * Math.sin(f * 7.0 + ph2));
    for (let k = 0; k <= rows; k++) {
      const v = k / rows;
      pos.push(p.x, base + (c.top - c.base) * v, p.y);
      nor.push(-tz / tl, 0, tx / tl);
      uv.push(along, v);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let k = 0; k < rows; k++) {
      const a = j * (rows + 1) + k;
      const b = a + rows + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    transparent: false, // stays in the opaque list so it draws before (behind) the mountains
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      fxTime,
      fxBuild,
      fxSurge,
      uLen: { value: along },
      uSeed: { value: seed },
      uK: { value: c.k },
      uGreen: { value: hot('#29ff8c', 2.1) },
      uTeal: { value: hot('#3dffd0', 1.4) },
      uViolet: { value: hot('#8a3dff', 1.25) },
      uMagenta: { value: hot('#ff3fb4', 1.1) },
    },
    vertexShader: /* glsl */ `
      uniform float fxTime, uSeed;
      varying vec2 vUv;
      varying float vEdgeOn;
      void main() {
        vUv = uv;
        float t = fxTime;
        // slow folding: the curtain sways sideways, more at the top than the bottom
        float s = uv.x;
        float fold = sin(s * 0.0042 + t * 0.11 + uSeed) * 190.0 + sin(s * 0.0115 - t * 0.23 + uSeed * 2.0) * 70.0 + sin(s * 0.031 + t * 0.5) * 18.0;
        fold *= 0.75 + 0.45 * uv.y;
        vec3 p = position + normal * fold;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        // seen edge-on, a curtain looks brighter (longer path through the glow)
        vec3 vd = normalize(wp.xyz - cameraPosition);
        vEdgeOn = 1.0 / max(0.35, abs(dot(vd, normal)));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime, uLen, uSeed, uK;
      uniform float fxBuild, fxSurge;
      uniform vec3 uGreen, uTeal, uViolet, uMagenta;
      varying vec2 vUv;
      varying float vEdgeOn;
      ${NOISE}
      void main() {
        float u = vUv.x;
        float v = vUv.y;
        float t = fxTime;
        float f = u / uLen;
        // rippling lower edge
        float edge = 0.04 + 0.07 * aNoise(u * 0.0035 + t * 0.06 + uSeed) + 0.03 * aNoise(u * 0.018 - t * 0.22 + uSeed);
        float h = v - edge;
        float bottom = smoothstep(-0.025, 0.012, h);
        float hh = max(h, 0.0);
        float prof = bottom * (exp(-hh * 4.2) * 0.9 + 0.22 * exp(-hh * 1.3)) * (1.0 - smoothstep(0.7, 1.0, v));
        // vertical rays drifting along the curtain, slightly slanted
        float x = u + v * 60.0;
        float rays = aNoise(x * 0.045 + t * 0.7 + uSeed * 7.0) * 0.6 + aNoise(x * 0.13 - t * 1.1) * 0.28 + aNoise(x * 0.4 + t * 1.9) * 0.12;
        // effort turns it into a substorm: sharper, busier rays
        rays = 0.3 + (1.5 + 1.2 * fxBuild) * pow(rays, 2.6 - 0.9 * fxBuild);
        // broad bands along the curtain where it folds over itself and brightens
        float bands = 0.45 + 0.85 * pow(aNoise(u * 0.0065 + t * 0.08 + uSeed * 1.7), 1.5);
        // bright patches wandering slowly, gentle pulsing
        float blotch = 0.2 + 0.9 * smoothstep(0.25, 0.8, aNoise(u * 0.0022 - t * 0.045 + uSeed * 3.0));
        float pulse = 0.85 + 0.15 * sin(t * 0.8 + u * 0.002 + uSeed);
        float ends = smoothstep(0.0, 0.14, f) * smoothstep(1.0, 0.86, f);
        // colour: teal-green lower edge, green body, violet then magenta higher up
        vec3 col = mix(uTeal, uGreen, smoothstep(0.0, 0.05, hh));
        col = mix(col, uViolet, smoothstep(0.14, 0.45, hh));
        col = mix(col, uMagenta, smoothstep(0.4, 0.8, hh) * 0.6);
        // occasional crimson-pink fringe right at the lower edge
        col += uMagenta * (0.5 + 1.6 * fxBuild) * exp(-abs(h) * 60.0) * smoothstep(0.55 - 0.3 * fxBuild, 0.85, aNoise(u * 0.004 + t * 0.1 + uSeed * 5.0));
        float k = prof * rays * bands * blotch * pulse * ends * uK * min(vEdgeOn, 2.4) * 0.5;
        k *= 1.0 + 1.1 * fxBuild + 0.9 * fxSurge; // flares as you push
        gl_FragColor = vec4(col * k, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -8;
  m.userData.noAO = true;
  stickToCamera(m);
  return m;
}

// ---------------------------------------------------------------------------
// Fjord water: near-black, faint ripples, aurora-green sheen and a moon glitter path
// ---------------------------------------------------------------------------
function waterMaterial(moonDir: THREE.Vector3): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    fog: true,
    toneMapped: false,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uMoonDir: { value: moonDir.clone().normalize() },
        uDeep: { value: C('#020509') },
        uSky: { value: C('#0f2236') },
        uGreen: { value: hot('#2bff9a', 0.32) },
        uViolet: { value: hot('#7a3dff', 0.2) },
        uMoon: { value: hot('#dfe8ff', 2.4) },
      },
    ]),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform vec3 uMoonDir, uDeep, uSky, uGreen, uViolet, uMoon;
      varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE}
      ${AUR_GLOW}
      void main() {
        float t = fxTime;
        vec3 V = normalize(vWorld - cameraPosition);
        float dist = length(vWorld - cameraPosition);
        // ripple normal from two drifting octaves of noise, calmer with distance
        vec2 p = vWorld.xz;
        float e = 0.6;
        vec2 p1 = p * vec2(0.035, 0.05) + vec2(t * 0.03, t * 0.02);
        vec2 p2 = p * 0.13 - vec2(t * 0.06, -t * 0.04);
        float n0 = aNoise2(p1) + 0.5 * aNoise2(p2);
        float nx = aNoise2(p1 + vec2(e * 0.035, 0.0)) + 0.5 * aNoise2(p2 + vec2(e * 0.13, 0.0));
        float nz = aNoise2(p1 + vec2(0.0, e * 0.05)) + 0.5 * aNoise2(p2 + vec2(0.0, e * 0.13));
        float amp = 0.3 * (1.0 - smoothstep(80.0, 1500.0, dist)) + 0.06;
        vec3 N = normalize(vec3((n0 - nx) * amp, 1.0, (n0 - nz) * amp));
        vec3 R = reflect(V, N);
        R.y = abs(R.y);
        float cosi = clamp(dot(-V, N), 0.0, 1.0);
        float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);

        // reflected sky: deep blue near the horizon, darker overhead
        vec3 sky = mix(uSky, uSky * 0.25, smoothstep(0.02, 0.4, R.y));
        // reflected aurora: green low, violet higher, streaked by the rays
        float ag = auroraGlow(R, t);
        float az = atan(R.z, R.x);
        ag *= 0.35 + 0.9 * pow(aNoise(az * 90.0 + t * 0.4), 2.0); // rays, smeared vertically by the ripples
        float skyline = 0.045 + 0.06 * aNoise(az * 7.0) + 0.03 * aNoise(az * 23.0);
        float prof = smoothstep(skyline, skyline + 0.06, R.y) * exp(-max(R.y - 0.14, 0.0) * 3.0);
        vec3 aur = (uGreen * prof + uViolet * smoothstep(0.25, 0.6, R.y) * exp(-R.y * 1.5)) * ag;
        vec3 col = uDeep + (sky + aur) * (0.18 + 0.82 * fres);
        // moon glitter path
        float g = pow(max(dot(R, uMoonDir), 0.0), 900.0) * 2.2 + pow(max(dot(R, uMoonDir), 0.0), 120.0) * 0.08;
        col += uMoon * g;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  // merge() clones uniforms: attach the shared ones afterwards
  mat.uniforms.fxTime = fxTime;
  mat.uniforms.uAur = { value: AUR_DIRS };
  return mat;
}

/** Warm window light streaking across the water: quads on the surface that stretch towards the viewer. */
function streakMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uCol: { value: hot('#ffb35a', 1.6) } }]),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING
          mat4 im = instanceMatrix;
        #else
          mat4 im = mat4(1.0);
        #endif
        vec3 c = (modelMatrix * im * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float len = length(im[0].xyz);   // instance x scale = streak length
        float wid = length(im[2].xyz);   // instance z scale = width
        vec2 toCam = cameraPosition.xz - c.xz;
        float dc = length(toCam);
        vec2 d = toCam / max(dc, 0.001);
        vec2 side = vec2(-d.y, d.x);
        len = min(len, dc * 0.8);
        vec2 xz = c.xz + side * position.x * wid + d * position.y * len;
        vec4 mvPosition = viewMatrix * vec4(xz.x, c.y, xz.y, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCol;
      uniform float fxTime;
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE}
      void main() {
        float across = exp(-pow((vUv.x - 0.5) * 4.2, 2.0));
        float along = exp(-vUv.y * 3.2) * smoothstep(0.0, 0.03, vUv.y);
        float broken = 0.35 + 0.65 * smoothstep(0.3, 0.75, aNoise2(vec2(vUv.x * 6.0, vUv.y * 40.0 - fxTime * 0.8)));
        vec3 col = uCol * across * along * broken;
        #ifdef USE_FOG
          col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}

// ---------------------------------------------------------------------------
// Snowfall: light flakes in a box that follows the camera (one draw call)
// ---------------------------------------------------------------------------
function buildSnow(count: number, box: number): THREE.Points {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const r = rng(907);
  for (let k = 0; k < count; k++) {
    pos[k * 3] = r() * box;
    pos[k * 3 + 1] = r() * box * 0.6;
    pos[k * 3 + 2] = r() * box;
    seed[k] = r();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      fxTime,
      box: { value: box },
      color: { value: hot('#dbe6ff', 0.9) },
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float fxTime; uniform float box; uniform float pixelRatio;
      attribute float seed;
      varying float vFade;
      void main() {
        float fall = fxTime * (0.7 + seed * 0.6);
        vec3 drift = vec3(sin(fxTime * 0.5 + seed * 40.0) * 0.9 + fxTime * 0.35, -fall, cos(fxTime * 0.43 + seed * 23.0) * 0.9);
        vec3 size3 = vec3(box, box * 0.6, box);
        vec3 half_ = size3 * 0.5;
        vec3 p = mod(position + drift - cameraPosition + half_, size3) - half_ + cameraPosition;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        vec3 q = abs(p - cameraPosition) / half_;
        vFade = (1.0 - smoothstep(0.65, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(1.5, 4.0, dist);
        vFade *= 0.7 + 0.3 * sin(fxTime * (2.0 + seed * 3.0) + seed * 50.0); // flakes tumbling, catching the light
        gl_PointSize = max(1.6, (0.7 + seed * 0.9) * pixelRatio * (26.0 / max(dist, 0.5)));
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.1, d);
        gl_FragColor = vec4(color * a * vFade, 1.0);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return pts;
}

// ---------------------------------------------------------------------------
// Distant peaks across the fjord: a ring of jagged, snow-streaked mountains
// ---------------------------------------------------------------------------
function buildFarPeaks(route: Route, cx: number, cz: number, sea: number, r: () => number): THREE.Mesh {
  let R = 0;
  for (let i = 0; i < route.x.length; i++) R = Math.max(R, Math.hypot(route.x[i] - cx, route.z[i] - cz));
  const R0 = R + 1500;
  const depth = 1400;
  const segs = 420;
  const rows = 9;
  const waves: { k: number; a: number; ph: number }[] = [];
  for (const [k, a] of [
    [4, 0.45],
    [9, 0.35],
    [17, 0.3],
    [31, 0.22],
    [57, 0.16],
    [97, 0.1],
  ] as const)
    waves.push({ k, a, ph: r() * 6.283 });
  const ridge = (t: number) => {
    let v = 0;
    for (const w of waves) v += w.a * (1 - 2 * Math.abs(Math.sin(w.k * t * 0.5 + w.ph))); // sharp crests
    return Math.max(0.05, 0.5 + v * 0.55);
  };
  const pos: number[] = [];
  const col: number[] = [];
  const snow = C('#c9d6e6');
  const rock = C('#1a1e26');
  const rockL = C('#2c323d');
  const tmp = new THREE.Color();
  const H: number[][] = [];
  for (let j = 0; j <= segs; j++) {
    const t = (j / segs) * Math.PI * 2;
    const peak = 160 + 640 * Math.pow(ridge(t), 1.7);
    const rowH: number[] = [];
    for (let k = 0; k <= rows; k++) {
      const f = k / rows;
      const prof = Math.pow(Math.sin(Math.min(1, f / 0.55) * Math.PI * 0.5), 0.8) * (f > 0.55 ? 1 - (f - 0.55) * 0.9 : 1);
      const jit = j % segs === 0 ? 0 : (r() - 0.5) * 0.35;
      const hh = k === 0 ? -20 : peak * prof * (0.8 + jit);
      const rr = R0 + f * depth + (k === 0 || j % segs === 0 ? 0 : (r() - 0.5) * 140);
      pos.push(cx + Math.cos(t) * rr, sea + hh, cz + Math.sin(t) * rr);
      rowH.push(hh);
    }
    H.push(rowH);
  }
  for (let j = 0; j <= segs; j++) {
    for (let k = 0; k <= rows; k++) {
      const hh = H[j][k];
      const nb = H[Math.min(segs, j + 1)][k] - H[Math.max(0, j - 1)][k];
      const steep = Math.abs(nb) / 60 + (k > 0 ? Math.abs(hh - H[j][k - 1]) / 260 : 0);
      const snowLine = 140 + 120 * Math.sin(j * 0.37) * Math.sin(j * 0.11);
      tmp.copy(rock).lerp(rockL, r() * 0.6);
      const s = smooth(snowLine, snowLine + 120, hh) * (1 - smooth(0.9, 1.6, steep) * 0.75);
      tmp.lerp(snow, s * (0.7 + r() * 0.3));
      if (hh < 8) tmp.copy(rock);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let k = 0; k < rows; k++) {
      const a = j * (rows + 1) + k;
      const b = a + rows + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  m.userData.noAO = true;
  return m;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
export function buildAurora(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const step = route.step;
  const sea = L.minY - 2.5; // the road dips almost to the water in places
  const land = L.inward; // mountains inside the loop, the fjord outside
  const seaSign = -land;
  const r = rng(route.seed * 97 + 29);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);
  const above = (i: number) => route.y[i] - sea;
  const out: THREE.Object3D[] = [];

  const moonDir = sunDirection(AURORA.moon.elevation, AURORA.moon.azimuth);
  out.push(buildSky(moonDir));
  CURTAINS.forEach((c, k) => out.push(buildCurtain(c, k * 3.7 + 1.3, r)));

  // --- terrain ---------------------------------------------------------------
  const bank = (a: number) => 0.45 * Math.exp(-Math.pow((a - (EDGE + 2.4)) / 1.0, 2)); // plough ridge
  const jag = (i: number, a: number) => {
    // sharp alpine crests: folded sines give knife-edge ridges and spiky summits
    const s1 = 1 - Math.abs(Math.sin(i * 0.0105 + a * 0.004 + 1.1));
    const s2 = 1 - Math.abs(Math.sin(i * 0.031 - a * 0.009 + 0.4));
    const s3 = 1 - Math.abs(Math.sin(i * 0.083 + a * 0.017));
    return s1 * s1 * 0.55 + s2 * s2 * 0.3 + s3 * 0.15;
  };
  const landH = (i: number, a: number) => {
    if (a < EDGE + 1.2) return -0.12;
    if (a >= squeeze(i, 1080, 1080, land) - 0.01) return sea - route.y[i] - 30; // behind the last ridge
    const w1 = w01(i, 0.8, 0.3);
    const w2 = w01(i, 0.33, 1.9);
    let dy = -0.12 + bank(a) + smooth(EDGE + 3, 34, a) * (1.5 + 7 * w1);
    const S = 170;
    dy += (0.35 + 0.45 * w2) * S * (1 - Math.exp(-Math.max(0, a - 22) / S));
    dy += smooth(60, 480, a) * (80 + 320 * jag(i, a) * (0.6 + 0.6 * w2));
    dy += smooth(25, 90, a) * 14 * jag(i * 1.7 + 50, a * 2.0); // craggy knolls low down
    dy += Math.sin(i * 0.047 + a * 0.05) * 3 * smooth(20, 60, a);
    // drifts and hummocks so the moonlight catches facets instead of smooth planes
    const hum = Math.sin(i * 0.11 + a * 0.13) * Math.sin(i * 0.053 - a * 0.21 + 1.7) + 0.5 * Math.sin(i * 0.23 + a * 0.31 + 0.4);
    dy += hum * (0.8 + 0.06 * Math.min(a, 120)) * smooth(9, 30, a);
    return dy;
  };
  // --- cabin sites: clusters of rorbuer, mostly where the road dips to the water. Where
  // the road runs high, the shoulder widens into a snowy shelf and the cabins sit on it.
  const sites: number[] = [Math.round(320 / step)]; // one just after the start line
  {
    const minGap = Math.round(1300 / step);
    const cand: { i: number; s: number }[] = [];
    for (let i = 0; i < n; i += 6) cand.push({ i, s: above(i) + r() * 8 });
    cand.sort((x, y) => x.s - y.s);
    for (const c of cand) {
      if (sites.length >= 10) break;
      if (sites.every((s) => Math.abs(loopDelta(c.i, s, n)) > minGap)) sites.push(c.i);
    }
  }
  const WATER_SITE = 14; // road at most this high above the water: cabins on stilts at the shore
  const shelves = sites.filter((s) => above(s) > WATER_SITE);
  const shelf = (i: number) => {
    let w = 0;
    for (const s of shelves) w = Math.max(w, 1 - smooth(45, 110, Math.abs(loopDelta(i, s, n)) * step));
    return w;
  };
  const terrace = (i: number) => 1.5 + 9 * w01(i, 1.7, 0.9) + 24 * shelf(i);
  const slopeW = (i: number) => 5 + 0.9 * above(i) + 7 * w01(i, 1.1, 2.6);
  const seaH = (i: number, a: number) => {
    const Hs = above(i);
    if (a < EDGE + 1.2) return -0.12;
    const T = terrace(i);
    const c0 = EDGE + 1.2 + T;
    const shoulderEnd = -0.12 - T * 0.05 - 0.3;
    let dy: number;
    if (a < c0) dy = -0.12 + bank(a) - (a - EDGE - 1.2) * 0.05 - smooth(EDGE + 3, EDGE + 5, a) * 0.3;
    else {
      const W = slopeW(i);
      const t = clamp01((a - c0) / W);
      const bottom = -Hs - 4;
      dy = shoulderEnd + (bottom - shoulderEnd) * (1 - Math.pow(1 - t, 1.6));
      dy += Math.sin(i * 0.19 + a * 0.4) * 0.6 * Math.sin(Math.PI * t); // knobbly rocks on the slope
      if (a > c0 + W) dy = bottom - Math.min(40, (a - c0 - W) * 0.15);
    }
    return dy;
  };
  const height = (i: number, off: number) => (off * land > 0 ? landH(i, Math.abs(off)) : seaH(i, Math.abs(off)));

  const landMags = [EDGE, 5.6, 6.6, 7.6, 9.5, 13, 18, 25, 35, 48, 65, 88, 118, 155, 200, 255, 320, 400, 490, 590, 700, 820, 950, 1080];
  const seaRel = (i: number): number[] => {
    const T = terrace(i);
    const c0 = EDGE + 1.2 + T;
    const W = slopeW(i);
    return [EDGE, EDGE + 1.2, EDGE + 2.4, EDGE + 3.6, Math.max(EDGE + 4.2, c0 - T * 0.3), c0, c0 + W * 0.15, c0 + W * 0.35, c0 + W * 0.55, c0 + W * 0.75, c0 + W, c0 + W + 30, c0 + W + 120, c0 + W + 400];
  };
  const nS = 14;
  const nL = landMags.length;
  const cache = new Map<number, number[]>();
  const seaCols = (i: number) => {
    let v = cache.get(i);
    if (!v) cache.set(i, (v = seaRel(i)));
    return v;
  };
  // On the inside of bends the ribbons would fold over: instead of letting the engine pile
  // the outer columns up at the limit (which leaves sliver spikes on the peaks), squeeze
  // every column beyond the verge proportionally.
  const limits = foldLimits(route);
  const squeeze = (i: number, mag: number, max: number, sign: number) => {
    const lim = limits[sign > 0 ? 1 : 0][i] * 0.97;
    const k = Math.min(1, Math.max(0, lim - EDGE - 2) / (max - EDGE - 2));
    return mag <= EDGE + 2 ? mag : EDGE + 2 + (mag - EDGE - 2) * k;
  };
  const colOff = (i: number, c: number) => {
    let mag: number;
    let sign: number;
    let max: number;
    if (land > 0 ? c >= nS : c < nL) {
      mag = landMags[land > 0 ? c - nS : nL - 1 - c];
      max = landMags[nL - 1];
      sign = land;
    } else {
      const sc = seaCols(i);
      mag = sc[land > 0 ? nS - 1 - c : c - nL];
      max = sc[nS - 1];
      sign = seaSign;
    }
    return sign * squeeze(i, mag, max, sign);
  };

  const snow = C('#e4eef6');
  const snowG = C('#d3efe2'); // aurora-lit
  const snowB = C('#b7c6da'); // shadowed hollows
  const verge = C('#c4ccd6');
  const rock = C('#2a2f38');
  const rockD = C('#171a20');
  const wet = C('#121417');
  const model: TerrainModel = {
    cols: nS + nL,
    roadCol: land > 0 ? nS - 1 : nL - 1,
    colOff,
    height,
    color(i, off, dy, o) {
      const a = Math.abs(off);
      const isLand = off * land > 0;
      const slope = Math.abs(height(i, off + 1.5) - height(i, off - 1.5)) / 3;
      const t = 0.5 + 0.5 * Math.sin(i * 0.021 + off * 0.05) * Math.cos(i * 0.013 - off * 0.017);
      const t2 = 0.5 + 0.5 * Math.sin(i * 0.071 + off * 0.13) * Math.sin(i * 0.033 - off * 0.071 + 2.0);
      o.copy(snow).lerp(snowB, t * 0.3 + smooth(0.55, 0.9, t2) * 0.35);
      o.lerp(snowG, smooth(40, 400, a) * 0.5 + 0.15);
      // rock shows through on steep faces, with snow lodged in gullies and ledges
      const streak = 0.5 + 0.5 * Math.sin(i * 0.29 + dy * 0.08) * Math.sin(i * 0.071 - dy * 0.033 + off * 0.01);
      const rockAmt = smooth(0.75, 1.35, slope + (streak - 0.5) * 0.5);
      o.lerp(rock, rockAmt * 0.95).lerp(rockD, rockAmt * smooth(0.5, 1, streak) * 0.5);
      if (!isLand) {
        const h = dy + above(i);
        if (h < 1.6) o.lerp(wet, smooth(1.6, 0.3, h));
      }
      if (a < EDGE + 1.2) o.copy(verge);
    },
    map: detailTex(71, (g, rr) => {
      for (let i = 0; i < 9000; i++) {
        const v = 196 + rr() * 59;
        g.fillStyle = `rgb(${v},${v},${Math.min(255, v + 6)})`;
        g.fillRect(rr() * 256, rr() * 256, 1 + rr() * 2, 1 + rr() * 2);
      }
    }),
    flatShading: true,
  };
  out.push(buildTerrainMesh(route, model, opts.high ? 2 : 3));

  // --- fjord water and far peaks ----------------------------------------------
  const water = new THREE.Mesh(new THREE.CircleGeometry(12000, 96).rotateX(-Math.PI / 2), waterMaterial(moonDir));
  water.position.set(L.cx, sea, L.cz);
  water.userData.noAO = true;
  Object.assign(water.userData, { mapWater: true, mapColor: '#12304a' }); // minimap
  out.push(water);
  out.push(buildFarPeaks(route, L.cx, L.cz, sea, r));

  // --- shoreline (where the seaward profile meets the water), every 2 samples
  const shore = new Float32Array(Math.ceil(n / 2) + 1);
  for (let k = 0; k < shore.length; k++) {
    const i = (k * 2) % n;
    const Hs = above(i);
    let lo = EDGE + 1.2;
    let hi = 900;
    if (seaH(i, lo) + Hs < 0) {
      shore[k] = lo;
      continue;
    }
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (seaH(i, mid) + Hs > 0) lo = mid;
      else hi = mid;
    }
    shore[k] = lo;
  }
  const shoreAt = (i: number) => shore[Math.round(i / 2) % shore.length];

  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  // --- shore boulders, dusted with snow
  const boulders: Inst[] = [];
  for (let k = 0; k < shore.length; k += 2) {
    const i = (k * 2) % n;
    if (r() < (opts.high ? 0.45 : 0.25)) {
      const a = shore[k] - 3 + r() * 9;
      const p = worldAt(route, i, seaSign * a, 0);
      p.y = sea - 0.4 + r() * 0.5;
      const s = 0.7 + r() * 2.4;
      e.set(r() * 3, r() * 3, r() * 3);
      boulders.push({ i, m: new THREE.Matrix4().compose(p, q.setFromEuler(e), new THREE.Vector3(s, s * 0.65, s)), c: new THREE.Color().setHSL(0.6, 0.08, 0.1 + r() * 0.08) });
    }
  }
  out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), boulders, { shadow: false }));

  // --- rorbuer: red fishing cabins on stilts, in small clusters at low points of the road
  const bodies: Inst[] = [];
  const roofs: Inst[] = [];
  const stilts: Inst[] = [];
  const windows: Inst[] = [];
  const trims: Inst[] = [];
  const streaks: Inst[] = [];
  const racks: Inst[] = [];
  const fish: Inst[] = [];
  const reds = ['#8d1d17', '#9b2619', '#7a1812', '#a3301f', '#8a2216'];
  const lit = hot('#ffb347', 1);
  const dark = new THREE.Color(0.02, 0.02, 0.025);
  const pools: Inst[] = [];
  for (const s0 of sites) {
    const onWater = above(s0) <= WATER_SITE;
    const count = 3 + Math.floor(r() * (onWater ? 4 : 3));
    let along = -((count - 1) * 12) / 2;
    for (let c = 0; c < count; c++) {
      const i = (s0 + Math.round(along / step) + n) % n;
      along += 10 + r() * 5;
      let a: number;
      let y: number;
      if (onWater) {
        a = shoreAt(i) + 0.5 + r() * 2.5;
        y = sea + 2.0 + r() * 0.5;
      } else {
        a = EDGE + 10.5 + r() * 4;
        y = route.y[i] + Math.max(height(i, seaSign * (a - 3.6)), height(i, seaSign * a), height(i, seaSign * (a + 3.6))) + 0.35;
      }
      const p = worldAt(route, i, seaSign * a, 0);
      p.y = y;
      const h = route.heading[i] + (r() - 0.5) * 0.25;
      const xAxis = new THREE.Vector3(-Math.sin(h) * seaSign, 0, Math.cos(h) * seaSign); // towards the water
      const zAxis = new THREE.Vector3().crossVectors(xAxis, up);
      const s = 0.85 + r() * 0.3;
      const m = new THREE.Matrix4().makeBasis(xAxis, up, zAxis).scale(new THREE.Vector3(s, s, s)).setPosition(p);
      const ochre = r() < 0.15;
      bodies.push({ i, m, c: C(ochre ? '#b07a26' : reds[Math.floor(r() * reds.length)]) });
      roofs.push({ i, m });
      stilts.push({ i, m });
      trims.push({ i, m });
      const on = r() < 0.8;
      windows.push({ i, m, c: on ? lit.clone().multiplyScalar(0.8 + r() * 0.5) : dark });
      if (on && !onWater) {
        // warm light spilling onto the snow around the cabin
        for (const [lx, lz] of [
          [5.2, 0],
          [0, 4.2],
          [0, -4.2],
        ] as const) {
          const wp = new THREE.Vector3(lx * s, 0, lz * s).applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, up, zAxis)).add(p);
          wp.y = y - 0.25;
          pools.push({ i, m: new THREE.Matrix4().compose(wp, q.identity(), new THREE.Vector3(7, 1, 7)) });
        }
      }
      if (on && onWater) {
        // light from the windows on the water: one streak from the seaward gable, one each side
        for (const [lx, lz, len] of [
          [4.4, 0, 30],
          [1.0, 3.6, 18],
          [1.0, -3.6, 18],
        ] as const) {
          const wp = new THREE.Vector3(lx * s, 0, lz * s).applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, up, zAxis)).add(p);
          wp.y = sea + 0.06;
          streaks.push({ i, m: new THREE.Matrix4().compose(wp, q.identity(), new THREE.Vector3(len, 1, 1.5 + r() * 0.8)) });
        }
      }
    }
    // a stockfish drying rack on the slope behind the cluster (land side of the road)
    if (r() < 0.8) {
      const len = 14 + r() * 14;
      const i0 = (s0 + Math.round((r() - 0.5) * 30 / step) + n) % n;
      const offR = clampOff(route, i0, land * (EDGE + 10 + r() * 6));
      const posts = Math.max(3, Math.round(len / 3.2));
      let prevTop: THREE.Vector3[] | null = null;
      for (let k = 0; k <= posts; k++) {
        const ii = (i0 + Math.round(((k / posts - 0.5) * len) / step) + n) % n;
        const hgt = height(ii, offR);
        const side = new THREE.Vector3(-Math.sin(route.heading[ii]), 0, Math.cos(route.heading[ii]));
        const fwd = new THREE.Vector3(Math.cos(route.heading[ii]), 0, Math.sin(route.heading[ii]));
        const tops: THREE.Vector3[] = [];
        for (const sd of [-1, 1]) {
          const foot = worldAt(route, ii, offR + sd * 1.1, hgt - 0.3);
          const top = worldAt(route, ii, offR + sd * 0.25, hgt + 3.0);
          racks.push({ i: ii, m: beamMatrix(foot, top, 0.14, 0.14, fwd) });
          tops.push(worldAt(route, ii, offR + sd * 0.35, hgt + 2.55));
        }
        if (prevTop) {
          for (let t = 0; t < 2; t++) {
            racks.push({ i: ii, m: beamMatrix(prevTop[t], tops[t], 0.1, 0.1, side) });
            // hanging stockfish in pairs along the rails
            if (opts.high) {
              for (let f = 0.12; f < 0.92; f += 0.16) {
                const fp = prevTop[t].clone().lerp(tops[t], f + (r() - 0.5) * 0.05);
                fp.y -= 0.45;
                fish.push({ i: ii, m: new THREE.Matrix4().compose(fp, q.setFromAxisAngle(up, -route.heading[ii] + (r() - 0.5) * 0.4), new THREE.Vector3(0.14, 0.8 + r() * 0.25, 0.3)) });
              }
            }
          }
        }
        prevTop = tops;
      }
    }
  }

  // cabin geometry, local frame: +x towards the water (gable end), y up from the floor, z along the shore
  const WL = 7; // length
  const WW = 5; // width
  const WH = 3; // wall height
  const RH = 2.1; // roof rise
  const gable = new THREE.CylinderGeometry(1, 1, WL, 3, 1)
    .rotateZ(Math.PI / 2)
    .rotateX(-Math.PI / 2)
    .scale(1, RH / 1.5, WW / 2 / 0.866)
    .translate(0, WH + (0.5 * RH) / 1.5, 0);
  const bodyGeo = merge([new THREE.BoxGeometry(WL, WH, WW).translate(0, WH / 2, 0), gable, new THREE.BoxGeometry(0.6, 1.4, 0.6).translate(-1.6, WH + RH * 0.75, 1.0)]);
  const pitch = Math.atan2(RH, WW / 2);
  const panelW = Math.hypot(RH, WW / 2) + 0.45;
  const roofGeo = merge(
    [1, -1].map((sd) =>
      new THREE.BoxGeometry(WL + 0.7, 0.22, panelW)
        .rotateX(sd * pitch)
        .translate(0, WH + RH / 2 + 0.16, (sd * WW) / 4 + sd * 0.08),
    ),
  );
  const stiltParts: THREE.BufferGeometry[] = [];
  for (const sx of [-3.1, 0, 3.1])
    for (const sz of [-2.2, 2.2]) stiltParts.push(new THREE.BoxGeometry(0.28, 6.5, 0.28).translate(sx, -3.2, sz));
  stiltParts.push(new THREE.BoxGeometry(WL + 0.4, 0.3, WW + 0.4).translate(0, -0.12, 0)); // floor platform
  const stiltGeo = merge(stiltParts);
  // white corner boards and window frames
  const trimParts: THREE.BufferGeometry[] = [];
  for (const sx of [-WL / 2, WL / 2]) for (const sz of [-WW / 2, WW / 2]) trimParts.push(new THREE.BoxGeometry(0.16, WH, 0.16).translate(sx, WH / 2, sz));
  const winSpots: [number, number, number, number][] = [
    // x, y, z, facing (0 = +x gable, 1 = +z side, -1 = -z side)
    [WL / 2 + 0.02, 1.7, 0, 0],
    [-1.4, 1.6, WW / 2 + 0.02, 1],
    [1.6, 1.6, WW / 2 + 0.02, 1],
    [-1.4, 1.6, -WW / 2 - 0.02, -1],
    [1.6, 1.6, -WW / 2 - 0.02, -1],
    [WL / 2 + 0.02, WH + 0.55, 0, 0], // loft window in the gable
  ];
  const winParts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, f] of winSpots) {
    const loft = y > WH;
    const w = new THREE.PlaneGeometry(loft ? 0.6 : 0.85, loft ? 0.6 : 0.95);
    const frame = new THREE.BoxGeometry(0.05, loft ? 0.78 : 1.13, loft ? 0.78 : 1.03);
    if (f === 0) {
      w.rotateY(Math.PI / 2);
    } else {
      w.rotateY(f > 0 ? 0 : Math.PI);
      frame.rotateY(Math.PI / 2);
    }
    winParts.push(w.translate(x + (f === 0 ? 0.06 : 0), y, z + f * 0.06));
    trimParts.push(frame.translate(x, y, z));
  }
  const trimGeo = merge(trimParts);
  const winGeo = merge(winParts);
  const wood = new THREE.MeshLambertMaterial();
  out.push(chunkedInstances(route, bodyGeo, wood, bodies, { shadow: true, receive: true }));
  out.push(chunkedInstances(route, roofGeo, new THREE.MeshLambertMaterial({ color: '#e6edf4' }), roofs, { shadow: true, receive: true }));
  out.push(chunkedInstances(route, stiltGeo, new THREE.MeshLambertMaterial({ color: '#2a221c' }), stilts, { shadow: false }));
  out.push(chunkedInstances(route, trimGeo, new THREE.MeshLambertMaterial({ color: '#d9d4c8' }), trims, { shadow: false }));
  out.push(chunkedInstances(route, winGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.0, 0.85), toneMapped: false, side: THREE.DoubleSide }), windows, { shadow: false }));
  if (streaks.length) {
    const sg = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const sm = new THREE.InstancedMesh(sg, streakMaterial(), streaks.length);
    streaks.forEach((s, k) => sm.setMatrixAt(k, s.m));
    sm.frustumCulled = false; // the quads are re-aimed in the vertex shader
    sm.renderOrder = 2;
    sm.userData.noAO = true;
    out.push(sm);
  }
  if (pools.length) {
    const pm = new THREE.MeshBasicMaterial({
      map: radialTex('rgba(255,170,80,0.55)', 'rgba(255,170,80,0)'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    out.push(chunkedInstances(route, new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), pm, pools, { shadow: false }));
  }
  if (racks.length) out.push(chunkedInstances(route, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: '#4a3a2c' }), racks, { shadow: true }));
  if (fish.length) out.push(chunkedInstances(route, new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0), new THREE.MeshLambertMaterial({ color: '#7d705c' }), fish, { shadow: false }));

  // --- snow-laden spruce and birch scrub, and dark crags poking through the snow
  const spruce: Inst[] = [];
  const crags: Inst[] = [];
  const density = opts.high ? 1 : 0.5;
  const spot = (i: number, off0: number, sink: number) => {
    const off = clampOff(route, i, off0);
    const p = worldAt(route, i, off, height(i, off) - sink);
    p.x += (r() - 0.5) * 6;
    p.z += (r() - 0.5) * 6;
    return { p, off };
  };
  for (let i = 0; i < n; i += 3) {
    const grove = smooth(0.35, 0.85, w01(i, 1.3, 2.2));
    if (r() < (0.05 + 0.5 * grove) * density) {
      const cnt = 1 + Math.floor(r() * 4);
      const base = EDGE + 7 + Math.pow(r(), 1.5) * 140;
      for (let c = 0; c < cnt; c++) {
        const { p, off } = spot(i, land * (base + c * (2 + r() * 5)), 0.3);
        const sl = Math.abs(height(i, off + 2) - height(i, off - 2)) / 4;
        if (sl > 0.8) continue;
        const sc = 0.5 + r() * 0.8;
        spruce.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(sc, sc * (0.9 + r() * 0.4), sc)) });
      }
    }
    if (r() < 0.6 * density) {
      const a = EDGE + 9 + Math.pow(r(), 1.3) * 300;
      const { p } = spot(i, land * a, 0.6 + r());
      const sc = 1.2 + r() * 4 * (0.5 + a / 300);
      e.set(r() * 0.6, r() * 6, r() * 0.6);
      crags.push({ i, m: new THREE.Matrix4().compose(p, q.setFromEuler(e), new THREE.Vector3(sc, sc * (0.5 + r() * 0.7), sc * (0.7 + r() * 0.5))), c: new THREE.Color().setHSL(0.6, 0.1, 0.08 + r() * 0.07) });
    }
  }
  const tiers = (rad: number[], ys: number[], hs: number[], k: number, dy: number) =>
    merge(rad.map((rr, t) => new THREE.ConeGeometry(rr * k, hs[t] * k, 7, 1).translate(0, ys[t] + dy, 0)));
  const R_ = [2.0, 1.55, 1.1, 0.65];
  const Y_ = [2.2, 3.6, 4.9, 6.1];
  const H_ = [2.8, 2.4, 2.0, 1.6];
  const needles = merge([tiers(R_, Y_, H_, 1, 0), new THREE.CylinderGeometry(0.12, 0.18, 1.6, 5).translate(0, 0.8, 0)]);
  const snowCaps = tiers(R_, Y_, H_, 0.86, 0.32);
  out.push(chunkedInstances(route, needles, new THREE.MeshLambertMaterial({ color: '#0f1a17', flatShading: true }), spruce));
  out.push(chunkedInstances(route, snowCaps, new THREE.MeshLambertMaterial({ color: '#dfe8f0', flatShading: true }), spruce, { shadow: false }));
  out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), crags, { shadow: true, receive: true }));

  // --- road furniture: reflector posts (black with a white band) and tall orange snow poles
  const postsM: Inst[] = [];
  const reflW: Inst[] = [];
  const reflA: Inst[] = [];
  const poles: Inst[] = [];
  const every = Math.max(1, Math.round(25 / step));
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0, k = 0; i < n; i += every, k++) {
    for (const side of [-1, 1]) {
      const p = worldAt(route, i, side * (ROAD_HALF + 1.1), -0.05);
      q.setFromAxisAngle(up, -route.heading[i]);
      postsM.push({ i, m: new THREE.Matrix4().compose(p, q, one) });
      (side < 0 ? reflW : reflA).push({ i, m: new THREE.Matrix4().compose(p, q, one) });
      if (k % 2 === (side > 0 ? 0 : 1)) {
        const pp = worldAt(route, i, side * (ROAD_HALF + 1.9), -0.1);
        poles.push({ i, m: new THREE.Matrix4().compose(pp, q.setFromAxisAngle(up, r() * 6), new THREE.Vector3(1, 0.9 + r() * 0.25, 1)) });
      }
    }
  }
  const postGeo = merge([new THREE.BoxGeometry(0.12, 1.15, 0.12).translate(0, 0.575, 0)]);
  const bandGeo = new THREE.BoxGeometry(0.125, 0.16, 0.125).translate(0, 0.86, 0);
  // reflectors on both faces (along the road): visible to the rider either way round
  const reflGeo = merge([new THREE.PlaneGeometry(0.07, 0.12).rotateY(-Math.PI / 2).translate(-0.065, 0.98, 0), new THREE.PlaneGeometry(0.07, 0.12).rotateY(Math.PI / 2).translate(0.065, 0.98, 0)]);
  out.push(chunkedInstances(route, postGeo, new THREE.MeshLambertMaterial({ color: '#16171a' }), postsM, { shadow: false }));
  out.push(chunkedInstances(route, bandGeo, new THREE.MeshLambertMaterial({ color: '#e8e8e8' }), postsM, { shadow: false }));
  out.push(chunkedInstances(route, reflGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.17, 1.1), toneMapped: false, side: THREE.DoubleSide }), reflW, { shadow: false }));
  out.push(chunkedInstances(route, reflGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 0.7, 0.16), toneMapped: false, side: THREE.DoubleSide }), reflA, { shadow: false }));
  out.push(chunkedInstances(route, new THREE.CylinderGeometry(0.02, 0.025, 2.6, 5).translate(0, 1.3, 0), new THREE.MeshLambertMaterial({ color: '#e0601f' }), poles, { shadow: false }));

  // --- falling snow around the rider
  out.push(buildSnow(opts.high ? 2600 : 900, 50));
  return out;
}
