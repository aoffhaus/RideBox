// Synthwave: a neon night ride across an endless glowing grid. A huge striped
// retro sun sits low on the horizon in a starfield sky that burns from deep
// indigo to hot magenta; a ring of wireframe mountains glows cyan around the
// loop; neon pylons, palm silhouettes and chevrons line a black road with
// glowing cyan edges and a magenta centre dash.
//
// Neon materials are pushed above 1.0 (and not tone mapped) so the engine's
// bloom pass picks them up. `synthwaveUpdate(time)` drives the shared time
// uniform (grid pulse, star twinkle, sun slats); the scene looks right static too.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  ROAD_HALF,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clampOff,
  loopInfo,
  merge,
  mirroredColumns,
  rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
  jitterAlong,
} from './common';
import type { ThemeBuildOptions } from './index';
import type { EffortState } from '../effort';

// ---------------------------------------------------------------------------
// Palette (sRGB hex; THREE.Color converts to linear)
// ---------------------------------------------------------------------------
export const SYNTH = {
  haze: '#3a1060',
  skyTop: '#05011a',
  skyHorizon: '#c2207f',
  cyan: '#19f3ff',
  magenta: '#ff2bd6',
  pink: '#ff3c8e',
  yellow: '#ffd23a',
  ground: '#07020f',
};

/** Shared by every synthwave material: one object, so `update` needs no bookkeeping across rebuilds. */
const uTime = { value: 0 };
/** Phase of the grid's energy ripples: advances faster the harder you ride (no jumps). */
const uWave = { value: 0 };
const uEffort = { value: 0 };
let lastT = 0;

export function synthwaveUpdate(time: number, effort?: EffortState) {
  const dt = Math.min(0.1, Math.max(0, time - lastT));
  lastT = time;
  uTime.value = time;
  const e = effort ? Math.min(1, effort.build + 0.5 * effort.surge) : 0;
  uEffort.value = e;
  uWave.value += dt * 2.4 * (1 + 2.5 * e); // ripples race outward on a big effort
}

const neon = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);

// GLSL helpers shared by the shaders below.
const FOG_FACTOR = /* glsl */ `
float synthFog(float depth) {
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
    #else
      return smoothstep(fogNear, fogFar, depth);
    #endif
  #else
    return 0.0;
  #endif
}`;

/** Anti-aliased line coverage for a coordinate whose integer values are lines. hw = half width in coord units. */
const GRID_LINE = /* glsl */ `
float gridLine(float x, float hw) {
  float fw = fwidth(x);
  float q = abs(fract(x - 0.5) - 0.5);
  float w = max(hw, fw * 0.6); // never thinner than ~1 px...
  float l = (1.0 - smoothstep(w - fw, w + fw, q)) * mix(hw / w, 1.0, 0.35); // ...but dimmer when widened
  // far away a cell shrinks below a pixel: fade to the average coverage (no moire)
  return mix(l, min(1.0, 2.0 * hw + 0.1), smoothstep(0.25, 0.6, fw));
}`;

// ---------------------------------------------------------------------------
// Road
// ---------------------------------------------------------------------------
/** Black asphalt with faint painted lines; the glow comes from the neon overlay ribbon. */
export function synthwaveRoad() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#171225';
    g.fillRect(0, 0, 256, 512);
    const r = rng(77);
    for (let i = 0; i < 9000; i++) {
      const v = 14 + r() * 22;
      g.fillStyle = `rgb(${v + 4},${v},${v + 12})`;
      g.fillRect(r() * 256, r() * 512, 1.6, 1.6);
    }
    g.fillStyle = '#1a6f80';
    g.fillRect(8, 0, 7, 512);
    g.fillRect(241, 0, 7, 512);
    g.fillStyle = '#7a1a6c';
    g.fillRect(125, 0, 6, 200);
  });
}

