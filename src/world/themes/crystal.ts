// Crystal Canyon: a deliberately faceted, low-poly gorge whose walls are made of
// colossal gemstone crystals. Hexagonal columns and pointed spikes of amethyst,
// aquamarine, rose quartz and citrine cluster along the dark obsidian walls, jut
// out over the road and here and there cross overhead in pointed arches. They glow
// from within (brighter towards the tips), with a fresnel rim, view-dependent
// "refraction" bands and bright sparkles running along the facet edges.
// Where crystals stand, soft additive light pools tint the floor and the road, with
// slowly moving caustics; a shallow teal stream winds along the canyon floor.
// The sky is a stylised dusk gradient (peach → lavender → deep blue) with a big
// soft sun and a few faceted clouds; glitter drifts in the air.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  ROAD_HALF,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clampOff,
  lapWave,
  lerp,
  loopInfo,
  rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { buildDustMotes, fxBuild, fxSurge, fxTime } from '../fx';
import { sunDirection } from '../sky';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export const CRYSTAL = {
  skyTop: '#16205a',
  skyHorizon: '#f2a7a6',
  haze: '#c995b4',
  sun: { elevation: 9, azimuth: 205 },
};

/** Gem hues (sRGB): amethyst, aquamarine, rose quartz, citrine. */
const GEMS = ['#9a5bff', '#2fe0d2', '#ff7fb8', '#ffb238'].map((h) => new THREE.Color(h));
const TEAL = new THREE.Color('#2fd9c8');

/** Shared GLSL: a cheap animated caustic network (bright thin lines, 0..1). */
const CAUSTIC = /* glsl */ `
float crCaustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 3; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 3.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.5);
}`;

const FOG_FACTOR = /* glsl */ `
float crFog(float depth) {
  #ifdef USE_FOG
    return smoothstep(fogNear, fogFar, depth);
  #else
    return 0.0;
  #endif
}`;

// ---------------------------------------------------------------------------
// Road: smooth pale stone with faint facet cracks
// ---------------------------------------------------------------------------
export function crystalRoad() {
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#6c667f';
    g.fillRect(0, 0, 256, 512);
    const r = rng(91);
    for (let i = 0; i < 7000; i++) {
      const v = 95 + r() * 45;
      g.fillStyle = `rgba(${v},${v - 6},${v + 16},0.5)`;
      g.fillRect(r() * 256, r() * 512, 1.5, 1.5);
    }
    // polished slabs: faint angular seams
    g.strokeStyle = 'rgba(70,60,95,0.22)';
    g.lineWidth = 1.2;
    for (let y = 0; y < 512; y += 64 + Math.floor(r() * 30)) {
      g.beginPath();
      g.moveTo(20, y);
      g.lineTo(128, y + (r() - 0.5) * 30);
      g.lineTo(236, y + (r() - 0.5) * 20);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (const x of [52, 84, 172, 204]) g.fillRect(x, 0, 18, 512);
    g.fillStyle = '#efe9ff';
    g.fillRect(9, 0, 6, 512);
    g.fillRect(241, 0, 6, 512);
    g.fillStyle = 'rgba(246,240,255,0.85)';
    g.fillRect(125, 0, 6, 180);
  });
}

// ---------------------------------------------------------------------------
// Crystal geometry: hexagonal prism + pyramid tip, non-indexed with "edge" barycentrics
// ---------------------------------------------------------------------------
/**
 * Unit crystal: radius 1 at the base, height 1 (base at y=0, tip at y=1).
 * `bary` gives distance-to-real-edge per triangle; a component >= 1 on all three
 * vertices marks an edge to ignore (the diagonal of a side quad).
 */
