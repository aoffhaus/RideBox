// Alien world ("Xenoworld"): a smooth obsidian road across a violet and indigo
// plain under a teal-to-amber sky. Two suns (a big orange one and a small
// blue-white companion) hang low; a huge banded, ringed gas giant fills a wedge of
// the sky with a couple of small moons beside it. Turquoise moss patches, smooth
// eroded rock arches (some spanning the road), glowing crystal clusters, giant
// mushroom trees with luminous gills, swaying tube plants with glowing tips and
// fields of tiny glowing bulbs line the road; odd-coloured mesas, hoodoos and
// floating rock islands stand on the horizon, and spores drift around the rider.
//
// Glowing parts carry a per-vertex `glow` weight and are pushed above the bloom
// threshold through the material's emissive term (see `glowMat`), so they stay
// lit materials (wind sway and fog still apply) and bloom on high quality.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  ROAD_HALF,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clampOff,
  detailTex,
  jitterAlong,
  loopInfo,
  merge,
  mirroredColumns,
  radialTex,
  rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { buildDustMotes, windy, fxBuild, fxSurge } from '../fx';
import { sunDirection } from '../sky';

// ---------------------------------------------------------------------------
// Palette & sky layout
// ---------------------------------------------------------------------------
export const ALIEN = {
  haze: '#86608e',
  skyTop: '#06202c',
  skyHorizon: '#e09a62',
  /** Main (big orange) sun, in degrees; the scene's key light uses the same direction. */
  sun: { elevation: 15, azimuth: 58 },
};
/** Small blue-white companion sun. */
const SUN2 = { elevation: 10, azimuth: 46 };
/** Gas giant centre and angular radius (radians). */
const PLANET = { elevation: 15.5, azimuth: 112, radius: 0.2 };
const MOON1 = { elevation: 27, azimuth: 152, radius: 0.02 };
const MOON2 = { elevation: 21, azimuth: 86, radius: 0.013 };

/** Shared by every alien material: one object, so `update` needs no bookkeeping across rebuilds. */
const uTime = { value: 0 };

export function alienUpdate(time: number) {
  uTime.value = time;
}

const hdr = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);

// ---------------------------------------------------------------------------
// Small deterministic 2D value noise (world-space, so it is seamless round the loop)
// ---------------------------------------------------------------------------
function hash2(x: number, y: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number, oct = 3) {
  let v = 0;
  let a = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    v += a * vnoise(x * f + o * 17.3, y * f - o * 9.1);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}