function glowRibbon(route: Route): THREE.Mesh {
  const n = route.x.length;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx: number[] = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const h = route.heading[i];
    for (let s = 0; s < 2; s++) {
      const off = s === 0 ? -ROAD_HALF : ROAD_HALF;
      const o = (k * 2 + s) * 3;
      pos[o] = route.x[i] - Math.sin(h) * off;
      pos[o + 1] = route.y[i] + 0.05;
      pos[o + 2] = route.z[i] + Math.cos(h) * off;
      uv[(k * 2 + s) * 2] = off;
      uv[(k * 2 + s) * 2 + 1] = k * route.step;
    }
    if (k < n) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uEdge: { value: neon(SYNTH.cyan, 3.2) }, uCentre: { value: neon(SYNTH.magenta, 3.0) } }]),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uEdge;
      uniform vec3 uCentre;
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_fragment>
      ${FOG_FACTOR}
      float band(float x, float c, float hw) {
        float fw = fwidth(x);
        return 1.0 - smoothstep(hw - fw, hw + fw, abs(x - c));
      }
      void main() {
        float x = abs(vUv.x);
        float edge = band(x, 4.1, 0.1);
        float halo = exp(-abs(x - 4.1) * 4.0) * 0.16;
        float dash = step(0.609, fract(vUv.y / 12.0));
        float centre = band(vUv.x, 0.0, 0.07) * dash;
        float chalo = exp(-abs(vUv.x) * 10.0) * 0.05 * dash;
        vec3 col = uEdge * (edge + halo) + uCentre * (centre + chalo);
        col *= 1.0 - synthFog(vFogDepth); // additive: fade to nothing, not to the fog colour
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------
// Ground grid
// ---------------------------------------------------------------------------
function gridMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    toneMapped: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: new THREE.Color(SYNTH.ground) },
        uMinor: { value: neon(SYNTH.magenta, 2.2) },
        uMajor: { value: neon(SYNTH.cyan, 2.6) },
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
      uniform vec3 uBase;
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform float uTime;
      uniform float uWave;
      uniform float uEffort;
      varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      ${GRID_LINE}
      void main() {
        vec2 p = vWorld.xz / 10.0;
        float minor = max(gridLine(p.x, 0.006), gridLine(p.y, 0.006));
        vec2 P = vWorld.xz / 80.0;
        float major = max(gridLine(P.x, 0.0018), gridLine(P.y, 0.0018));
        minor *= 1.0 - major;
        // energy ripples rolling outward from the rider
        float d = length(vWorld.xz - cameraPosition.xz);
        float wave = pow(0.5 + 0.5 * sin(d * 0.035 - uWave), 6.0 - 3.0 * uEffort);
        float pulse = (0.8 + 0.2 * sin(uTime * 1.3) + 0.9 * wave) * (1.0 + 0.45 * uEffort);
        vec3 col = uBase + uMinor * minor * pulse + uMajor * major * (0.9 + 0.5 * wave);
        // faint glow on the ground around each line
        col += uMinor * 0.05 * pulse;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  mat.uniforms.uTime = uTime; // shared (merge() above clones, so attach afterwards)
  mat.uniforms.uWave = uWave;
  mat.uniforms.uEffort = uEffort;
  return mat;
}

// ---------------------------------------------------------------------------
// Sky: gradient, stars, retro sun (one dome that follows the camera)
// ---------------------------------------------------------------------------
function stickToCamera(m: THREE.Mesh) {
  m.frustumCulled = false;
  m.onBeforeRender = (_r, _s, camera) => {
    m.position.copy(camera.position);
    m.updateMatrixWorld();
  };
}

function buildSky(sunDir: THREE.Vector3): THREE.Mesh {
  const C = (h: string) => new THREE.Color(h);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uTime,
      uSunDir: { value: sunDir.clone().normalize() },
      uHaze: { value: C(SYNTH.haze) },
      uGlow: { value: C('#ff3f8f').multiplyScalar(1.15) },
      uMag: { value: C('#9c1d8c') },
      uPurple: { value: C('#3c0d6e') },
      uIndigo: { value: C('#0d0530') },
      uTop: { value: C(SYNTH.skyTop) },
      uSunHot: { value: neon('#ffc63a', 1.45) },
      uSunCool: { value: neon('#ff2a8c', 1.6) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir, uHaze, uGlow, uMag, uPurple, uIndigo, uTop, uSunHot, uSunCool;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        // gradient: haze below the horizon, hot glow at it, then magenta, purple, indigo
        vec3 col = mix(uHaze, uGlow, smoothstep(-0.02, 0.006, y));
        col = mix(col, uMag, smoothstep(0.006, 0.07, y));
        col = mix(col, uPurple, smoothstep(0.05, 0.2, y));
        col = mix(col, uIndigo, smoothstep(0.16, 0.45, y));
        col = mix(col, uTop, smoothstep(0.4, 0.95, y));

        // stars
        vec3 sp = d * 260.0;
        vec3 cell = floor(sp);
        float h = hash(cell);
        if (h > 0.95) {
          vec3 at = vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) * 0.6 + 0.2;
          float r = length(fract(sp) - at);
          float tw = 0.6 + 0.4 * sin(uTime * (1.5 + h * 30.0) + h * 400.0);
          float s = smoothstep(0.16, 0.0, r) * tw * (0.6 + 2.4 * fract(h * 97.0));
          col += vec3(0.85, 0.85, 1.0) * s * smoothstep(0.04, 0.3, y);
        }

        // retro sun
        vec3 right = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
        vec3 up = cross(right, uSunDir);
        float facing = dot(d, uSunDir);
        vec2 p = vec2(dot(d, right), dot(d, up)) / 0.2; // angular radius ~11.5 degrees
        float r = length(p);
        if (facing > 0.0) {
          float fw = fwidth(r);
          float disc = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, r);
          // slats in the lower part, thicker towards the bottom, drifting downwards
          float t = clamp((0.45 - p.y) / 1.2, 0.0, 1.0);
          float gap = mix(0.04, 0.7, t) * step(p.y, 0.45);
          float s = fract(p.y * 8.0 + uTime * 0.15);
          float sfw = fwidth(p.y * 8.0);
          float slat = smoothstep(gap - sfw, gap + sfw, s);
          disc *= mix(1.0, slat, step(0.001, gap));
          vec3 sun = mix(uSunCool, uSunHot, smoothstep(-0.35, 0.95, p.y));
          float halo = exp(-max(r - 1.0, 0.0) * 2.6) * 0.55 * (1.0 - disc);
          col = mix(col, sun, disc);
          col += uSunCool * 0.18 * halo * smoothstep(-0.05, 0.05, y + 0.02);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(6500, 48, 24), mat);
  m.renderOrder = -9; // after the engine's own gradient dome (-10), before everything else
  stickToCamera(m);
  return m;
}