function crystalGeometry(tipH: number, topR: number, sides = 6): THREE.BufferGeometry {
  const pos: number[] = [];
  const bary: number[] = [];
  const bodyH = 1 - tipH;
  const ring = (y: number, rad: number, k: number) => {
    const a = (k / sides) * Math.PI * 2;
    return [Math.cos(a) * rad, y, Math.sin(a) * rad];
  };
  const tri = (a: number[], b: number[], c: number[], ba: number[], bb: number[], bc: number[]) => {
    pos.push(...a, ...b, ...c);
    bary.push(...ba, ...bb, ...bc);
  };
  for (let k = 0; k < sides; k++) {
    const a = ring(-0.05, 1, k);
    const b = ring(-0.05, 1, k + 1);
    const c = ring(bodyH, topR, k);
    const d = ring(bodyH, topR, k + 1);
    // quad a-b-d-c, diagonal b-c ignored (outward-facing winding: a, c, b / b, c, d)
    tri(a, c, b, [2, 0, 0], [1, 0, 1], [1, 1, 0]);
    tri(b, c, d, [1, 0, 1], [1, 1, 0], [2, 0, 0]);
    // tip facet
    tri(c, [0, 1, 0], d, [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('bary', new THREE.Float32BufferAttribute(bary, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function crystalMaterial(sunDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: sunDir.clone().normalize() },
        uSunCol: { value: new THREE.Color('#ffd2b0') },
        uSkyCol: { value: new THREE.Color('#b9a2ff') },
        fxTime: { value: 0 },
      },
    ]),
    vertexShader: /* glsl */ `
      attribute vec3 bary;
      varying vec3 vBary;
      varying vec3 vWorld;
      varying vec3 vCol;
      varying float vH;
      varying float vSeed;
      flat varying vec3 vN; // flat: one exact normal per facet (interpolation noise made the facet hash speckle)
      #include <fog_pars_vertex>
      void main() {
        vBary = bary;
        mat4 im = mat4(1.0);
        #ifdef USE_INSTANCING
          im = instanceMatrix;
        #endif
        vN = normalize(transpose(inverse(mat3(modelMatrix * im))) * normal); // per-face (geometry is non-indexed)
        vH = clamp(position.y, 0.0, 1.0);
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          vSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        #else
          vSeed = 0.37;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(0.6, 0.35, 1.0);
        #endif
        wp = modelMatrix * wp;
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunCol;
      uniform vec3 uSkyCol;
      uniform float fxTime, fxBuild, fxSurge;
      varying vec3 vBary;
      varying vec3 vWorld;
      varying vec3 vCol;
      varying float vH;
      varying float vSeed;
      flat varying vec3 vN; // flat: one exact normal per facet (interpolation noise made the facet hash speckle)
      #include <common>
      #include <fog_pars_fragment>
      float h13(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 3.0);
        float dist = length(cameraPosition - vWorld);

        // body: deep and saturated at the root, glowing towards the tip
        float h = vH;
        vec3 col = mix(vCol * 0.05, vCol * 0.6, pow(h, 1.4));
        col += vCol * vCol * 0.8 * smoothstep(0.6, 1.0, h); // hot inner glow near the tip

        // each facet a slightly different brightness, like a cut gem
        float facet = h13(floor(N * 5.0 + 0.137) + vSeed * 7.0); // offset keeps exact normal components off cell boundaries
        col *= 0.5 + 0.8 * facet;

        // fake internal refraction: bands that slide with view angle and time
        vec3 R = refract(-V, N, 0.66);
        float b = dot(R, normalize(vec3(0.35, 1.0, 0.2))) * 7.0 + h * 5.0 + vSeed * 6.283 + fxTime * 0.35;
        float band = smoothstep(0.88, 1.0, abs(sin(b))) + 0.5 * smoothstep(0.96, 1.0, abs(sin(b * 2.3 + 1.7)));
        col += mix(vCol, vec3(1.0), 0.25) * band * (0.15 + 0.45 * h);

        // light: translucent diffuse, back-lighting towards the sun, a sharp glint
        float sunN = max(dot(N, uSunDir), 0.0);
        col += vCol * uSunCol * sunN * 0.28;
        float back = pow(max(dot(-V, uSunDir), 0.0), 5.0);
        col += vCol * uSunCol * back * (0.35 + 0.9 * h);
        vec3 H = normalize(V + uSunDir);
        float spec = pow(max(dot(N, H), 0.0), 90.0);
        col += uSunCol * spec * 2.2;
        // sky reflection on the facets facing up
        col += uSkyCol * 0.10 * max(N.y, 0.0) * (0.4 + fres);

        // fresnel rim
        col += mix(vCol, vec3(1.0), 0.3) * fres * 0.6;

        // facet edges: crisp bright lines with sparkles running along them
        float e = min(min(vBary.x, vBary.y), vBary.z);
        col *= mix(1.25, 0.8, smoothstep(0.0, 0.3, e)); // glassy: faces darker in the middle, brighter at the edges
        float fw = fwidth(e);
        float line = 1.0 - smoothstep(fw * 0.6, fw * 1.8, e);
        float glow = 1.0 - smoothstep(0.0, 0.07, e);
        float tw = pow(0.5 + 0.5 * sin(dot(vWorld, vec3(0.55, 1.1, 0.8)) * 1.3 - fxTime * 2.2 + vSeed * 40.0), 10.0);
        float far = smoothstep(260.0, 60.0, dist); // thin lines alias far away: fade
        col += mix(vec3(1.0), vCol, 0.35) * (line * (0.25 + 2.2 * tw) * mix(0.3, 1.0, far) + glow * 0.12);

        // facet glints: random facets flash as the view moves
        float g = h13(floor(N * 9.0 + 0.371) + floor(vWorld * 0.12 + 0.29));
        float flash = pow(0.5 + 0.5 * sin(dot(cameraPosition, vec3(0.21, 0.17, 0.23)) + fxTime * 0.9 + g * 60.0), 30.0); // whole facets flash as you ride past
        col += mix(vCol, vec3(1.0), 0.6) * flash * step(0.8, g) * 0.9 * far;

        // the crystals charge up as a hard effort builds and flare on a sprint
        float charge = fxBuild + 0.8 * fxSurge;
        col *= 1.0 + 0.25 * charge;
        col += vCol * (glow * 0.35 + line * 0.6) * charge; // edges light up in the gem's own colour

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------
// Sky: dusk gradient dome with a big soft sun
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
    uniforms: {
      fxTime,
      uSunDir: { value: sunDir.clone().normalize() },
      uHaze: { value: C(CRYSTAL.haze) },
      uPeach: { value: C('#ffb894') },
      uPink: { value: C('#f39bb6') },
      uLav: { value: C('#a98ade') },
      uBlue: { value: C('#3d3f9e') },
      uTop: { value: C(CRYSTAL.skyTop) },
      uSun: { value: C('#fff1d8').multiplyScalar(3.2) },
      uGlow: { value: C('#ffc28e') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform vec3 uSunDir, uHaze, uPeach, uPink, uLav, uBlue, uTop, uSun, uGlow;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        float sunward = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
        vec3 col = mix(uHaze, uPeach, smoothstep(-0.03, 0.02, y));
        col = mix(col, uPink, smoothstep(0.03, 0.12 + 0.06 * sunward, y));
        col = mix(col, uLav, smoothstep(0.1, 0.3 + 0.08 * sunward, y));
        col = mix(col, uBlue, smoothstep(0.28, 0.62, y));
        col = mix(col, uTop, smoothstep(0.6, 1.0, y));
        // warm glow around the sun
        float cosA = dot(d, uSunDir);
        float a = acos(clamp(cosA, -1.0, 1.0));
        col += uGlow * (exp(-a * 3.2) * 0.55 + exp(-a * 12.0) * 0.6);
        // big soft sun disc
        float disc = 1.0 - smoothstep(0.055, 0.075, a);
        col = mix(col, uSun, disc);
        // faint early stars high up
        vec3 sp = d * 220.0;
        vec3 cell = floor(sp);
        float h = hash(cell);
        if (h > 0.965) {
          vec3 at = vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) * 0.6 + 0.2;
          float r = length(fract(sp) - at);
          float tw = 0.6 + 0.4 * sin(fxTime * (1.0 + h * 20.0) + h * 300.0);
          col += vec3(0.9, 0.88, 1.0) * smoothstep(0.14, 0.0, r) * tw * smoothstep(0.45, 0.85, y) * 0.9;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(6500, 48, 24), mat);
  m.renderOrder = -9;
  stickToCamera(m);
  return m;
}

/** A ring of faceted low-poly clouds, very far away (follows the camera). */
function buildClouds(sunDir: THREE.Vector3, r: () => number): THREE.Mesh {
  const geos: THREE.BufferGeometry[] = [];
  const count = 16;
  for (let k = 0; k < count; k++) {
    const az = (k / count) * Math.PI * 2 + r() * 0.3;
    const el = THREE.MathUtils.degToRad(3.5 + r() * 13);
    const D = 4200 + r() * 900;
    const c = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(D);
    const w = 160 + r() * 260;
    const puffs = 3 + Math.floor(r() * 4);
    for (let p = 0; p < puffs; p++) {
      const s = w * (0.35 + r() * 0.4);
      const g = new THREE.IcosahedronGeometry(1, 0);
      g.scale(s * (1.2 + r() * 0.6), s * (0.45 + r() * 0.25), s * (0.9 + r() * 0.5));
      g.rotateY(r() * 6.3);
      g.translate(c.x + (p - puffs / 2) * w * 0.55 * -Math.sin(az), c.y + r() * s * 0.25, c.z + (p - puffs / 2) * w * 0.55 * Math.cos(az));
      g.deleteAttribute('uv');
      g.deleteAttribute('normal');
      geos.push(g);
    }
  }
  const pos: number[] = [];
  for (const g of geos) pos.push(...(g.getAttribute('position').array as Float32Array));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uSunDir: { value: sunDir.clone().normalize() },
      uShade: { value: new THREE.Color('#8f78c9') },
      uLit: { value: new THREE.Color('#ffc9ad') },
      uRim: { value: new THREE.Color('#fff0dc') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vRel;
      void main() {
        vRel = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uShade, uLit, uRim;
      varying vec3 vRel;
      void main() {
        vec3 N = normalize(cross(dFdx(vRel), dFdy(vRel)));
        vec3 V = normalize(-vRel);
        if (dot(N, V) < 0.0) N = -N;
        float l = clamp(dot(N, uSunDir) * 0.6 + 0.45, 0.0, 1.0);
        vec3 col = mix(uShade, uLit, l);
        float toward = pow(max(dot(normalize(vRel), uSunDir), 0.0), 8.0);
        col += uRim * toward * 0.8 * (1.0 - abs(dot(N, V)));
        col *= mix(0.9, 1.1, max(N.y, 0.0));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
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
// Light pools (additive, conforming to the ground) with moving caustics
// ---------------------------------------------------------------------------
interface Pool {
  i: number;
  off: number;
  rad: number;
  c: THREE.Color;
  k: number; // intensity
}

function poolMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { fxTime: { value: 0 } }]),
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float strength;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vCol = color * strength;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      varying vec2 vUv;
      varying vec3 vCol;
      varying vec3 vWorld;
      #include <common>
      #include <fog_pars_fragment>
      ${FOG_FACTOR}
      ${CAUSTIC}
      void main() {
        float r = length(vUv);
        float fall = pow(clamp(1.0 - r, 0.0, 1.0), 1.4);
        float c = crCaustic(vWorld.xz * 0.22, fxTime * 0.35 + 23.0);
        vec3 col = vCol * fall * (0.55 + 1.1 * c);
        col *= 1.0 - crFog(vFogDepth);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function buildPools(route: Route, pools: Pool[], ground: (i: number, off: number) => number): THREE.Group {
  const n = route.x.length;
  const g = new THREE.Group();
  const mat = poolMaterial();
  mat.uniforms.fxTime = fxTime;
  const per = Math.round(800 / route.step);
  const buckets = new Map<number, Pool[]>();
  for (const p of pools) {
    const k = Math.floor(p.i / per);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const v = new THREE.Vector3();
  for (const b of buckets.values()) {
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const str: number[] = [];
    const idx: number[] = [];
    for (const p of b) {
      const G = p.rad > 6 ? 7 : 3; // grid resolution
      const base = pos.length / 3;
      const ds = Math.max(1, Math.round(p.rad / route.step));
      for (let a = 0; a < G; a++) {
        const u = (a / (G - 1)) * 2 - 1;
        const i = (((p.i + Math.round(u * ds)) % n) + n) % n;
        const ua = (Math.round(u * ds) * route.step) / p.rad;
        for (let c = 0; c < G; c++) {
          const w = (c / (G - 1)) * 2 - 1;
          const off = p.off + w * p.rad;
          const onRoad = Math.abs(off) < ROAD_HALF + 0.2;
          const dy = onRoad ? 0.08 : ground(i, off) + 0.12;
          worldAt(route, i, off, dy, v);
          pos.push(v.x, v.y, v.z);
          uv.push(ua, w);
          col.push(p.c.r, p.c.g, p.c.b);
          str.push(p.k);
        }
      }
      for (let a = 0; a < G - 1; a++)
        for (let c = 0; c < G - 1; c++) {
          const q = base + a * G + c;
          idx.push(q, q + 1, q + G, q + 1, q + G + 1, q + G);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('strength', new THREE.Float32BufferAttribute(str, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 2;
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
interface WallProfile {
  W: number; // road → foot of the wall
  talus: number;
  low: number; // top of the lower wall
  ledge: number;
  top: number; // rim
}

export function buildCrystal(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const r = rng(route.seed * 71 + 13);
  const out: THREE.Object3D[] = [];
  const sunDir = sunDirection(CRYSTAL.sun.elevation, CRYSTAL.sun.azimuth);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);
  const streamSide = -L.inward;
  const streamOff = (i: number) => 15 + 4 * lapWave(route, i, 0.9, 1.3);
  const SH = 2.6; // stream half width

  // ----- gem zones: each wall has a dominant gem that changes every few hundred metres
  const zoneLen = Math.round(260 / route.step);
  const zones = [0, 1].map((s) => {
    const zr = rng(route.seed * 13 + s * 101);
    const list: number[] = [];
    let last = -1;
    for (let k = 0; k <= Math.ceil(n / zoneLen); k++) {
      let gsel = Math.floor(zr() * 4);
      if (gsel === last) gsel = (gsel + 1 + Math.floor(zr() * 3)) % 4;
      list.push((last = gsel));
    }
    return list;
  });
  /** Dominant gem colour at sample i on a side, blended smoothly between zones. */
  const zoneColor = (i: number, side: number, outC: THREE.Color) => {
    const list = zones[side > 0 ? 1 : 0];
    const f = i / zoneLen;
    const k = Math.floor(f);
    const t = smooth(0.7, 1.0, f - k);
    return outC.copy(GEMS[list[k % list.length]]).lerp(GEMS[list[(k + 1) % list.length]], t);
  };
  const zoneGem = (i: number, side: number) => zones[side > 0 ? 1 : 0][Math.floor(i / zoneLen) % zones[0].length];

  // ----- wall profile
  const prof = (i: number, side: number): WallProfile => {
    const s = side > 0 ? 0 : 2.7;
    const W = 30 + 42 * Math.pow(w01(i, 0.5, 0.4 + s), 1.4) + 14 * w01(i, 1.9, 1.7 + s);
    const low = 30 + 35 * w01(i, 0.8, 2.3 + s);
    return {
      W,
      talus: 7 + 7 * w01(i, 2.3, s),
      low,
      ledge: 8 + 26 * w01(i, 0.6, 3.9 + s),
      top: low + 60 + 110 * w01(i, 0.42, 0.9 + s) + 30 * w01(i, 2.1, 4.4 + s),
    };
  };
  const cache = new Map<number, [WallProfile, WallProfile]>();
  const P = (i: number, side: number) => {
    let v = cache.get(i);
    if (!v) cache.set(i, (v = [prof(i, -1), prof(i, 1)]));
    return side < 0 ? v[0] : v[1];
  };

  /** Deterministic facet noise -1..1 on a lattice of (row, lateral metres). */
  const fnoise = (i: number, off: number, cell: number) => {
    const a = Math.round(i / 3);
    const b = Math.round(off / cell);
    const h = Math.sin(a * 127.1 + b * 311.7 + route.seed * 17.3) * 43758.5453;
    return (h - Math.floor(h)) * 2 - 1;
  };

  const floorH = (i: number, off: number) => {
    const a = Math.abs(off);
    if (a < EDGE + 0.8) return -0.12;
    let dy = -0.12 + smooth(EDGE + 0.8, 14, a) * 0.35 + (Math.sin(i * 0.07 + off * 0.13) * 0.8 + fnoise(i, off, 5) * 0.45) * smooth(10, 24, a);
    dy += Math.max(0, a - 18) * 0.04;
    if (Math.sign(off) === streamSide) {
      const d = Math.abs(a - streamOff(i));
      dy -= 1.1 * (1 - smooth(SH - 0.5, SH + 2.5, d));
    }
    return dy;
  };

  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    const side = Math.sign(off) || 1;
    const pr = P(i, side);
    const t0 = pr.W - 14;
    if (a < t0) return floorH(i, off);
    const base = floorH(i, side * t0);
    const nz = (amp: number, cell: number) => fnoise(i, off, cell) * amp;
    if (a < pr.W) return base + pr.talus * Math.pow((a - t0) / 14, 1.5) + nz(0.8, 3);
    const foot = base + pr.talus;
    if (a < pr.W + 5) return lerp(foot, pr.low, (a - pr.W) / 5) + nz(3, 2);
    const le = pr.W + 5 + pr.ledge;
    if (a < le) return pr.low + ((a - pr.W - 5) / pr.ledge) * 7 + nz(1.5, 4);
    if (a < le + 7) return lerp(pr.low + 7, pr.top, (a - le) / 7) + nz(5, 2);
    const u = a - le - 7;
    return pr.top + smooth(0, 40, u) * (14 + 30 * w01(i, 2.7, side)) + Math.sin(i * 0.05 + u * 0.04) * 16 * smooth(25, 90, u) + nz(4, 12);
  };

  // columns per side
  const sideCols = (i: number, side: number): number[] => {
    const pr = P(i, side);
    const t0 = pr.W - 14;
    const cols = [EDGE, EDGE + 0.8, 7.5, 10];
    if (side === streamSide) {
      const so = streamOff(i);
      cols.push(so - SH - 2.5, so - SH - 0.3, so, so + SH + 0.3, so + SH + 2.5);
      const last = so + SH + 2.5;
      for (let k = 1; k <= 3; k++) cols.push(lerp(last, t0, k / 4));
    } else for (let k = 1; k <= 8; k++) cols.push(lerp(10, t0, k / 9));
    const le = pr.W + 5 + pr.ledge;
    const j = (x: number, amt: number) => x + fnoise(i + 7, x, 1) * amt;
    cols.push(t0, j(t0 + 7, 2), pr.W, j(pr.W + 2.5, 0.8), pr.W + 5, j(pr.W + 5 + pr.ledge * 0.5, pr.ledge * 0.2), le, j(le + 3.5, 1), le + 7, le + 22, le + 55, le + 120, le + 240, le + 420);
    return cols;
  };
  const PER = 4 + 8 + 14;
  const colCache = new Map<number, [number[], number[]]>();
  const colOff = (i: number, c: number) => {
    let v = colCache.get(i);
    if (!v) colCache.set(i, (v = [sideCols(i, -1), sideCols(i, 1)]));
    return c < PER ? -v[0][PER - 1 - c] : v[1][c - PER];
  };

  const obsidian = new THREE.Color('#3b3350');
  const obsidian2 = new THREE.Color('#4d4166');
  const slate = new THREE.Color('#6a5a86');
  const slateHi = new THREE.Color('#8f7aae');
  const rim = new THREE.Color('#a08cbc');
  const bed = new THREE.Color('#1c8a8a');
  const verge = new THREE.Color('#5a5070');
  const tint = new THREE.Color();
  const model: TerrainModel = {
    cols: PER * 2,
    roadCol: PER - 1,
    colOff,
    height,
    flatShading: true,
    color(i, off, dy, o) {
      const a = Math.abs(off);
      const side = Math.sign(off) || 1;
      const pr = P(i, side);
      const fine = fnoise(i, off, 2.5);
      if (a < pr.W - 14) {
        o.copy(obsidian).lerp(obsidian2, 0.5 + 0.5 * Math.sin(i * 0.031 + off * 0.09));
        o.multiplyScalar(0.9 + 0.15 * fine);
        if (side === streamSide) {
          const d = Math.abs(a - streamOff(i));
          if (d < SH + 0.4) o.copy(bed);
          else o.lerp(TEAL, (1 - smooth(SH, SH + 6, d)) * 0.25);
        }
        if (a < EDGE + 0.8) o.copy(verge);
      } else {
        const hgt = dy / Math.max(1, pr.top);
        o.copy(slate).lerp(slateHi, smooth(0.1, 0.9, hgt));
        if (a > pr.W + 5 + pr.ledge + 7) o.copy(rim);
        o.multiplyScalar(0.85 + 0.25 * fine);
      }
      // crystal light spill: walls and floor near them pick up the zone's gem colour
      zoneColor(i, side, tint);
      const near = smooth(8, pr.W - 4, a) * (1 - smooth(pr.W + 30, pr.W + 140, a));
      o.lerp(tint, 0.28 * near);
    },
    uv(i, off, _dy, _x, _z, o) {
      // u: caustic mask (canyon floor and stream bed only)
      const a = Math.abs(off);
      const pr = P(i, Math.sign(off) || 1);
      let m = 1 - smooth(pr.W - 18, pr.W - 8, a);
      if (Math.sign(off) === streamSide && Math.abs(a - streamOff(i)) < SH + 0.4) m = 2.2;
      o[0] = m;
      o[1] = 0;
    },
  };
  const terrain = buildTerrainMesh(route, model, 3);
  // caustics on the canyon floor (emissive, mask in uv.x)
  const tmat = (terrain.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial;
  tmat.onBeforeCompile = (shader) => {
    shader.uniforms.fxTime = fxTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCrW;\nvarying float vCrMask;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCrW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvCrMask = uv.x;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float fxTime;\nvarying vec3 vCrW;\nvarying float vCrMask;\n${CAUSTIC}`)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          float dist = length(cameraPosition - vCrW);
          float fade = 1.0 - smoothstep(70.0, 220.0, dist);
          if (vCrMask > 0.01 && fade > 0.0) {
            float c = crCaustic(vCrW.xz * 0.16, fxTime * 0.3);
            float hue = 0.5 + 0.5 * sin(vCrW.x * 0.013 + vCrW.z * 0.017);
            vec3 tintC = mix(vec3(0.15, 0.85, 0.8), vec3(0.6, 0.35, 1.0), hue);
            totalEmissiveRadiance += tintC * c * 0.16 * vCrMask * fade + tintC * 0.012 * vCrMask;
          }
        }`,
      );
  };
  tmat.customProgramCacheKey = () => 'crystal-terrain';
  out.push(terrain);

  // ----- stream surface: crystal-clear teal water
  {
    const rows = Math.ceil(n / 2) + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    for (let k = 0; k < rows; k++) {
      const i = (k * 2) % n;
      const so = streamOff(i);
      for (let s = 0; s < 2; s++) {
        const a = so + (s === 0 ? -SH - 0.6 : SH + 0.6);
        worldAt(route, i, streamSide * a, floorH(i, streamSide * (so + SH + 2.5)) - 0.45, p);
        pos.set([p.x, p.y, p.z], (k * 2 + s) * 3);
        uv[(k * 2 + s) * 2] = s;
        uv[(k * 2 + s) * 2 + 1] = k * 2 * route.step;
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
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          fxTime: { value: 0 },
          uSunDir: { value: sunDir.clone() },
          uWater: { value: new THREE.Color('#29d3c3') },
          uSky: { value: new THREE.Color('#d8b4ff') },
          uPeach: { value: new THREE.Color('#ffc7a6') },
        },
      ]),
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float fxTime;
        uniform vec3 uSunDir, uWater, uSky, uPeach;
        varying vec2 vUv;
        varying vec3 vWorld;
        #include <common>
        #include <fog_pars_fragment>
        ${CAUSTIC}
        void main() {
          vec3 V = normalize(cameraPosition - vWorld);
          // faceted ripples: quantised normal perturbation flowing downstream
          vec2 q = vec2(vUv.x * 3.0, vUv.y * 0.6 - fxTime * 0.9);
          vec2 cell = floor(q);
          float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
          vec3 N = normalize(vec3((h - 0.5) * 0.2, 1.0, (fract(h * 17.0) - 0.5) * 0.2));
          float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          vec3 col = uWater * 0.45;
          col = mix(col, mix(uSky, uPeach, 0.5 + 0.5 * V.y) * 0.6, fres * 0.45);
          float c = crCaustic(vWorld.xz * 0.35, fxTime * 0.5);
          col += uWater * c * 0.35;
          float spec = pow(max(dot(reflect(-V, N), uSunDir), 0.0), 120.0);
          col += vec3(1.0, 0.9, 0.8) * spec * 3.0;
          float a = mix(0.3, 0.7, fres) * edge;
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    mat.uniforms.fxTime = fxTime;
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1;
    out.push(m);
  }

  // ----- crystals
  const crysMat = crystalMaterial(sunDir);
  crysMat.uniforms.fxTime = fxTime;
  crysMat.uniforms.fxBuild = fxBuild;
  crysMat.uniforms.fxSurge = fxSurge;
  const columnGeo = crystalGeometry(0.16, 0.92);
  const spikeGeo = crystalGeometry(0.42, 0.78);
  const columns: Inst[] = [];
  const spikes: Inst[] = [];
  const smallCols: Inst[] = [];
  const smallSpikes: Inst[] = [];
  const pools: Pool[] = [];
  const density = opts.high ? 1 : 0.55;
  const Y = new THREE.Vector3(0, 1, 0);
  const lat = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const qs = new THREE.Quaternion();
  const gemColor = (i: number, side: number) => {
    const g = r() < 0.72 ? zoneGem(i, side) : Math.floor(r() * 4);
    const c = GEMS[g].clone();
    c.offsetHSL((r() - 0.5) * 0.04, 0, (r() - 0.5) * 0.08);
    return c;
  };
  /**
   * Crystal at route sample i, rooted at `base`, axis tilted `tilt` rad from vertical,
   * leaning towards lateral direction `lean` (+1 = +off) with along-road swing `swing`.
   */
  const crystal = (list: Inst[], i: number, base: THREE.Vector3, rad: number, len: number, tilt: number, lean: number, swing: number, c: THREE.Color) => {
    const h = route.heading[i];
    lat.set(-Math.sin(h), 0, Math.cos(h));
    fwd.set(Math.cos(h), 0, Math.sin(h));
    dir
      .copy(Y)
      .multiplyScalar(Math.cos(tilt))
      .addScaledVector(lat, lean * Math.sin(tilt) * Math.cos(swing))
      .addScaledVector(fwd, Math.sin(tilt) * Math.sin(swing))
      .normalize();
    q.setFromUnitVectors(Y, dir);
    qs.setFromAxisAngle(Y, r() * Math.PI * 2);
    q.multiply(qs);
    const p = base.clone().addScaledVector(dir, -len * 0.06);
    list.push({ i, m: new THREE.Matrix4().compose(p, q, new THREE.Vector3(rad, len, rad)), c });
  };
  const ground = (i: number, off: number) => height(i, off);
  const spot = (i: number, off0: number, sink = 0) => {
    const off = clampOff(route, i, off0);
    return { off, p: worldAt(route, i, off, height(i, off) - sink) };
  };

  for (let i = 0; i < n; i += 2) {
    for (const side of [-1, 1]) {
      const pr = P(i, side);
      // wall-foot clusters: the hero crystals forming the canyon walls
      if (i % 6 === 0 && r() < 0.85 * density + 0.15) {
        const c0 = gemColor(i, side);
        const k = 2 + Math.floor(r() * 4);
        const anchor = pr.W - 6 + r() * 10;
        for (let m = 0; m < k; m++) {
          const ii = (i + Math.floor((r() - 0.5) * 6) + n) % n;
          const { p } = spot(ii, side * (anchor + (r() - 0.3) * 10), 0.5);
          const big = r();
          const rad = 2 + big * big * 8;
          const len = rad * (3.5 + r() * 4);
          const c = r() < 0.75 ? c0.clone().offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.1) : gemColor(ii, side);
          crystal(r() < 0.6 ? columns : spikes, ii, p, rad, len, 0.08 + r() * 0.5, -side, (r() - 0.5) * 1.6, c);
        }
        if (anchor < 60) pools.push({ i, off: side * Math.max(ROAD_HALF + 1, Math.min(anchor - 18, 14)), rad: 15 + r() * 8, c: c0, k: 1.1 });
      }
      // crystals erupting from the wall faces (lower and upper wall), pointing out and up
      if (i % 4 === 0 && r() < 0.6 * density) {
        const upper = r() < 0.45;
        const le = pr.W + 5 + pr.ledge;
        const a = upper ? le + 2 + r() * 6 : pr.W + 1 + r() * 4;
        const { off, p } = spot(i, side * a, 0);
        if (Math.abs(off) < a - 1) continue;
        p.y = route.y[i] + (upper ? lerp(pr.low + 10, pr.top - 8, r()) : lerp(pr.talus + 4, pr.low - 4, r()));
        const rad = 2 + r() * (upper ? 9 : 6);
        crystal(r() < 0.5 ? columns : spikes, i, p, rad, rad * (3 + r() * 4), 0.6 + r() * 0.7, -side, (r() - 0.5) * 1.2, gemColor(i, side));
      }
      // giant skyline crystals on the rim
      if (i % 8 === 0 && r() < 0.5 * density) {
        const le = pr.W + 5 + pr.ledge + 7;
        const want = le + 5 + r() * 60;
        const { off, p } = spot(i, side * want, 2);
        if (Math.abs(off) < want - 1) continue;
        const rad = 6 + r() * 12;
        crystal(r() < 0.5 ? columns : spikes, i, p, rad, rad * (3 + r() * 3.5), r() * 0.45, -side, (r() - 0.5) * 2, gemColor(i, side));
      }
      // mid-size spires dotted across the wider parts of the canyon floor
      if (r() < 0.1 * density && pr.W > 40) {
        const a = 14 + r() * (pr.W - 30);
        if (!(side === streamSide && Math.abs(a - streamOff(i)) < SH + 2.5)) {
          const { off, p } = spot(i, side * a, 0.3);
          const c = gemColor(i, side);
          const k = 1 + Math.floor(r() * 3);
          for (let m = 0; m < k; m++) {
            const pp = p.clone();
            pp.x += (r() - 0.5) * 3;
            pp.z += (r() - 0.5) * 3;
            const rad = 0.6 + r() * 1.6;
            crystal(r() < 0.5 ? spikes : columns, i, pp, rad, rad * (3 + r() * 4), r() * 0.5, r() < 0.5 ? -1 : 1, r() * 6.3, c);
          }
          pools.push({ i, off, rad: 7 + r() * 3, c, k: 0.7 });
        }
      }
      // scattered floor shards and geode clusters near the road
      if (r() < 0.38 * density) {
        const lim = pr.W - 14;
        const a = 6.5 + r() * Math.max(2, lim - 8);
        if (!(side === streamSide && Math.abs(a - streamOff(i)) < SH + 1.2)) {
          const { off, p } = spot(i, side * a, 0.1);
          const c = gemColor(i, side);
          const geode = r() < 0.4;
          const k = geode ? 5 + Math.floor(r() * 5) : 1 + Math.floor(r() * 3);
          const s = geode ? 0.25 + r() * 0.35 : 0.2 + r() * 0.6;
          for (let m = 0; m < k; m++) {
            const pp = p.clone();
            pp.x += (r() - 0.5) * s * 2;
            pp.z += (r() - 0.5) * s * 2;
            const rad = s * (0.4 + r() * 0.8);
            crystal(r() < 0.5 ? smallCols : smallSpikes, i, pp, rad, rad * (2.5 + r() * 4), geode ? 0.3 + r() * 0.9 : r() * 0.6, r() < 0.5 ? -1 : 1, r() * 6.3, c);
          }
          if (Math.abs(off) < 30) pools.push({ i, off, rad: geode ? 4.5 : 3, c, k: geode ? 0.55 : 0.35 });
        }
      }
    }
  }

  // overhangs and arches: crystals leaning right across the road
  const archEvery = Math.round(330 / route.step);
  for (let i = Math.round(120 / route.step); i < n - archEvery / 2; i += archEvery + Math.floor(r() * 30)) {
    const arch = r() < 0.45;
    const sides = arch ? [-1, 1] : [r() < 0.5 ? -1 : 1];
    for (const side of sides) {
      let baseOff = 13 + r() * 4;
      if (side === streamSide && Math.abs(baseOff - streamOff(i)) < SH + 3) baseOff = streamOff(i) + SH + 3.5; // root beyond the stream
      const { off, p } = spot(i, side * baseOff, 0.8);
      const tilt = arch ? 0.9 + r() * 0.08 : 0.8 + r() * 0.12;
      const reach = Math.abs(off) + (arch ? 2 : 4 + r() * 6);
      const len = reach / Math.sin(tilt);
      const rad = 2.2 + r() * 2;
      const c = gemColor(i, side);
      crystal(arch || r() < 0.5 ? spikes : columns, i, p, rad, len, tilt, -side, (r() - 0.5) * 0.25, c);
      // a cluster of companions around the root
      for (let m = 0; m < 4; m++) {
        const ii = (i + Math.floor((r() - 0.5) * 4) + n) % n;
        const { p: pp } = spot(ii, side * (baseOff + r() * 6), 0.4);
        const rr = 1 + r() * 2.5;
        crystal(r() < 0.5 ? spikes : columns, ii, pp, rr, rr * (3 + r() * 3), 0.2 + r() * 0.6, -side, (r() - 0.5) * 2, c.clone().offsetHSL(0, 0, (r() - 0.5) * 0.1));
      }
      pools.push({ i, off: side * (ROAD_HALF + 3), rad: 15, c, k: 0.65 });
    }
  }

  // road-edge crystal markers (instead of posts), each with a small pool of light
  const markerEvery = Math.max(1, Math.round(20 / route.step));
  const markers: Inst[] = [];
  for (let i = 0; i < n; i += markerEvery) {
    for (const side of [-1, 1]) {
      const off = side * (ROAD_HALF + 0.75);
      const p = worldAt(route, i, off, floorH(i, off) - 0.05);
      const c = GEMS[zoneGem(i, side)].clone();
      crystal(markers, i, p, 0.16 + r() * 0.06, 0.8 + r() * 0.35, 0.12 + r() * 0.12, -side, (r() - 0.5) * 1.2, c);
      // a little companion shard
      const p2 = p.clone();
      p2.x += (r() - 0.5) * 0.4;
      p2.z += (r() - 0.5) * 0.4;
      crystal(markers, i, p2, 0.09, 0.4 + r() * 0.2, 0.35 + r() * 0.3, side, r() * 6.3, c);
      pools.push({ i, off: side * (ROAD_HALF + 0.3), rad: 2.6, c, k: 0.6 });
    }
  }

  const glowing = (g: THREE.Group) => {
    // self-lit glass: keep it out of the AO pass (its noise speckles the big flat facets)
    g.traverse((o) => (o.userData.noAO = true));
    return g;
  };
  out.push(glowing(chunkedInstances(route, columnGeo, crysMat, columns, { shadow: false })));
  out.push(glowing(chunkedInstances(route, spikeGeo, crysMat, spikes, { shadow: false })));
  out.push(glowing(chunkedInstances(route, columnGeo, crysMat, smallCols, { shadow: false })));
  out.push(glowing(chunkedInstances(route, spikeGeo, crysMat, smallSpikes, { shadow: false })));
  out.push(glowing(chunkedInstances(route, spikeGeo, crysMat, markers, { shadow: false })));

  // dark geode rocks / boulders on the floor (faceted)
  const rocks: Inst[] = [];
  for (let i = 0; i < n; i += 3) {
    for (const side of [-1, 1]) {
      if (r() > 0.18 * density) continue;
      const pr = P(i, side);
      const a = r() < 0.6 ? pr.W - 14 + r() * 14 : 7 + r() * (pr.W - 20);
      if (side === streamSide && Math.abs(a - streamOff(i)) < SH + 1) continue;
      const { p } = spot(i, side * a, 0.3);
      const s = 0.4 + Math.pow(r(), 2) * 3.5;
      rocks.push({
        i,
        m: new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3)), new THREE.Vector3(s, s * 0.6, s)),
        c: new THREE.Color().setHSL(0.72 + r() * 0.06, 0.18, 0.12 + r() * 0.08),
      });
    }
  }
  out.push(chunkedInstances(route, new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), rocks, { shadow: true, receive: true }));

  // coloured light pools (with caustics) on the floor and the road
  out.push(buildPools(route, pools, ground));

  // sky, clouds, glitter
  out.push(buildSky(sunDir));
  out.push(buildClouds(sunDir, r));
  out.push(buildDustMotes({ count: opts.high ? 1400 : 500, box: 70, color: '#ffffff', size: 1.3, opacity: 1.4 }));
  out.push(buildDustMotes({ count: opts.high ? 900 : 300, box: 90, color: '#cdb4ff', size: 1.8, opacity: 1.2 }));
  return out;
}