// ---------------------------------------------------------------------------
// Glowing lit material: vertex colour (× instance colour) is both the albedo and,
// weighted by the per-vertex `glow` attribute, an HDR emissive that blooms.
// ---------------------------------------------------------------------------
interface GlowOpts {
  k: number; // emissive multiplier for glow = 1
  pulse?: number; // 0..1 slow per-instance breathing of the glow
  flat?: boolean;
  bob?: number; // local-space vertical bob amplitude (floating islands)
  side?: THREE.Side;
}
function glowMat(o: GlowOpts) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: o.flat ?? false, side: o.side ?? THREE.FrontSide });
  const pulse = (o.pulse ?? 0).toFixed(3);
  const bob = (o.bob ?? 0).toFixed(3);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAlienTime = uTime;
    shader.uniforms.fxBuild = fxBuild;
    shader.uniforms.fxSurge = fxSurge;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;\nvarying float vPulse;\nuniform float uAlienTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          vGlow = glow;
          #ifdef USE_INSTANCING
            vec3 aRoot = (modelMatrix * instanceMatrix[3]).xyz;
          #else
            vec3 aRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float ph = aRoot.x * 0.21 + aRoot.z * 0.17;
          vPulse = 1.0 + ${pulse} * (0.6 * sin(uAlienTime * 1.1 + ph) + 0.4 * sin(uAlienTime * 2.7 + ph * 1.7));
          transformed.y += ${bob} * sin(uAlienTime * 0.23 + aRoot.x * 0.013 + aRoot.z * 0.007);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying float vPulse;\nuniform float fxBuild;\nuniform float fxSurge;').replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `#include <emissivemap_fragment>
      // the bioluminescence answers your effort: brighter as it builds, a flash on a sprint
      totalEmissiveRadiance += vColor.rgb * vGlow * ${o.k.toFixed(3)} * vPulse * (1.0 + 1.3 * fxBuild + 1.0 * fxSurge);
      diffuseColor.rgb *= 1.0 - 0.8 * clamp(vGlow, 0.0, 1.0);`,
    );
  };
  mat.customProgramCacheKey = () => `alien-glow:${o.k}:${pulse}:${bob}`;
  return mat;
}

/** Give a geometry the attributes `glowMat` expects (flat colour + glow weight). */
function tag(geo: THREE.BufferGeometry, hex: string | THREE.Color, glow: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const c = typeof hex === 'string' ? new THREE.Color(hex) : hex;
  const col = new Float32Array(n * 3);
  const gl = new Float32Array(n).fill(glow);
  for (let k = 0; k < n; k++) c.toArray(col, k * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('glow', new THREE.BufferAttribute(gl, 1));
  return g;
}

/** Recolour per vertex by a function of its position/normal (after `tag`). */
function paint(geo: THREE.BufferGeometry, fn: (p: THREE.Vector3, nrm: THREE.Vector3, out: THREE.Color) => void) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const c = new THREE.Color();
  for (let k = 0; k < pos.count; k++) {
    p.fromBufferAttribute(pos, k);
    nn.fromBufferAttribute(nor, k);
    fn(p, nn, c);
    col.setXYZ(k, c.r, c.g, c.b);
  }
  return geo;
}

function mergeTagged(parts: THREE.BufferGeometry[]) {
  // drop uv so every part shares the same attribute set
  for (const p of parts) p.deleteAttribute('uv');
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Road
// ---------------------------------------------------------------------------
/** Smooth dark obsidian resin with faint swirls and glints; the edge glow is a separate ribbon. */
export function alienRoad() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#1d1828';
    g.fillRect(0, 0, 256, 512);
    const r = rng(311);
    // slow resin swirls
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = r() < 0.5 ? `rgba(90,60,140,${0.05 + r() * 0.07})` : `rgba(40,110,120,${0.04 + r() * 0.06})`;
      g.lineWidth = 2 + r() * 8;
      g.beginPath();
      let x = r() * 256;
      let y = r() * 512;
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        const nx = x + (r() - 0.5) * 70;
        const ny = y + 20 + r() * 60;
        g.quadraticCurveTo(x + (r() - 0.5) * 60, (y + ny) / 2, nx, ny);
        x = nx;
        y = ny;
      }
      g.stroke();
    }
    for (let i = 0; i < 6000; i++) {
      const v = 22 + r() * 22;
      g.fillStyle = `rgb(${v + 6},${v},${v + 16})`;
      g.fillRect(r() * 256, r() * 512, 1.4, 1.4);
    }
    // mineral glints
    for (let i = 0; i < 260; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(150,240,255,0.55)' : 'rgba(230,170,255,0.5)';
      g.fillRect(r() * 256, r() * 512, 1.2, 1.2);
    }
    // inlaid strip channels (lit by the glow ribbon) and a faint centre seam
    g.fillStyle = '#123e46';
    g.fillRect(8, 0, 8, 512);
    g.fillRect(240, 0, 8, 512);
    g.fillStyle = 'rgba(120,90,170,0.35)';
    g.fillRect(126, 0, 4, 512);
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
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uEdge: { value: hdr('#3ff5d8', 1.05) }, uStud: { value: hdr('#c58cff', 1.0) },
        uSheen: { value: new THREE.Color('#e7a070') },
        uSunDir: { value: sunDirection(ALIEN.sun.elevation, ALIEN.sun.azimuth, new THREE.Vector3()) },
      },
    ]),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uEdge;
      uniform vec3 uStud;
      uniform vec3 uSheen;
      uniform vec3 uSunDir;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      float band(float x, float c, float hw) {
        float fw = fwidth(x);
        return 1.0 - smoothstep(hw - fw, hw + fw, abs(x - c));
      }
      void main() {
        float x = abs(vUv.x);
        // a soft energy pulse running along the inlays
        float wave = 0.7 + 0.3 * sin(vUv.y * 0.06 - uTime * 2.2);
        float edge = band(x, 4.12, 0.045) * wave;
        float halo = exp(-abs(x - 4.12) * 6.0) * 0.08;
        // tiny glowing studs along the centre seam
        float sy = fract(vUv.y / 6.0) - 0.5;
        float stud = smoothstep(0.08, 0.0, length(vec2(vUv.x, sy * 6.0)));
        vec3 col = uEdge * (edge + halo) + uStud * stud * (0.6 + 0.4 * wave);
        // polished obsidian: the low sky and the sun glinting off the resin at grazing angles
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 R = vec3(-V.x, V.y, -V.z);
        float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 8.0);
        float glint = pow(max(dot(R, uSunDir), 0.0), 40.0);
        col += uSheen * (fres * 0.05 + glint * 0.12) * (1.0 - smoothstep(3.6, 4.5, x) * 0.6);
        #ifdef USE_FOG
          col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  mat.uniforms.uTime = uTime;
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------------------
// Sky: gradient, stars, twin suns, ringed gas giant and moons (one camera-following dome)
// ---------------------------------------------------------------------------
function stickToCamera(m: THREE.Object3D) {
  m.frustumCulled = false;
  m.onBeforeRender = (_r, _s, camera) => {
    m.position.copy(camera.position);
    m.updateMatrixWorld();
  };
}

function buildSky(): THREE.Mesh {
  const C = (h: string) => new THREE.Color(h);
  const dir = (o: { elevation: number; azimuth: number }) => sunDirection(o.elevation, o.azimuth, new THREE.Vector3());
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uTime,
      uSun: { value: dir(ALIEN.sun) },
      uSun2: { value: dir(SUN2) },
      uPlanet: { value: dir(PLANET) },
      uPlanetR: { value: Math.tan(PLANET.radius) },
      uMoon1: { value: dir(MOON1) },
      uMoon1R: { value: Math.tan(MOON1.radius) },
      uMoon2: { value: dir(MOON2) },
      uMoon2R: { value: Math.tan(MOON2.radius) },
      uHaze: { value: C(ALIEN.haze) },
      uAmber: { value: C(ALIEN.skyHorizon) },
      uGold: { value: C('#ecc98e') },
      uAqua: { value: C('#8fcfc2') },
      uTeal: { value: C('#2f8b93') },
      uDeep: { value: C('#0f4656') },
      uZenith: { value: C(ALIEN.skyTop) },
      uSunCol: { value: hdr('#ff5a10', 4.5) },
      uSunGlow: { value: C('#ff7a2e') },
      uSun2Col: { value: hdr('#a8d0ff', 5.0) },
      uSun2Glow: { value: C('#8fc8ff') },
      uBandA: { value: C('#f3dcb4') },
      uBandB: { value: C('#d98a6a') },
      uBandC: { value: C('#9b4f3e') },
      uBandD: { value: C('#b7a0d4') },
      uRing: { value: C('#e8d6c4') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSun, uSun2, uPlanet, uMoon1, uMoon2;
      uniform float uPlanetR, uMoon1R, uMoon2R;
      uniform vec3 uHaze, uAmber, uGold, uAqua, uTeal, uDeep, uZenith;
      uniform vec3 uSunCol, uSunGlow, uSun2Col, uSun2Glow;
      uniform vec3 uBandA, uBandB, uBandC, uBandD, uRing;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }

      // tangent frame looking at direction c: (ex, ey) across the sky, ez back towards the viewer
      void frame(vec3 c, out vec3 ex, out vec3 ey, out vec3 ez) {
        ez = -c;
        ex = normalize(cross(vec3(0.0, 1.0, 0.0), ez));
        ey = cross(ez, ex);
      }

      // a small sphere lit by the main sun: rgb + coverage in a
      vec4 moon(vec3 d, vec3 c, float tr, vec3 albedo) {
        if (dot(d, c) <= 0.0) return vec4(0.0);
        vec3 ex, ey, ez;
        frame(c, ex, ey, ez);
        vec2 p = vec2(dot(d, ex), dot(d, ey)) / tr;
        float r = length(p);
        float fw = fwidth(r);
        float a = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, r);
        if (a <= 0.0) return vec4(0.0);
        vec3 n = vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))));
        vec3 L = normalize(vec3(dot(uSun, ex), dot(uSun, ey), dot(uSun, ez)) + vec3(0.0, 0.0, 0.7));
        float lit = smoothstep(-0.05, 0.25, dot(n, L));
        float mare = 0.85 + 0.15 * sin(n.x * 9.0 + n.y * 5.0) * sin(n.y * 11.0 - n.x * 3.0);
        return vec4(albedo * (0.05 + 1.1 * lit) * mare, a);
      }

      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;

        // --- gradient: dusky haze below, amber at the horizon, gold, pale aqua, teal, deep teal
        vec3 col = mix(uHaze, uAmber, smoothstep(-0.03, 0.025, y));
        col = mix(col, uGold, smoothstep(0.03, 0.11, y));
        col = mix(col, uAqua, smoothstep(0.09, 0.24, y));
        col = mix(col, uTeal, smoothstep(0.2, 0.44, y));
        col = mix(col, uDeep, smoothstep(0.4, 0.72, y));
        col = mix(col, uZenith, smoothstep(0.68, 1.0, y));
        // the horizon burns brighter under the suns
        vec2 hz = normalize(d.xz + 1e-5);
        float toSun = max(dot(hz, normalize(uSun.xz)), 0.0);
        col += uSunGlow * 0.32 * pow(toSun, 5.0) * (1.0 - smoothstep(-0.02, 0.4, y)) * smoothstep(-0.06, 0.0, y);
        // faint nebula veil across the darker sky
        float veil = exp(-pow(dot(d, normalize(vec3(0.55, 0.35, -0.76))) * 3.2, 2.0));
        float vn = hash(floor(d * 22.0)) * 0.3 + 0.7;
        col += vec3(0.05, 0.015, 0.07) * veil * vn * smoothstep(0.25, 0.7, y);

        // --- stars (only where the sky is dark)
        vec3 sp = d * 240.0;
        vec3 cell = floor(sp);
        float h = hash(cell);
        if (h > 0.955) {
          vec3 at = vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) * 0.6 + 0.2;
          float r = length(fract(sp) - at);
          float tw = 0.65 + 0.35 * sin(uTime * (1.2 + h * 20.0) + h * 400.0);
          float s = smoothstep(0.14, 0.0, r) * tw * (0.4 + 1.6 * fract(h * 97.0));
          vec3 sc = mix(vec3(0.75, 0.9, 1.0), vec3(1.0, 0.8, 0.95), fract(h * 31.0));
          col += sc * s * smoothstep(0.3, 0.75, y) * 0.8;
        }

        // --- suns: discs and coronas
        float a1 = length(d - uSun);
        float a2 = length(d - uSun2);
        col += uSunGlow * (exp(-a1 * 14.0) * 0.8 + exp(-a1 * 4.0) * 0.22);
        col += uSun2Glow * (exp(-a2 * 40.0) * 0.35 + exp(-a2 * 8.0) * 0.06);
        float fw1 = fwidth(a1);
        float disc1 = 1.0 - smoothstep(0.044 - fw1, 0.044 + fw1, a1);
        col = mix(col, uSunCol * (1.0 - 0.35 * pow(a1 / 0.044, 2.0)), disc1);
        float fw2 = fwidth(a2);
        float disc2 = 1.0 - smoothstep(0.015 - fw2, 0.015 + fw2, a2);
        col = mix(col, uSun2Col, disc2);

        // --- moons
        vec4 m1 = moon(d, uMoon1, uMoon1R, vec3(0.78, 0.72, 0.8));
        col = mix(col, m1.rgb + col * 0.15, m1.a);
        vec4 m2 = moon(d, uMoon2, uMoon2R, vec3(0.6, 0.78, 0.82));
        col = mix(col, m2.rgb + col * 0.15, m2.a);

        // --- gas giant with a tilted ring
        if (dot(d, uPlanet) > 0.0) {
          vec3 ex, ey, ez;
          frame(uPlanet, ex, ey, ez);
          vec2 p = vec2(dot(d, ex), dot(d, ey)) / uPlanetR;
          float r2 = dot(p, p);
          float r = sqrt(r2);
          // lit from the big sun's side, but biased towards the viewer so the giant reads as a fat gibbous
          vec3 L = normalize(normalize(vec3(dot(uSun, ex), dot(uSun, ey), dot(uSun, ez))) + vec3(0.0, 0.0, 0.85));
          vec3 L2 = normalize(vec3(dot(uSun2, ex), dot(uSun2, ey), dot(uSun2, ez)));
          vec3 A = normalize(vec3(0.42, 0.9, 0.2)); // ring / spin axis (planet frame)
          float haze = 0.05 + 0.5 * (1.0 - smoothstep(0.02, 0.3, y));
          vec3 skyBehind = col;
          float RIN = 1.32;
          float ROUT = 2.3;

          // planet disc
          float fw = fwidth(r);
          float cover = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, r);
          float zFront = sqrt(max(0.0, 1.0 - r2));
          if (cover > 0.0) {
            vec3 n = vec3(p, zFront);
            vec3 B = normalize(cross(A, vec3(0.0, 0.0, 1.0)));
            vec3 Cc = cross(A, B);
            float lat = dot(n, A);
            float lon = atan(dot(n, Cc), dot(n, B));
            float tl = lat + 0.025 * sin(lon * 5.0 + lat * 23.0) + 0.012 * sin(lon * 13.0 - lat * 61.0);
            float f = 0.5 + 0.5 * (0.55 * sin(tl * 17.0) + 0.3 * sin(tl * 39.0 + 1.3) + 0.15 * sin(tl * 83.0 + 0.4));
            vec3 pc = mix(uBandC, uBandB, smoothstep(0.15, 0.45, f));
            pc = mix(pc, uBandA, smoothstep(0.5, 0.85, f));
            pc = mix(pc, uBandD, smoothstep(0.55, 0.9, 0.5 + 0.5 * sin(tl * 7.0 + 2.0)) * 0.45);
            // a great oval storm
            vec2 sd = vec2((lon - 0.7) * 0.55, (lat + 0.32) * 2.2);
            float storm = exp(-dot(sd, sd) * 18.0);
            float swirl = 0.5 + 0.5 * sin(length(sd) * 40.0 - atan(sd.y, sd.x) * 2.0);
            pc = mix(pc, mix(vec3(0.55, 0.16, 0.1), vec3(0.95, 0.7, 0.55), swirl), storm * 0.85);
            // lighting: soft terminator, the blue sun's rim light and a dim teal night glow
            float ndl = dot(n, L);
            float lit = smoothstep(-0.06, 0.4, ndl);
            // ring shadow: from the surface towards the sun, through the ring plane
            float al = dot(L, A);
            if (abs(al) > 1e-3) {
              float t = -dot(n, A) / al;
              if (t > 0.0) {
                float rr = length(n + t * L);
                float dens = smoothstep(RIN, RIN + 0.06, rr) * (1.0 - smoothstep(ROUT - 0.08, ROUT, rr)) * (0.75 + 0.25 * sin(rr * 38.0)) * (1.0 - 0.8 * exp(-pow((rr - 1.86) * 30.0, 2.0)));
                lit *= 1.0 - 0.88 * dens;
              }
            }
            float limb = pow(zFront, 0.35);
            vec3 pcol = pc * (lit * 1.25 * limb) + pc * vec3(0.05, 0.12, 0.14) * 0.6 + vec3(0.45, 0.6, 0.9) * 0.18 * smoothstep(0.0, 0.6, dot(n, L2)) * (1.0 - limb * 0.6);
            // bright scattering at the lit limb
            pcol += vec3(1.0, 0.75, 0.6) * 0.25 * pow(1.0 - zFront, 3.0) * smoothstep(-0.1, 0.4, ndl);
            pcol = mix(pcol, skyBehind, haze);
            col = mix(col, pcol, cover);
          }
          // thin atmosphere halo just outside the disc on the lit side
          if (r > 1.0) {
            vec3 nd = normalize(vec3(p, 0.0));
            col += vec3(1.0, 0.72, 0.55) * 0.3 * exp(-(r - 1.0) * 22.0) * smoothstep(-0.3, 0.6, dot(nd, L)) * (1.0 - haze);
          }
          // ring (viewed from far away: parallel rays)
          if (abs(A.z) > 1e-3) {
            float z = -(A.x * p.x + A.y * p.y) / A.z;
            vec3 x = vec3(p, z);
            float rr = length(x);
            bool hidden = r2 < 1.0 && z < zFront;
            if (!hidden && rr > RIN && rr < ROUT) {
              float fwr = fwidth(rr);
              float dens = smoothstep(RIN, RIN + 0.06 + fwr, rr) * (1.0 - smoothstep(ROUT - 0.1 - fwr, ROUT, rr));
              dens *= 0.72 + 0.16 * sin(rr * 38.0) + 0.12 * sin(rr * 97.0 + 1.0);
              dens *= 1.0 - 0.85 * exp(-pow((rr - 1.86) * 30.0, 2.0)); // a dark gap
              // shadow of the planet on the ring
              float b = dot(x, L);
              float disc = b * b - (dot(x, x) - 1.0);
              float shadow = (disc > 0.0 && b < 0.0) ? 0.15 : 1.0;
              vec3 rc = uRing * mix(0.85, 1.1, fract(rr * 4.7)) * (0.12 + 1.0 * shadow * (0.4 + 0.6 * abs(dot(A, L))));
              rc = mix(rc, skyBehind, haze * 0.8);
              col = mix(col, rc, clamp(dens, 0.0, 1.0) * 0.88);
            }
          }
        }

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(6500, 64, 32), mat);
  m.renderOrder = -9; // after the engine's own gradient dome (-10), before everything else
  stickToCamera(m);
  return m;
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------
/** Smooth eroded rock arch: a thickened half-torus whose legs flare into the ground. Spans x = ±1. */
function archGeometry(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(1, 0.17, 12, 36, Math.PI + 0.5).rotateZ(-0.25);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k);
    c.set(v.x, v.y, 0).normalize();
    const ang = Math.atan2(c.y, c.x); // 0..PI across the span (slightly beyond at the legs)
    const leg = 1 - Math.max(0, Math.sin(ang));
    const off = v.clone().sub(c);
    const wobble = 1 + 0.18 * Math.sin(ang * 7 + off.z * 9) + 0.1 * Math.sin(ang * 13 + off.y * 11);
    off.multiplyScalar((1 + 0.8 * leg * leg) * wobble);
    off.z *= 1.5; // deeper than it is thick: a fin-like arch
    v.copy(c).add(off);
    pos.setXYZ(k, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const t = tag(g, '#ffffff', 0);
  const rose = new THREE.Color('#c27d9a');
  const lilac = new THREE.Color('#9a86c8');
  const dark = new THREE.Color('#5a3a68');
  const moss = new THREE.Color('#3fc2a8');
  return paint(t, (p, nrm, out) => {
    const s = 0.5 + 0.5 * Math.sin(p.y * 22 + Math.sin(p.x * 5) * 1.5);
    out.copy(lilac).lerp(rose, s * 0.8);
    out.lerp(dark, smooth(0.35, -0.1, p.y) * 0.7);
    out.lerp(moss, smooth(0.55, 0.9, nrm.y) * smooth(0.85, 1.05, p.y) * 0.85);
  });
}

/** Giant mushroom tree (≈10 m tall, cap radius ≈5 m) with glowing gills and dangling glow threads. */
function mushroomGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.42, 0.75, 9.6, 10, 8, true).translate(0, 4.8, 0);
  const sp = stem.attributes.position;
  for (let k = 0; k < sp.count; k++) {
    const y = sp.getY(k);
    sp.setX(k, sp.getX(k) + 0.9 * Math.pow(y / 9.6, 2));
    if (y < 0.6) {
      sp.setX(k, sp.getX(k) * 1.6);
      sp.setZ(k, sp.getZ(k) * 1.6);
    }
  }
  stem.computeVertexNormals();
  parts.push(
    paint(tag(stem, '#ffffff', 0), (p, _n, out) => {
      out.set('#cbb9e0').lerp(new THREE.Color('#6a4f8c'), smooth(5, 0, p.y));
    }),
  );
  const capY = 9.4;
  const cx = 0.9;
  const cap = new THREE.SphereGeometry(5, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.45).scale(1, 0.5, 1).translate(cx, capY - 0.2, 0);
  parts.push(
    paint(tag(cap, '#ffffff', 0), (p, _n, out) => {
      const rr = Math.hypot(p.x - cx, p.z);
      out.set('#7a5aa8').lerp(new THREE.Color('#d6c8f0'), smooth(4.8, 1.0, rr) * 0.6);
    }),
  );
  // gills: a shallow glowing cone under the cap
  const gills = new THREE.ConeGeometry(4.95, 1.4, 22, 2, true).rotateX(Math.PI).translate(cx, capY - 0.95, 0);
  parts.push(tag(gills, '#ffffff', 1));
  // glowing spots on the cap
  const r = rng(91);
  for (let k = 0; k < 9; k++) {
    const a = r() * Math.PI * 2;
    const rr = 1.2 + r() * 3.0;
    const yy = capY - 0.2 + 2.5 * Math.sqrt(Math.max(0, 1 - (rr / 5) ** 2));
    parts.push(tag(new THREE.SphereGeometry(0.22 + r() * 0.2, 6, 4).scale(1, 0.45, 1).translate(cx + Math.cos(a) * rr, yy, Math.sin(a) * rr), '#ffffff', 0.55));
  }
  // dangling threads from the rim
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + r() * 0.3;
    const len = 1.2 + r() * 2.4;
    const rr = 4.3 + r() * 0.4;
    parts.push(tag(new THREE.CylinderGeometry(0.03, 0.05, len, 4, 1, true).translate(cx + Math.cos(a) * rr, capY - 0.5 - len / 2, Math.sin(a) * rr), '#ffffff', 0.9));
    parts.push(tag(new THREE.SphereGeometry(0.09, 4, 3).translate(cx + Math.cos(a) * rr, capY - 0.5 - len, Math.sin(a) * rr), '#ffffff', 1.4));
  }
  return mergeTagged(parts);
}

/** Cluster of curling tube plants (≈2.6 m) with glowing tips. */
function tubePlantGeometry(seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const count = 5 + Math.floor(r() * 3);
  for (let k = 0; k < count; k++) {
    const a = r() * Math.PI * 2;
    const lean = 0.15 + r() * 0.35;
    const hgt = 1.4 + r() * 1.4;
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const out = lean * hgt * t * t + 0.1;
      pts.push(new THREE.Vector3(Math.cos(a) * out, hgt * t, Math.sin(a) * out));
    }
    const tip = pts[4].clone();
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, 5, 0.055 + r() * 0.03, 4, false);
    parts.push(
      paint(tag(tube, '#ffffff', 0), (p, _n, out) => {
        out.set('#3c2a5e').lerp(new THREE.Color('#9b7fd0'), smooth(0, 2.6, p.y));
      }),
    );
    // the glow creeps up the last part of each tube
    const neck = new THREE.CylinderGeometry(0.075, 0.065, 0.3, 6, 1, true).translate(tip.x, tip.y - 0.12, tip.z);
    parts.push(tag(neck, '#ffffff', 0.5));
    parts.push(tag(new THREE.SphereGeometry(0.13 + r() * 0.06, 6, 4).translate(tip.x, tip.y + 0.05, tip.z), '#ffffff', 1.3));
  }
  return mergeTagged(parts);
}

/** Tiny glowing bulb on a stalk (≈0.45 m). */
function bulbGeometry(): THREE.BufferGeometry {
  return mergeTagged([
    tag(new THREE.CylinderGeometry(0.015, 0.03, 0.38, 4, 1, true).translate(0, 0.19, 0), '#4a3a66', 0),
    tag(new THREE.SphereGeometry(0.08, 6, 4).scale(1, 1.25, 1).translate(0, 0.42, 0), '#ffffff', 1),
  ]);
}

/** Faceted crystal cluster: hexagonal prisms with pointed tips, splayed outwards. ≈2 m. */
function crystalGeometry(seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const count = 5 + Math.floor(r() * 4);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let k = 0; k < count; k++) {
    const rad = 0.12 + r() * 0.2;
    const len = 0.7 + r() * 1.6 * (k === 0 ? 1.4 : 1);
    const prism = new THREE.CylinderGeometry(rad, rad * 1.1, len, 6, 1).translate(0, len / 2, 0);
    const tipG = new THREE.ConeGeometry(rad, rad * 2.4, 6).translate(0, len + rad * 1.2, 0);
    const g = merge([prism, tipG]);
    const tilt = k === 0 ? r() * 0.2 : 0.3 + r() * 0.6;
    e.set(Math.cos(k * 2.4) * tilt, r() * 6.3, Math.sin(k * 2.4) * tilt);
    q.setFromEuler(e);
    g.applyQuaternion(q).translate((r() - 0.5) * 0.4, -0.15, (r() - 0.5) * 0.4);
    parts.push(g);
  }
  const g = tag(merge(parts), '#ffffff', 1);
  // per-facet brightness: every triangle a slightly different shade (reads as cut faces)
  const col = g.attributes.color as THREE.BufferAttribute;
  const gl = g.attributes.glow as THREE.BufferAttribute;
  const pos = g.attributes.position;
  for (let t = 0; t < col.count; t += 3) {
    const s = 0.55 + r() * 0.6;
    for (let v = 0; v < 3; v++) {
      col.setXYZ(t + v, s, s, s);
      gl.setX(t + v, 0.35 + 0.65 * smooth(0, 2.0, pos.getY(t + v)));
    }
  }
  g.deleteAttribute('uv');
  return g;
}

/** Edge beacon: a dark obsidian spire with a floating glowing crystal and a lit band. ≈1.6 m. */
function beaconGeometry(): THREE.BufferGeometry {
  return mergeTagged([
    tag(new THREE.CylinderGeometry(0.07, 0.2, 1.2, 4, 1).rotateY(Math.PI / 4).translate(0, 0.6, 0), '#2a2238', 0),
    tag(new THREE.CylinderGeometry(0.135, 0.15, 0.06, 4, 1, true).rotateY(Math.PI / 4).translate(0, 0.78, 0), '#ffffff', 0.9),
    tag(new THREE.OctahedronGeometry(0.15, 0).scale(1, 1.7, 1).translate(0, 1.52, 0), '#ffffff', 1.4),
  ]);
}

function mesaGeometry(): THREE.BufferGeometry {
  // a squat, slightly irregular stack of tiers with a mossy flat top (unit radius, unit height)
  const tiers = [
    new THREE.CylinderGeometry(0.86, 1.0, 0.55, 11, 3).translate(0, 0.275, 0),
    new THREE.CylinderGeometry(0.74, 0.8, 0.35, 11, 2).translate(0, 0.725, 0),
    new THREE.CylinderGeometry(0.66, 0.7, 0.12, 11, 1).translate(0, 0.96, 0),
  ];
  const g = tag(merge(tiers), '#ffffff', 0);
  const pos = g.attributes.position;
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k);
    const z = pos.getZ(k);
    const a = Math.atan2(z, x);
    const f = 1 + 0.12 * Math.sin(a * 3 + 1) + 0.07 * Math.sin(a * 7 + 2);
    pos.setXYZ(k, x * f, pos.getY(k), z * f);
  }
  g.computeVertexNormals();
  const bands = ['#c5627e', '#d99355', '#9c7ac4', '#c0708a', '#e0a870', '#8a64b0'].map((h) => new THREE.Color(h));
  return paint(g, (p, n, out) => {
    const b = Math.floor(p.y * 9 + 0.5 * Math.sin(Math.atan2(p.z, p.x) * 2));
    out.copy(bands[((b % bands.length) + bands.length) % bands.length]);
    if (n.y > 0.8) out.set('#3aa598');
  });
}

function hoodooGeometry(): THREE.BufferGeometry {
  // bulging stacked segments with a dark capstone (≈1 m wide, 4 m tall at unit scale)
  const parts: THREE.BufferGeometry[] = [];
  const segs = [
    [0, 0.55, 1.2],
    [1.0, 0.42, 1.0],
    [1.85, 0.36, 0.9],
    [2.65, 0.3, 0.8],
  ];
  for (const [y, rad, h] of segs) parts.push(new THREE.SphereGeometry(1, 9, 6).scale(rad, h * 0.62, rad).translate(0, y + h * 0.45, 0));
  parts.push(new THREE.CylinderGeometry(0.48, 0.4, 0.28, 9).translate(0.05, 3.55, 0));
  const g = tag(merge(parts), '#ffffff', 0);
  return paint(g, (p, _n, out) => {
    if (p.y > 3.38) {
      out.set('#3b2a4f');
      return;
    }
    const s = 0.5 + 0.5 * Math.sin(p.y * 7);
    out.set('#e7a77e').lerp(new THREE.Color('#b76e9a'), s);
  });
}

function islandGeometry(): THREE.BufferGeometry {
  // floating rock: a broad, lumpy mossy top over a cluster of jagged hanging spires,
  // with glowing roots trailing below
  const r = rng(5);
  const lumpy = (g: THREE.BufferGeometry, amt: number, keepTop: boolean) => {
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k);
      const y = p.getY(k);
      const z = p.getZ(k);
      const a = Math.atan2(z, x);
      const f = 1 + amt * (Math.sin(a * 3 + 0.7) * 0.5 + Math.sin(a * 7 + 2.1) * 0.3 + Math.sin(a * 13 + y * 4) * 0.2);
      if (keepTop && y > -0.01) p.setXYZ(k, x * (1 + amt * 0.5 * Math.sin(a * 3 + 0.7)), y, z * (1 + amt * 0.5 * Math.sin(a * 3 + 0.7)));
      else p.setXYZ(k, x * f, y, z * f);
    }
    g.computeVertexNormals();
    return g;
  };
  const top = lumpy(new THREE.SphereGeometry(1.15, 16, 5, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1, 0.3, 1), 0.25, false);
  const rock = (hex: string, lo: string) => (p: THREE.Vector3, _n: THREE.Vector3, out: THREE.Color) => {
    out.set(hex).lerp(new THREE.Color(lo), smooth(0, -1.8, p.y));
    if (Math.sin(p.y * 11) > 0.75) out.lerp(new THREE.Color('#d08aa6'), 0.45);
  };
  const parts: THREE.BufferGeometry[] = [tag(top, '#3fbfa6', 0)];
  const main = lumpy(new THREE.ConeGeometry(1.15, 1.7, 14, 5).rotateX(Math.PI).translate(0, -0.85, 0), 0.22, true);
  parts.push(paint(tag(main, '#ffffff', 0), rock('#8a6aa8', '#3a2552')));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + r() * 0.8;
    const rr = 0.45 + r() * 0.3;
    const h = 0.7 + r() * 0.9;
    const spire = new THREE.ConeGeometry(0.28 + r() * 0.2, h, 7, 2).rotateX(Math.PI).translate(Math.cos(a) * rr, -h / 2 - 0.05, Math.sin(a) * rr);
    parts.push(paint(tag(spire, '#ffffff', 0), rock('#7a5a9a', '#2e1d45')));
  }
  for (let k = 0; k < 9; k++) {
    const a = r() * Math.PI * 2;
    const rr = 0.25 + r() * 0.6;
    const len = 0.3 + r() * 0.9;
    const y0 = -0.25 - (1 - rr) * 0.9;
    parts.push(tag(new THREE.CylinderGeometry(0.01, 0.022, len, 4, 1, true).translate(Math.cos(a) * rr, y0 - len / 2, Math.sin(a) * rr), '#5cf5dc', 1));
    parts.push(tag(new THREE.SphereGeometry(0.03, 4, 3).translate(Math.cos(a) * rr, y0 - len, Math.sin(a) * rr), '#8ffff0', 1.5));
  }
  return mergeTagged(parts);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
export function buildAlien(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const r = rng(route.seed * 61 + 7);
  const density = opts.high ? 1 : 0.45;
  const baseY = L.minY - 6; // level of the far plain
  const out: THREE.Object3D[] = [buildSky()];

  // --- terrain: smooth undulating violet ground with turquoise moss, rising into
  // eroded swells away from the road and settling to the far plain
  const p0 = new THREE.Vector3();
  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    if (a < EDGE + 1) return -0.1;
    worldAt(route, i, off, 0, p0);
    const x = p0.x;
    const z = p0.z;
    const shoulder = -0.1 + smooth(EDGE + 1, 14, a) * 0.5;
    const swell = (fbm(x / 300, z / 300) - 0.35) * 110 + Math.pow(fbm(x / 110 + 5, z / 110), 2) * 34;
    const dunes = Math.sin(x * 0.045 + Math.sin(z * 0.02) * 2) * Math.sin(z * 0.038 + x * 0.01) * 4.0;
    const open = 0.3 + 0.7 * smooth(0.35, 0.65, fbm(x / 1100 + 3, z / 1100 - 2));
    const near = shoulder + (swell * open * smooth(10, 160, a) + dunes * smooth(8, 40, a)) * (1 - smooth(500, 760, a));
    const plain = baseY - route.y[i] + (fbm(x / 500, z / 500) - 0.4) * 30 * (1 - smooth(560, 760, a));
    return near + (plain - near) * smooth(220, 700, a);
  };
  const indigo = new THREE.Color('#3a2a88');
  const violet = new THREE.Color('#7342aa');
  const lavender = new THREE.Color('#a77fb8');
  const moss = new THREE.Color('#1fcab0');
  const mossDeep = new THREE.Color('#1e7f86');
  const verge = new THREE.Color('#2c2142');
  const { offs, roadCol } = mirroredColumns([EDGE, EDGE + 1, 7, 10, 14, 19, 26, 35, 47, 62, 80, 102, 130, 165, 210, 265, 335, 420, 520, 640, 780]);
  const mossAt = (x: number, z: number) => smooth(0.55, 0.66, fbm(x / 38 + 31, z / 38 - 7));
  const model: TerrainModel = {
    cols: offs.length,
    roadCol,
    colOff: (_i, c) => offs[c],
    height,
    color(i, off, dy, c) {
      const a = Math.abs(off);
      worldAt(route, i, off, 0, p0);
      const x = p0.x;
      const z = p0.z;
      const t = fbm(x / 90, z / 90);
      c.copy(indigo).lerp(violet, smooth(0.3, 0.7, t));
      const abs = route.y[i] + dy - baseY;
      c.lerp(lavender, smooth(25, 90, abs) * 0.65);
      const m = mossAt(x, z) * (1 - smooth(300, 600, a));
      c.lerp(moss, m * 0.7);
      c.lerp(mossDeep, smooth(0.6, 0.9, fbm(x / 25, z / 25)) * m * 0.5);
      c.multiplyScalar(0.9 + 0.2 * vnoise(x / 6, z / 6));
      if (a < EDGE + 1.05) c.copy(verge);
    },
  };
  model.map = detailTex(17, (g, rr) => {
    for (let k = 0; k < 2500; k++) {
      const v = 180 + rr() * 75;
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.beginPath();
      g.arc(rr() * 256, rr() * 256, 1 + rr() * 3, 0, Math.PI * 2);
      g.fill();
    }
    for (let k = 0; k < 40; k++) {
      g.strokeStyle = `rgba(150,150,150,${0.15 + rr() * 0.2})`;
      g.lineWidth = 1 + rr() * 2;
      g.beginPath();
      const x0 = rr() * 256;
      const y0 = rr() * 256;
      g.moveTo(x0, y0);
      g.bezierCurveTo(x0 + 30, y0 + 20 * rr(), x0 + 60 * rr(), y0 - 30, x0 + 90, y0 + 10);
      g.stroke();
    }
  });
  const terrain = buildTerrainMesh(route, model);
  terrain.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) (m.material as THREE.MeshLambertMaterial).color.setScalar(1.12);
  });
  out.push(terrain);
  // the far plain beyond the terrain ribbons
  const plain = new THREE.Mesh(new THREE.CircleGeometry(11000, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#3b2b72' }));
  plain.position.set(L.cx, baseY - 0.4, L.cz);
  plain.receiveShadow = true;
  out.push(plain);

  // --- road inlays
  out.push(glowRibbon(route));

  // --- shared helpers for placement
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const spot = (i: number, off0: number, sink = 0.15) => {
    const off = clampOff(route, i, off0);
    return { p: worldAt(route, i, off, height(i, off) - sink), off };
  };
  const yaw = () => q.setFromAxisAngle(up, r() * Math.PI * 2);
  const glowCols = ['#38f2e0', '#ff4fd8', '#7dff9a', '#5ab8ff', '#ffb347'].map((h) => new THREE.Color(h));
  const pickGlow = (w: number[]) => {
    let s = r() * w.reduce((a, b) => a + b, 0);
    for (let k = 0; k < w.length; k++) if ((s -= w[k]) <= 0) return glowCols[k];
    return glowCols[0];
  };

  // --- beacons along the road edge (staggered)
  const beacons: Inst[] = [];
  const every = Math.max(1, Math.round(28 / route.step));
  for (let i = 0, k = 0; i < n; i += every, k++) {
    const side = k % 2 ? 1 : -1;
    const p = worldAt(route, i, side * (ROAD_HALF + 1.3), height(i, side * (ROAD_HALF + 1.3)) - 0.05);
    beacons.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, route.heading[i]), new THREE.Vector3(1, 1, 1)), c: (k >> 1) % 3 === 2 ? glowCols[1] : glowCols[0] });
  }
  out.push(chunkedInstances(route, beaconGeometry(), glowMat({ k: 2.2, pulse: 0.35, flat: true }), beacons, { shadow: false }));

  // --- rock arches: a few span the road, more stand in the landscape
  const arches: Inst[] = [];
  const archLat = new THREE.Vector3();
  const archFwd = new THREE.Vector3();
  const spanEvery = Math.round(2300 / route.step);
  for (let i = Math.round(380 / route.step); i < n - 40; i += spanEvery + Math.floor(r() * 120)) {
    const h = route.heading[i];
    archLat.set(-Math.sin(h), 0, Math.cos(h));
    archFwd.set(-Math.cos(h), 0, -Math.sin(h));
    const s = 11 + r() * 2.5;
    const p = worldAt(route, i, 0, -1.6);
    const m = new THREE.Matrix4().makeBasis(archLat, up, archFwd);
    m.scale(new THREE.Vector3(s, s * (0.95 + r() * 0.2), s));
    m.setPosition(p);
    arches.push({ i, m, c: new THREE.Color().setHSL(0.85 + r() * 0.1, 0.25, 0.75 + r() * 0.15) });
  }
  for (let i = 0; i < n; i += 6) {
    if (r() > 0.075 * (opts.high ? 1 : 0.6)) continue;
    const side = r() < 0.5 ? -1 : 1;
    const { p } = spot(i, side * (45 + Math.pow(r(), 1.3) * 380), 2.5);
    const s = 9 + r() * 22;
    arches.push({ i, m: new THREE.Matrix4().compose(p, yaw(), new THREE.Vector3(s, s * (0.7 + r() * 0.5), s * (0.8 + r() * 0.6))), c: new THREE.Color().setHSL(0.82 + r() * 0.14, 0.3, 0.7 + r() * 0.2) });
  }
  out.push(chunkedInstances(route, archGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), arches, { shadow: true, receive: true }));

  // --- vegetation & crystals
  const mush: Inst[] = [];
  const pools: Inst[] = [];
  const tubes: Inst[][] = [[], [], []];
  const bulbs: Inst[] = [];
  const crystals: Inst[][] = [[], [], []];
  for (let i = 0; i < n; i += 2) {
    for (const side of [-1, 1]) {
      // giant mushroom trees, in loose groves
      const grove = 0.5 + 0.5 * Math.sin(i * 0.013 + side * 1.7) * Math.sin(i * 0.0071 + 0.5);
      if (r() < (0.05 + 0.13 * grove) * density) {
        const far = r() < 0.25;
        const { p, off } = spot(i, side * (far ? 60 + r() * 220 : EDGE + 7 + Math.pow(r(), 1.4) * 55), 0.3);
        jitterAlong(p, route, i, 10, r);
        const s = (far ? 1.2 + r() * 1.4 : 0.55 + r() * 0.85) * (r() < 0.06 ? 1.8 : 1);
        const col = pickGlow([3, 2.2, 1, 1.2, 0.5]);
        mush.push({ i, m: new THREE.Matrix4().compose(p, yaw(), new THREE.Vector3(s, s * (0.85 + r() * 0.35), s)), c: col });
        if (!far && Math.abs(off) < 70) {
          const pp = p.clone();
          pp.y += 0.35;
          const ps = s * 11;
          pools.push({ i, m: new THREE.Matrix4().compose(pp, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), new THREE.Vector3(ps, ps, 1)), c: col.clone().multiplyScalar(0.55) });
        }
      }
      // tube plant clusters
      if (r() < 0.24 * density) {
        const { p } = spot(i, side * (EDGE + 2 + Math.pow(r(), 1.8) * 70), 0.1);
        jitterAlong(p, route, i, 10, r);
        const s = 0.7 + r() * 0.8;
        tubes[Math.floor(r() * 3)].push({ i, m: new THREE.Matrix4().compose(p, yaw(), new THREE.Vector3(s, s * (0.8 + r() * 0.5), s)), c: pickGlow([2, 2, 1.5, 1, 1.2]) });
      }
      // glowing bulb fields close to the road
      if (r() < 0.12 * density) {
        const centre = EDGE + 2.5 + Math.pow(r(), 1.5) * 22;
        const col = pickGlow([2.5, 1.6, 1.6, 1, 0.8]);
        const rad = 2 + r() * 4;
        const cnt = Math.round((10 + r() * 22) * (opts.high ? 1 : 0.6));
        for (let b = 0; b < cnt; b++) {
          const ang = r() * Math.PI * 2;
          const d = Math.sqrt(r()) * rad;
          const off = side * Math.max(EDGE + 1.6, centre + Math.cos(ang) * d);
          const { p } = spot(i, off, 0.04);
          const along = Math.sin(ang) * d;
          p.x += Math.cos(route.heading[i]) * along;
          p.z += Math.sin(route.heading[i]) * along;
          const s = 0.6 + r() * 1.1;
          bulbs.push({ i, m: new THREE.Matrix4().compose(p, yaw(), new THREE.Vector3(s, s * (0.7 + r() * 0.7), s)), c: r() < 0.12 ? pickGlow([1, 1, 1, 1, 1]) : col });
        }
      }
      // crystal clusters jutting from the ground
      if (r() < 0.07 * density) {
        const big = r() < 0.25;
        const { p } = spot(i, side * (big ? 30 + r() * 260 : EDGE + 3 + Math.pow(r(), 1.6) * 40), 0.25);
        jitterAlong(p, route, i, 10, r);
        const s = big ? 3 + r() * 6 : 0.6 + r() * 1.3;
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, r() * 6.3, (r() - 0.5) * 0.4));
        crystals[Math.floor(r() * 3)].push({ i, m: new THREE.Matrix4().compose(p, tilt, new THREE.Vector3(s, s, s)), c: r() < 0.55 ? new THREE.Color('#34e8ff') : new THREE.Color('#ff3ad2') });
      }
    }
  }
  const mushMat = windy(glowMat({ k: 1.9, pulse: 0.25 }), 14, 0.12);
  out.push(chunkedInstances(route, mushroomGeometry(), mushMat, mush, { shadow: true }));
  const poolMat = new THREE.MeshBasicMaterial({ map: radialTex('rgba(255,255,255,0.55)', 'rgba(255,255,255,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4 });
  out.push(chunkedInstances(route, new THREE.PlaneGeometry(1, 1), poolMat, pools, { shadow: false }));
  const tubeMat = windy(glowMat({ k: 2.4, pulse: 0.4 }), 2.6, 0.28);
  tubes.forEach((list, k) => out.push(chunkedInstances(route, tubePlantGeometry(100 + k * 7), tubeMat, list, { shadow: opts.high })));
  const bulbMat = windy(glowMat({ k: 2.6, pulse: 0.5 }), 0.45, 0.05);
  out.push(chunkedInstances(route, bulbGeometry(), bulbMat, bulbs, { shadow: false, chunkM: 500 }));
  const crystalMat = glowMat({ k: 1.6, pulse: 0.2, flat: true });
  crystals.forEach((list, k) => out.push(chunkedInstances(route, crystalGeometry(400 + k * 13), crystalMat, list, { shadow: true })));

  // --- far horizon: mesas, hoodoos and floating rock islands
  const samples: [number, number][] = [];
  for (let i = 0; i < n; i += 10) samples.push([route.x[i], route.z[i]]);
  const distToRoute = (x: number, z: number) => {
    let d = Infinity;
    for (const [sx, sz] of samples) d = Math.min(d, (sx - x) ** 2 + (sz - z) ** 2);
    return Math.sqrt(d);
  };
  const nearestI = (x: number, z: number) => {
    let best = 0;
    let d = Infinity;
    for (let k = 0; k < samples.length; k++) {
      const dd = (samples[k][0] - x) ** 2 + (samples[k][1] - z) ** 2;
      if (dd < d) {
        d = dd;
        best = k * 10;
      }
    }
    return best;
  };
  let R = 0;
  for (let i = 0; i < n; i++) R = Math.max(R, Math.hypot(route.x[i] - L.cx, route.z[i] - L.cz));
  const mesas: Inst[] = [];
  const hoodoos: Inst[] = [];
  const islands: Inst[] = [];
  const place = (minD: number, maxD: number) => {
    for (let tries = 0; tries < 40; tries++) {
      const a = r() * Math.PI * 2;
      const rr = Math.sqrt(r()) * (R + maxD);
      const x = L.cx + Math.cos(a) * rr;
      const z = L.cz + Math.sin(a) * rr;
      const d = distToRoute(x, z);
      if (d > minD && d < maxD) return { x, z, d };
    }
    return null;
  };
  const nMesa = opts.high ? 70 : 40;
  for (let k = 0; k < nMesa; k++) {
    const s = place(1000, 3400);
    if (!s) continue;
    const w = 180 + r() * 320;
    const h = 200 + r() * 360;
    mesas.push({ i: nearestI(s.x, s.z), m: new THREE.Matrix4().compose(new THREE.Vector3(s.x, baseY - 4, s.z), yaw(), new THREE.Vector3(w, h, w * (0.6 + r() * 0.6))), c: new THREE.Color().setHSL(0.9 + r() * 0.15, 0.2, 0.75 + r() * 0.2) });
  }
  const nHood = opts.high ? 140 : 70;
  for (let k = 0; k < nHood; k++) {
    const s = place(850, 2600);
    if (!s) continue;
    const cluster = 1 + Math.floor(r() * 4);
    for (let c = 0; c < cluster; c++) {
      const sc = 14 + r() * 22;
      const x = s.x + (r() - 0.5) * 120;
      const z = s.z + (r() - 0.5) * 120;
      hoodoos.push({ i: nearestI(x, z), m: new THREE.Matrix4().compose(new THREE.Vector3(x, baseY - 1, z), yaw(), new THREE.Vector3(sc, sc * (0.8 + r() * 0.8), sc)), c: new THREE.Color().setHSL(r(), 0.15, 0.8 + r() * 0.2) });
    }
  }
  const nIsl = opts.high ? 34 : 18;
  for (let k = 0; k < nIsl; k++) {
    const s = place(300, 1800);
    if (!s) continue;
    const sc = 20 + r() * 70;
    const y = baseY + 150 + r() * 240 + sc * 0.8;
    islands.push({ i: nearestI(s.x, s.z), m: new THREE.Matrix4().compose(new THREE.Vector3(s.x, y, s.z), yaw(), new THREE.Vector3(sc, sc * (0.8 + r() * 0.5), sc)), c: new THREE.Color().setHSL(0.75 + r() * 0.2, 0.2, 0.85 + r() * 0.15) });
  }
  out.push(chunkedInstances(route, mesaGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), mesas, { shadow: false, chunkM: 3000 }));
  out.push(chunkedInstances(route, hoodooGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), hoodoos, { shadow: false, chunkM: 3000 }));
  out.push(chunkedInstances(route, islandGeometry(), glowMat({ k: 1.6, pulse: 0.3, bob: 0.06, flat: true }), islands, { shadow: false, chunkM: 3000 }));

  // --- spores drifting around the rider
  out.push(buildDustMotes({ count: opts.high ? 2200 : 700, box: 64, color: '#7dffd6', size: 2.0, opacity: 1.25 }));

  return out;
}