// ---------------------------------------------------------------------------
// Wireframe mountains ring
// ---------------------------------------------------------------------------
function buildMountains(route: Route, cx: number, cz: number, baseY: number, r: () => number): THREE.Mesh {
  let R = 0;
  for (let i = 0; i < route.x.length; i++) R = Math.max(R, Math.hypot(route.x[i] - cx, route.z[i] - cz));
  const R0 = R + 1700;
  const depth = 1600;
  const segs = 300;
  const rows = 7;
  // per-angle ridge height: a few octaves of periodic noise with sharp peaks
  const waves: { k: number; a: number; ph: number }[] = [];
  for (const [k, a] of [
    [3, 0.5],
    [7, 0.35],
    [13, 0.25],
    [23, 0.18],
    [41, 0.1],
  ] as const)
    waves.push({ k, a, ph: r() * 6.283 });
  const ridge = (t: number) => {
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(w.k * t + w.ph);
    return Math.pow(Math.max(0, 0.55 + v * 0.75), 1.6);
  };
  const pos: number[] = [];
  const uv: number[] = [];
  const hgt: number[] = [];
  for (let j = 0; j <= segs; j++) {
    const t = (j / segs) * Math.PI * 2;
    const peak = 120 + 620 * ridge(t);
    for (let k = 0; k <= rows; k++) {
      const f = k / rows;
      // profile across the range: rises from the front, peaks at ~60 %, falls a little behind
      const prof = Math.sin(Math.min(1, f / 0.62) * Math.PI * 0.5) * (f > 0.62 ? 1 - (f - 0.62) * 1.1 : 1);
      const jit = j % segs === 0 ? 0 : (r() - 0.5) * 0.25;
      const hh = k === 0 ? -30 : peak * prof * (0.85 + jit);
      const rr = R0 + f * depth + (k === 0 || j % segs === 0 ? 0 : (r() - 0.5) * 120);
      pos.push(cx + Math.cos(t) * rr, baseY + hh, cz + Math.sin(t) * rr);
      uv.push(j, k);
      hgt.push(Math.max(0, hh) / 740);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) {
    for (let k = 0; k < rows; k++) {
      const a = j * (rows + 1) + k;
      const b = a + rows + 1;
      // diagonal from (j+1,k) to (j,k+1): matches the u+v lines in the shader
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aHeight', new THREE.Float32BufferAttribute(hgt, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: {
      uFill: { value: new THREE.Color('#0c0322') },
      uHaze: { value: new THREE.Color(SYNTH.haze) },
      uLow: { value: neon(SYNTH.magenta, 1.6) },
      uHigh: { value: neon(SYNTH.cyan, 2.4) },
    },
    vertexShader: /* glsl */ `
      attribute float aHeight;
      varying vec2 vUv;
      varying float vH;
      void main() {
        vUv = uv;
        vH = aHeight;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uFill, uHaze, uLow, uHigh;
      varying vec2 vUv;
      varying float vH;
      float wire(float x) {
        float fw = fwidth(x);
        float q = abs(fract(x - 0.5) - 0.5);
        return 1.0 - smoothstep(0.0, fw * 1.3, q);
      }
      void main() {
        float w = max(max(wire(vUv.x), wire(vUv.y)), wire(vUv.x + vUv.y));
        vec3 edge = mix(uLow, uHigh, smoothstep(0.05, 0.6, vH));
        vec3 fill = mix(uHaze * 0.7, uFill, smoothstep(0.0, 0.25, vH));
        vec3 col = mix(fill, edge, w * smoothstep(0.0, 0.06, vH));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -5;
  return m;
}

// ---------------------------------------------------------------------------
// Roadside geometry
// ---------------------------------------------------------------------------
function palmGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // curved trunk: stacked tapering segments leaning over
  let x = 0;
  let y = 0;
  const segs = 7;
  for (let s = 0; s < segs; s++) {
    const len = 1.5;
    const lean = 0.05 + s * 0.045;
    const r0 = 0.32 - s * 0.025;
    const seg = new THREE.CylinderGeometry(r0 - 0.025, r0, len, 6, 1, true).rotateZ(-lean).translate(x + Math.sin(lean) * len * 0.5, y + Math.cos(lean) * len * 0.5, 0);
    parts.push(seg);
    x += Math.sin(lean) * len;
    y += Math.cos(lean) * len * 0.98;
  }
  // fronds: chains of thin blades arching up and out from the crown, then drooping
  const fronds = 9;
  for (let f = 0; f < fronds; f++) {
    const ang = (f / fronds) * Math.PI * 2 + 0.3;
    let rx = 0;
    let ry = 0;
    let el = 0.55 + ((f * 7) % 3) * 0.12;
    for (let k = 0; k < 4; k++) {
      const len = 1.15;
      const blade = new THREE.PlaneGeometry(len, 0.62 - k * 0.13)
        .rotateX(Math.PI / 2)
        .translate(len / 2, 0, 0)
        .rotateZ(el)
        .translate(rx, ry, 0)
        .rotateY(ang)
        .translate(x, y, 0);
      parts.push(blade);
      rx += Math.cos(el) * len;
      ry += Math.sin(el) * len;
      el -= 0.5;
    }
  }
  return merge(parts);
}

function chevronTexture() {
  return canvasTex(
    128,
    128,
    (g) => {
      g.clearRect(0, 0, 128, 128);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 20;
      g.lineJoin = 'miter';
      g.lineCap = 'butt';
      for (const dx of [-26, 18]) {
        g.beginPath();
        g.moveTo(34 + dx, 18);
        g.lineTo(78 + dx, 64);
        g.lineTo(34 + dx, 110);
        g.stroke();
      }
    },
    false,
  );
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
export function buildSynthwave(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const r = rng(route.seed * 53 + 17);
  const planeY = L.minY - 1.2;
  const out: THREE.Object3D[] = [];

  // --- sun direction: low on the horizon, straight ahead at the start line
  const h0 = route.heading[Math.round(150 / route.step) % n];
  const elev = 0.09;
  const sunDir = new THREE.Vector3(Math.cos(h0) * Math.cos(elev), Math.sin(elev), Math.sin(h0) * Math.cos(elev));
  out.push(buildSky(sunDir));

  // --- ground: a terrain ribbon easing from road level down to an endless grid plane
  const grid = gridMaterial();
  const { offs, roadCol } = mirroredColumns([EDGE, EDGE + 1.2, 8, 13, 20, 30, 45, 65, 90, 125, 170, 230, 300]);
  const model: TerrainModel = {
    cols: offs.length,
    roadCol,
    colOff: (_i, c) => offs[c],
    height(i, off) {
      const a = Math.abs(off);
      if (a < EDGE + 1.2) return -0.12;
      const target = planeY - route.y[i];
      return -0.12 + (target + 0.12) * smooth(EDGE + 1.2, 220, a);
    },
    color(_i, _o, _d, c) {
      c.setRGB(1, 1, 1);
    },
  };
  const terrain = buildTerrainMesh(route, model);
  terrain.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      (m.material as THREE.Material).dispose();
      m.material = grid;
      m.receiveShadow = false;
    }
  });
  out.push(terrain);
  const plane = new THREE.Mesh(new THREE.CircleGeometry(11000, 96).rotateX(-Math.PI / 2), grid);
  plane.position.set(L.cx, planeY - 0.25, L.cz);
  out.push(plane);

  // --- mountains
  out.push(buildMountains(route, L.cx, L.cz, planeY, r));

  // --- neon road lines
  out.push(glowRibbon(route));

  // --- roadside: pylons, palms, chevrons
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const cyan = new THREE.Color(SYNTH.cyan);
  const magenta = new THREE.Color(SYNTH.magenta);

  const poles: Inst[] = [];
  const tubes: Inst[] = [];
  const every = Math.max(1, Math.round((opts.high ? 40 : 60) / route.step));
  let k = 0;
  for (let i = 0; i < n; i += every, k++) {
    for (const side of [-1, 1]) {
      if ((k + (side > 0 ? 1 : 0)) % 2) continue; // staggered sides
      const p = worldAt(route, i, side * (ROAD_HALF + 2.4), -0.1);
      // local +z is +lateral: turn the far-side pylons round so every arm reaches over the road
      q.setFromAxisAngle(up, -route.heading[i] + (side > 0 ? Math.PI : 0));
      const m = new THREE.Matrix4().compose(p, q, one);
      poles.push({ i, m });
      tubes.push({ i, m, c: (k >> 1) % 2 ? cyan : magenta });
    }
  }
  const poleGeo = merge([new THREE.BoxGeometry(0.22, 6.2, 0.22).translate(0, 3.1, 0), new THREE.BoxGeometry(0.16, 0.16, 2.2).translate(0, 6.1, 1.0)]);
  out.push(chunkedInstances(route, poleGeo, new THREE.MeshLambertMaterial({ color: '#15101f' }), poles, { shadow: false }));
  const tubeGeo = merge([
    new THREE.CylinderGeometry(0.05, 0.05, 5.0, 6).translate(0.13, 3.2, 0), // vertical strip on the pole
    new THREE.BoxGeometry(0.1, 0.06, 1.6).translate(0, 5.98, 1.25), // light bar under the arm
  ]);
  const tubeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), toneMapped: false });
  out.push(chunkedInstances(route, tubeGeo, tubeMat, tubes, { shadow: false }));

  // palms: silhouettes in clusters out on the grid
  const palms: Inst[] = [];
  const pDensity = opts.high ? 1 : 0.5;
  for (let i = 0; i < n; i += 4) {
    for (const side of [-1, 1]) {
      if (r() > 0.11 * pDensity) continue;
      const cluster = 1 + Math.floor(r() * 3);
      const base = 9 + Math.pow(r(), 1.6) * 140;
      for (let c = 0; c < cluster; c++) {
        const off = clampOff(route, i, side * (base + c * (2 + r() * 4)));
        const p = worldAt(route, i, off, 0);
        jitterAlong(p, route, i, 10, r);
        const a = Math.abs(off);
        p.y = route.y[i] + (-0.12 + (planeY - route.y[i] + 0.12) * smooth(EDGE + 1.2, 220, a)) - 0.2;
        const s = 0.9 + r() * 0.6;
        palms.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.283), new THREE.Vector3(s, s * (0.85 + r() * 0.4), s)) });
      }
    }
  }
  out.push(chunkedInstances(route, palmGeometry(), new THREE.MeshBasicMaterial({ color: '#0a0314', side: THREE.DoubleSide }), palms, { shadow: false }));

  // chevrons on the outside of tighter bends, facing the rider
  const chev: Inst[] = [];
  const w = 6;
  const chevEvery = Math.max(1, Math.round(14 / route.step));
  for (let i = 0; i < n; i += chevEvery) {
    let dh = route.heading[(i + w) % n] - route.heading[(i - w + n) % n];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const curv = dh / (2 * w * route.step);
    if (Math.abs(curv) < 1 / 600) continue; // only the tighter bends of this flowing course
    const turn = Math.sign(curv); // +1: bending towards +lateral
    const p = worldAt(route, i, -turn * (ROAD_HALF + 1.9), 1.35);
    const h = route.heading[i];
    const fwd = new THREE.Vector3(Math.cos(h), 0, Math.sin(h));
    const zAxis = fwd.clone().negate(); // face the oncoming rider
    const xAxis = new THREE.Vector3().crossVectors(up, zAxis); // = +lateral
    const m = new THREE.Matrix4().makeBasis(xAxis.multiplyScalar(turn), up, zAxis);
    m.scale(new THREE.Vector3(1.3, 1.0, 1));
    m.setPosition(p);
    chev.push({ i, m });
  }
  const chevMat = new THREE.MeshBasicMaterial({ map: chevronTexture(), color: neon('#ffb02e', 2.6), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, toneMapped: false });
  out.push(chunkedInstances(route, new THREE.PlaneGeometry(1, 1), chevMat, chev, { shadow: false }));

  return out;
}
