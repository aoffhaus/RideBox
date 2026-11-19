// Neon Rain: a night ride through a rain-soaked city. Canyons of towers with grids of
// lit and dark windows line the street; blade signs and shop signs in pink, cyan,
// amber, green and violet hum and sputter at street level, and the wet asphalt smears
// all of it into long rippling reflections. Low clouds glow orange-magenta with the
// city's light, haze hangs between the buildings, steam rises from street vents and
// an elevated railway crosses overhead. The road climbs onto a couple of overpasses.
//
// Neon and lamps are pushed above 1.0 (not tone mapped) for the bloom pass. Signs,
// rain, ripples and the trains are animated through `fxTime` / `neonCityUpdate`.
import * as THREE from 'three';
import type { Route } from '../route';
import { fxTime } from '../fx';
import {
  EDGE,
  ROAD_HALF,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  clampOff,
  loopInfo,
  merge,
  rng,
  smooth,
  worldAt,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import {
  FLICKER_GLSL,
  FOG_GLSL,
  NOISE_GLSL,
  billboardMaterial,
  buildRain,
  cityLightSet,
  ribbon,
  wetMaterial,
  type CityLight,
} from './neoncityFx';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export const NEON_CITY = {
  skyTop: '#07050d',
  skyHorizon: '#5a2846',
  haze: '#2c1830',
  fogNear: 12,
  fogFar: 620,
};

const NEONS = ['#ff2f8e', '#21e4ff', '#ffab2e', '#39ff88', '#a24dff', '#ff2f8e', '#21e4ff'].map((h) => new THREE.Color(h));
const LAMP_WARM = new THREE.Color('#ffac5c');
const LAMP_COOL = new THREE.Color('#c4e2ff');

const neon = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

// ---------------------------------------------------------------------------
// Animated state shared with `neonCityUpdate`
// ---------------------------------------------------------------------------
interface Train {
  obj: THREE.Object3D;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  span: number;
  speed: number;
  offset: number;
}
let trains: Train[] = [];

export function neonCityUpdate(time: number) {
  for (const tr of trains) {
    const L = tr.span * 2 + 400;
    const a = ((((time * tr.speed + tr.offset) % L) + L) % L) - L / 2;
    tr.obj.position.copy(tr.origin).addScaledVector(tr.dir, a);
  }
}

// ---------------------------------------------------------------------------
// Street level: where the road rises onto an overpass, the city stays below
// ---------------------------------------------------------------------------
function liftProfile(route: Route): Float32Array {
  const L = loopInfo(route);
  const range = L.maxY - L.minY;
  const T = L.minY + range * 0.7;
  const out = new Float32Array(L.n);
  for (let i = 0; i < L.n; i++) out[i] = Math.max(0, route.y[i] - T);
  return out;
}

/** Sidewalk width (m beyond EDGE): full in the streets, a narrow walkway on overpasses. */
const sidewalkW = (lift: number) => 0.5 + 2.95 * (1 - smooth(0.4, 2.2, lift));

// ---------------------------------------------------------------------------
// Road texture (mostly hidden under the wet overlay)
// ---------------------------------------------------------------------------
export function neonCityRoad() {
  return canvasTex(64, 64, (g) => {
    g.fillStyle = '#0c0b10';
    g.fillRect(0, 0, 64, 64);
  });
}

// ---------------------------------------------------------------------------
// Sky: overcast, the cloud base lit orange-magenta from below by the city
// ---------------------------------------------------------------------------
function stickToCamera(m: THREE.Mesh) {
  m.frustumCulled = false;
  m.onBeforeRender = (_r, _s, camera) => {
    m.position.copy(camera.position);
    m.updateMatrixWorld();
  };
}

function buildSky(): THREE.Mesh {
  const C = (h: string) => new THREE.Color(h);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      fxTime,
      uHaze: { value: C(NEON_CITY.haze) },
      uTop: { value: C(NEON_CITY.skyTop) },
      uMag: { value: C('#6e2358') },
      uOrange: { value: C('#a04a33') },
      uViolet: { value: C('#24123a') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform vec3 uHaze, uTop, uMag, uOrange, uViolet;
      varying vec3 vDir;
      ${NOISE_GLSL}
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * nNoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        float az = atan(d.z, d.x);
        float glow = exp(-max(y, 0.0) * 3.2);
        // cloud base projected onto a plane, drifting
        vec2 cp = d.xz / (max(y, 0.0) + 0.07) * 0.55 + vec2(fxTime * 0.02, fxTime * 0.008);
        float c = fbm(cp);
        float c2 = fbm(cp * 0.35 + 4.0);
        // some districts burn hotter (orange) than others (magenta)
        float hot = nNoise(vec2(az * 1.6 + 7.0, 0.5));
        vec3 under = mix(uMag, uOrange, smoothstep(0.35, 0.8, hot));
        vec3 cloud = mix(uTop, uViolet, smoothstep(0.85, 0.3, y));
        cloud = mix(cloud, under, glow);
        float dens = smoothstep(0.25, 0.75, c * 0.65 + c2 * 0.5);
        vec3 col = cloud * (0.35 + 0.95 * dens);
        // thin dark rifts high up
        col *= mix(1.0, 0.55, smoothstep(0.5, 0.2, c2) * smoothstep(0.1, 0.5, y));
        col = mix(uHaze, col, smoothstep(-0.03, 0.14, y));
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

// ---------------------------------------------------------------------------
// Buildings: instanced boxes with procedural windows (no textures)
// ---------------------------------------------------------------------------
function buildingMaterial(o: { far?: boolean; store?: boolean; fogNear: number; fogFar: number }): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    defines: { ...(o.far ? { FAR: 1 } : {}), ...(o.store ? { STORE: 1 } : {}) },
    uniforms: {
      uFogNear: { value: o.fogNear },
      uFogFar: { value: o.fogFar },
      uFogCol: { value: new THREE.Color(NEON_CITY.haze) },
      uWall: { value: new THREE.Color('#1c1826') },
      uBury: { value: 3 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      varying vec3 vN;
      varying vec3 vSpill;
      varying float vBase;
      varying float vSeed;
      float bHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      void main() {
        mat4 M = modelMatrix * instanceMatrix;
        vec4 wp = M * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(M) * normal);
        vec3 o = (M * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vBase = o.y;
        vSeed = bHash(o.xz * 0.0137 + 0.5);
        vSpill = instanceColor;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform float uFogNear, uFogFar, uBury;
      uniform vec3 uFogCol, uWall;
      varying vec3 vW;
      varying vec3 vN;
      varying vec3 vSpill;
      varying float vBase;
      varying float vSeed;
      ${NOISE_GLSL}
      void main() {
        vec3 n = normalize(vN);
        float dist = length(cameraPosition - vW);
        float seed = floor(vSeed * 997.0 + 0.5) / 997.0; // quantised: interpolation jitter must not reach the hashes
        float hgt = vW.y - vBase - uBury;
        vec3 wall = uWall * (0.5 + 1.0 * fract(seed * 5.31));
        vec3 col;
        if (n.y > 0.5) {
          col = wall * 0.45;
        } else {
          vec2 tg = normalize(vec2(-n.z, n.x));
          float u = dot(vW.xz, tg);
          #ifdef FAR
            float floorH = 4.2;
            float bay = 3.2 + fract(seed * 7.13) * 2.4;
          #else
            float floorH = 3.2 + fract(seed * 3.3) * 0.9;
            float bay = 1.9 + fract(seed * 7.13) * 1.9;
          #endif
          vec2 g = vec2(u / bay, hgt / floorH);
          vec2 id = mod(floor(g), 293.0);
          vec2 f = fract(g);
          vec2 fw = fwidth(g);
          float wx = smoothstep(0.22 - fw.x, 0.22 + fw.x, f.x) * (1.0 - smoothstep(0.78 - fw.x, 0.78 + fw.x, f.x));
          float wy = smoothstep(0.3 - fw.y, 0.3 + fw.y, f.y) * (1.0 - smoothstep(0.85 - fw.y, 0.85 + fw.y, f.y));
          float win = wx * wy * step(0.0, hgt);
          float h = nHash(id + seed * 91.7);
          float h2 = nHash(id * 1.37 + seed * 13.1 + 5.0);
          float floorLit = nHash(vec2(id.y, seed * 37.0));
          float litFrac = (0.1 + 0.4 * fract(seed * 3.71)) * (0.35 + 1.1 * floorLit);
          float lit = step(h, litFrac);
          vec3 wc = h2 < 0.5 ? vec3(1.0, 0.6, 0.3) : (h2 < 0.8 ? vec3(0.55, 0.75, 1.0) : (h2 < 0.91 ? vec3(0.2, 1.0, 0.85) : vec3(1.0, 0.35, 0.85)));
          float bright = 0.22 + 0.75 * fract(h * 13.1);
          if (h2 > 0.97) bright *= 0.55 + 0.45 * sin(fxTime * (5.0 + h * 25.0) + h * 50.0);
          bright *= (0.55 + 0.45 * f.y) * (0.75 + 0.25 * step(0.5, fract(f.x * 2.0 + h)));
          vec3 glass = vec3(0.01, 0.01, 0.018) + vSpill * 0.05;
          vec3 wcol = mix(glass, wc * bright, lit);
          col = mix(wall, wcol, win);
          float far = smoothstep(0.3, 0.9, max(fw.x, fw.y));
          vec3 avg = mix(wall, glass + vec3(0.8, 0.68, 0.6) * 0.75 * litFrac, 0.42);
          col = mix(col, avg, far);
          #ifdef STORE
            if (hgt < 4.3) {
              float sb = u / 3.4;
              float sf = fract(sb);
              float hs = nHash(vec2(mod(floor(sb), 293.0), seed * 17.0));
              float gm = smoothstep(0.05, 0.08, sf) * smoothstep(0.95, 0.92, sf) * step(0.25, hgt) * step(hgt, 3.5);
              float shelves = 0.7 + 0.3 * step(0.5, fract(hgt * 2.2)) * step(0.15, fract(sf * 5.0));
              vec3 shop = hs < 0.62 ? mix(vec3(1.0, 0.72, 0.45) * (0.25 + 0.5 * fract(hs * 7.0)), vSpill * 0.9 + 0.03, step(0.35, hs)) * shelves * (0.5 + 0.5 * hgt / 3.5)
                                    : vec3(0.03, 0.03, 0.04) * (0.7 + 0.6 * step(0.5, fract(hgt * 7.0)));
              col = mix(wall * 0.7, shop, gm);
            }
          #endif
          col += vSpill * exp(-max(hgt, 0.0) / 5.0) * 0.14;
        }
        float fog = smoothstep(uFogNear, uFogFar, dist);
        #ifdef FAR
          fog = min(1.0, fog + (1.0 - smoothstep(0.0, 140.0, hgt)) * 0.35);
        #endif
        col = mix(col, uFogCol, fog);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}

// ---------------------------------------------------------------------------
// Neon sign atlases: invented glyphs drawn as tubes (white; tinted per instance)
// ---------------------------------------------------------------------------
function glyph(g: CanvasRenderingContext2D, r: () => number, x: number, y: number, w: number, h: number) {
  // strokes between points of a 3×4 lattice, plus the odd loop or dot
  const P = (c: number, k: number): [number, number] => [x + (c / 2) * w, y + (k / 3) * h];
  const strokes = 2 + Math.floor(r() * 3);
  g.beginPath();
  let c = Math.floor(r() * 3);
  let k = Math.floor(r() * 4);
  g.moveTo(...P(c, k));
  for (let s = 0; s < strokes; s++) {
    const nc = Math.max(0, Math.min(2, c + Math.floor(r() * 3) - 1 + (r() < 0.3 ? (r() < 0.5 ? -1 : 1) : 0)));
    const nk = Math.max(0, Math.min(3, k + Math.floor(r() * 4) - 1));
    if (nc === c && nk === k) continue;
    if (r() < 0.25) g.moveTo(...P(nc, nk));
    else g.lineTo(...P(nc, nk));
    c = nc;
    k = nk;
  }
  g.stroke();
  if (r() < 0.35) {
    g.beginPath();
    g.arc(x + w * (0.25 + r() * 0.5), y + h * (0.25 + r() * 0.5), Math.min(w, h) * (0.15 + r() * 0.15), 0, Math.PI * (1 + r()));
    g.stroke();
  }
  if (r() < 0.3) {
    g.beginPath();
    g.arc(x + w * r(), y + h * (r() < 0.5 ? -0.12 : 1.12), 3.5, 0, Math.PI * 2);
    g.fill();
  }
}

function tubeStyle(g: CanvasRenderingContext2D, width: number) {
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rad: number) {
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
  g.stroke();
}

/** Draws twice: a blurred pass for the halo, then the crisp tube. */
function glowDraw(g: CanvasRenderingContext2D, draw: () => void) {
  g.save();
  g.shadowColor = '#fff';
  g.shadowBlur = 16;
  g.globalAlpha = 0.55;
  draw();
  g.restore();
  draw();
}

function verticalAtlas() {
  return canvasTex(
    1024,
    512,
    (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 1024, 512);
      const r = rng(4242);
      for (let cell = 0; cell < 8; cell++) {
        const x0 = cell * 128;
        const seed = Math.floor(r() * 1e6);
        glowDraw(g, () => {
          const rr = rng(seed);
          tubeStyle(g, 7);
          if (rr() < 0.8) roundRect(g, x0 + 12, 12, 104, 488, 14);
          tubeStyle(g, 9);
          const count = 4 + Math.floor(rr() * 2);
          const gh = 440 / count;
          for (let k = 0; k < count; k++) glyph(g, rr, x0 + 34, 40 + k * gh, 60, gh - 34);
        });
      }
    },
    false,
  );
}

function horizontalAtlas() {
  return canvasTex(
    1024,
    512,
    (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 1024, 512);
      const r = rng(9191);
      for (let cell = 0; cell < 8; cell++) {
        const x0 = (cell % 2) * 512;
        const y0 = Math.floor(cell / 2) * 128;
        const seed = Math.floor(r() * 1e6);
        glowDraw(g, () => {
          const rr = rng(seed);
          tubeStyle(g, 6);
          const style = rr();
          if (style < 0.6) roundRect(g, x0 + 12, y0 + 12, 488, 104, 18);
          else {
            g.beginPath();
            g.moveTo(x0 + 20, y0 + 108);
            g.lineTo(x0 + 492, y0 + 108);
            g.stroke();
          }
          tubeStyle(g, 8);
          const count = 4 + Math.floor(rr() * 3);
          const gw = 430 / count;
          for (let k = 0; k < count; k++) glyph(g, rr, x0 + 44 + k * gw, y0 + 30, gw - 30, 62);
        });
      }
    },
    false,
  );
}

/** Instanced neon sign material; per-instance colour packs the atlas cell (r) and flicker seed (g). */
function signMaterial(map: THREE.Texture, vertical: boolean): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: true,
    side: THREE.DoubleSide,
    defines: vertical ? { VERT: 1 } : {},
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: map } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vCell;
      varying float vSeed;
      #include <fog_pars_vertex>
      void main() {
        vec3 ic = instanceColor;
        vCell = floor(ic.r * 0.5);
        float sg = floor(ic.g * 0.5);
        vSeed = sg / 100.0;
        vCol = vec3(ic.r - vCell * 2.0, ic.g - sg * 2.0, ic.b);
        vUv = uv;
        vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vCell;
      varying float vSeed;
      #include <common>
      #include <fog_pars_fragment>
      ${FOG_GLSL}
      ${FLICKER_GLSL}
      void main() {
        float cell = floor(vCell + 0.5);
        #ifdef VERT
          vec2 cuv = vec2((cell + vUv.x) / 8.0, vUv.y);
        #else
          float cx = mod(cell, 2.0);
          float cy = floor(cell / 2.0);
          vec2 cuv = vec2((cx + vUv.x) / 2.0, 1.0 - (cy + 1.0 - vUv.y) / 4.0);
        #endif
        float m = texture2D(map, cuv).r;
        float core = smoothstep(0.55, 0.95, m);
        float fl = neonFlicker(floor(vSeed * 100.0 + 0.5) / 100.0, fxTime);
        vec3 col = vCol * (core * 5.5 + m * 1.3 + 0.03) * fl;
        col *= 1.0 - cityFog() * 0.92;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}

/** Big animated video screens high on the facades. */
function screenMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    toneMapped: false,
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vSeed;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vCol = instanceColor;
        vec3 o = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vSeed = fract(sin(dot(o.xz, vec2(0.0127, 0.0311))) * 4375.85);
        vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vSeed;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        vec2 p = vUv;
        float t = fxTime + vSeed * 40.0;
        float scene = mod(floor(t / 5.0) + floor(vSeed * 3.0), 3.0);
        vec3 a = vCol;
        vec3 b = vec3(vCol.b, vCol.r, vCol.g);
        vec3 col;
        if (scene < 1.0) {
          float w = sin(p.x * 7.0 + t * 1.4) * 0.5 + sin(p.y * 5.0 - t * 0.9) * 0.5;
          col = mix(a, b, 0.5 + 0.5 * w);
        } else if (scene < 2.0) {
          float r = length((p - 0.5) * vec2(1.7, 1.0));
          col = mix(b, a, smoothstep(0.1, 0.5, abs(fract(r * 3.0 - t * 0.6) - 0.5) * 2.0));
        } else {
          float bars = step(0.5, fract(p.x * 9.0 + floor(p.y * 6.0) * 0.37 + t * 0.4 * (mod(floor(p.y * 6.0), 2.0) * 2.0 - 1.0)));
          col = mix(a * 0.25, b, bars);
        }
        col *= 0.75 + 0.25 * step(0.5, fract(p.y * 90.0));
        float edge = step(0.03, p.x) * step(p.x, 0.97) * step(0.05, p.y) * step(p.y, 0.95);
        col = mix(vec3(0.01), col * 1.6, edge);
        #ifdef USE_FOG
          col = mix(col, fogColor, smoothstep(fogNear, fogFar, vFogDepth) * 0.9);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}

/** Street lamp light cones: additive, brighter through their middle, with rain falling through. */
function coneMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: true,
    side: THREE.DoubleSide,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) },
    vertexShader: /* glsl */ `
      varying vec3 vCol;
      varying float vY;
      varying float vFace;
      varying vec2 vRain;
      #include <fog_pars_vertex>
      void main() {
        vCol = instanceColor;
        vY = clamp(-position.y / 7.2, 0.0, 1.0);
        mat4 M = modelMatrix * instanceMatrix;
        vec4 wp = M * vec4(position, 1.0);
        vec3 n = normalize(mat3(M) * normal);
        vFace = abs(dot(n, normalize(cameraPosition - wp.xyz)));
        vRain = vec2(atan(position.z, position.x) * 7.0, position.y);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      varying vec3 vCol;
      varying float vY;
      varying float vFace;
      varying vec2 vRain;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      ${FOG_GLSL}
      void main() {
        float a = pow(vFace, 2.0) * pow(1.0 - vY, 1.6) * smoothstep(0.0, 0.06, vY);
        float rain = nNoise(vec2(vRain.x * 3.0, vRain.y * 0.7 + fxTime * 9.0));
        rain = smoothstep(0.55, 0.95, rain);
        vec3 col = vCol * a * (0.55 + 1.2 * rain) * (1.0 - cityFog());
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}

/** Traffic signal lamps: instance colour r = lamp (0 red, 1 amber, 2 green), g = cycle phase. */
function signalMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    toneMapped: false,
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) },
    vertexShader: /* glsl */ `
      varying float vKind;
      varying float vPhase;
      #include <fog_pars_vertex>
      void main() {
        vKind = instanceColor.r;
        vPhase = instanceColor.g;
        vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      varying float vKind;
      varying float vPhase;
      #include <common>
      #include <fog_pars_fragment>
      ${FLICKER_GLSL}
      void main() {
        vec3 c = vKind < 0.5 ? vec3(1.0, 0.06, 0.02) : (vKind < 1.5 ? vec3(1.0, 0.45, 0.02) : vec3(0.05, 1.0, 0.45));
        float on = abs(signalState(vPhase, fxTime) - vKind) < 0.5 ? 6.0 : 0.04;
        gl_FragColor = vec4(c * on, 1.0);
        #include <fog_fragment>
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}

function trainTexture() {
  return canvasTex(
    512,
    64,
    (g) => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, 512, 64);
      for (let k = 0; k < 10; k++) {
        const x = 12 + k * 50;
        const gr = g.createLinearGradient(0, 18, 0, 44);
        gr.addColorStop(0, '#fff3dc');
        gr.addColorStop(1, '#ffd49a');
        g.fillStyle = gr;
        g.fillRect(x, 18, 38, 24);
      }
      g.fillStyle = '#ff2f8e';
      g.fillRect(0, 50, 512, 4);
    },
    false,
  );
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);

export function buildNeonCity(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const step = route.step;
  const r = rng(route.seed * 71 + 29);
  const high = opts.high;
  const out: THREE.Object3D[] = [];
  const lift = liftProfile(route);
  const groundY = (i: number) => route.y[i] - lift[i];
  const lights: CityLight[] = [];
  const NL = high ? 32 : 16;

  // --- local frame helpers
  const fwdAt = (i: number) => new THREE.Vector3(Math.cos(route.heading[i]), 0, Math.sin(route.heading[i]));
  const latAt = (i: number) => new THREE.Vector3(-Math.sin(route.heading[i]), 0, Math.cos(route.heading[i]));
  /** Box (unit, base at y=0 unless centred) aligned with the road at sample i. sx along the road, sz across. */
  const boxM = (p: THREE.Vector3, i: number, sx: number, sy: number, sz: number) => {
    const m = new THREE.Matrix4().makeBasis(fwdAt(i), UP, latAt(i));
    m.scale(new THREE.Vector3(sx, sy, sz));
    m.setPosition(p);
    return m;
  };
  /** Same, anchored at the base instead of the centre. */
  const baseBox = (p: THREE.Vector3, i: number, sx: number, sy: number, sz: number) => boxM(p.clone().setY(p.y + sy / 2), i, sx, sy, sz);
  const wrap = (i: number) => ((Math.round(i) % n) + n) % n;

  out.push(buildSky());

  // --- intersections (cross streets), never on overpasses
  const crossings: number[] = [];
  for (let s = 80; s < route.length - 120; s += 115 + r() * 90) {
    const i = wrap(s / step);
    if (lift[i] > 0.05 || lift[wrap(i - 20 / step)] > 0.05 || lift[wrap(i + 20 / step)] > 0.05) continue;
    crossings.push(i);
  }
  const GAP = 9; // half-width of a cross street (m)
  const inCrossing = (sM: number, pad: number) => crossings.some((ci) => Math.abs(sM - ci * step) < GAP + pad);

  // --- elevated railway: two crossings over the road
  interface Track {
    p: THREE.Vector3;
    dir: THREE.Vector3;
    half: number;
  }
  const tracks: Track[] = [];
  for (const frac of [0.31, 0.74]) {
    let i = wrap(frac * n);
    for (let k = 0; k < 200 && (lift[i] > 0 || inCrossing(i * step, 30)); k++) i = wrap(i + 4);
    const h = route.heading[i] + (r() < 0.5 ? 1 : -1) * (1.15 + r() * 0.25);
    tracks.push({ p: new THREE.Vector3(route.x[i], route.y[i] + 13.5, route.z[i]), dir: new THREE.Vector3(Math.cos(h), 0, Math.sin(h)), half: 520 });
  }
  const nearTrack = (x: number, z: number, clear: number) =>
    tracks.some((t) => {
      const dx = x - t.p.x;
      const dz = z - t.p.z;
      const along = dx * t.dir.x + dz * t.dir.z;
      const perp = Math.abs(dx * t.dir.z - dz * t.dir.x);
      return Math.abs(along) < t.half + 30 && perp < clear;
    });

  // --- ground: sidewalks, lots, overpass ramp walls
  const model: TerrainModel = {
    cols: 20,
    roadCol: 9,
    colOff(i, c) {
      const sw = sidewalkW(lift[i]);
      const mags = [EDGE, EDGE + 0.06, EDGE + sw, EDGE + sw + 1.6, 14, 22, 36, 60, 100, 170];
      return c < 10 ? -mags[9 - c] : mags[c - 10];
    },
    height(i, off) {
      const a = Math.abs(off);
      if (a <= EDGE + 0.01) return -0.02;
      const sw = sidewalkW(lift[i]);
      if (a <= EDGE + sw + 0.01) return 0.15;
      return 0.15 + (0.05 - lift[i] - 0.15) * smooth(EDGE + sw, EDGE + sw + 1.6, a);
    },
    color(i, off, dy, c) {
      const a = Math.abs(off);
      if (a <= EDGE + sidewalkW(lift[i]) + 0.01) c.set('#33313c');
      else if (dy < -0.5) c.set('#2a2731');
      else c.set('#17161c');
    },
  };
  out.push(buildTerrainMesh(route, model));


  // ---------------------------------------------------------------------
  // Buildings
  // ---------------------------------------------------------------------
  const nearB: Inst[] = []; // front row (with storefronts)
  const midB: Inst[] = [];
  const front: { i0: number; i1: number; side: number; face: number; w: number; h: number; spill: THREE.Color }[] = [];
  const rows = [
    { face: [8.6, 10.2], w: [9, 24], d: [12, 22], h: (q: number) => 9 + Math.pow(q, 1.5) * 34 + (r() < 0.06 ? 50 + r() * 60 : 0), gap: [0.2, 1.6], list: nearB },
    { face: [34, 40], w: [14, 30], d: [16, 26], h: (q: number) => 24 + Math.pow(q, 1.3) * 70, gap: [1, 5], list: midB },
    { face: [68, 80], w: [18, 36], d: [20, 30], h: (q: number) => 40 + Math.pow(q, 1.2) * 110, gap: [2, 8], list: midB },
    ...(high ? [{ face: [118, 132], w: [22, 40], d: [22, 34], h: (q: number) => 60 + Math.pow(q, 1.1) * 150, gap: [4, 16], list: midB }] : []),
  ];
  const pickNeon = () => NEONS[Math.floor(r() * NEONS.length)];
  rows.forEach((row, rowIdx) => {
    for (const side of [-1, 1]) {
      let sM = r() * 10;
      while (sM < route.length - 30) {
        const w = row.w[0] + r() * (row.w[1] - row.w[0]);
        if (inCrossing(sM + w / 2, w / 2 + rowIdx * 2)) {
          sM += 6;
          continue;
        }
        const ic = wrap((sM + w / 2) / step);
        const face = row.face[0] + r() * (row.face[1] - row.face[0]);
        const d = row.d[0] + r() * (row.d[1] - row.d[0]);
        const want = side * (face + d / 2);
        const off = clampOff(route, ic, want);
        if (Math.abs(off) < Math.abs(want) - 0.5) {
          sM += w;
          continue;
        }
        const p = worldAt(route, ic, off, 0);
        const span = Math.ceil(w / 2 / step);
        let g = Infinity;
        for (let k = -span; k <= span; k++) g = Math.min(g, groundY(wrap(ic + k)));
        if (nearTrack(p.x, p.z, 9 + Math.max(w, d) / 2)) {
          sM += w;
          continue;
        }
        const hgt = row.h(r());
        const top = groundY(ic) + hgt;
        p.y = g - 3;
        const spill = rowIdx === 0 ? pickNeon().clone().multiplyScalar(0.55 + r() * 0.4) : r() < 0.4 ? pickNeon().clone().multiplyScalar(0.25) : new THREE.Color(0, 0, 0);
        row.list.push({ i: ic, m: boxM(p, ic, w, top - p.y, d), c: spill });
        // setback crown on the taller ones
        if (hgt > 45 && r() < 0.45) {
          const p2 = p.clone();
          p2.y = top - 0.5;
          row.list.push({ i: ic, m: boxM(p2, ic, w * (0.55 + r() * 0.25), hgt * (0.15 + r() * 0.25), d * (0.55 + r() * 0.25)), c: spill.clone().multiplyScalar(0.3) });
        }
        if (rowIdx === 0) front.push({ i0: wrap(sM / step), i1: wrap((sM + w) / step), side, face, w, h: hgt, spill });
        sM += w + row.gap[0] + r() * (row.gap[1] - row.gap[0]);
      }
    }
  });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  out.push(chunkedInstances(route, boxGeo, buildingMaterial({ store: true, fogNear: NEON_CITY.fogNear, fogFar: NEON_CITY.fogFar }), nearB, { shadow: false }));
  out.push(chunkedInstances(route, boxGeo, buildingMaterial({ fogNear: NEON_CITY.fogNear, fogFar: NEON_CITY.fogFar * 1.1 }), midB, { shadow: false, chunkM: 1200 }));

  // ---------------------------------------------------------------------
  // Neon signs on the front row
  // ---------------------------------------------------------------------
  const blades: Inst[] = [];
  const shops: Inst[] = [];
  const boards: Inst[] = [];
  const screens: Inst[] = [];
  const pack = (col: THREE.Color, cell: number, seed: number) => new THREE.Color(col.r + 2 * cell, col.g + 2 * Math.floor(seed * 100), col.b);
  const bladeP = high ? 1 : 0.5;
  let lastScreen = -1e9;
  for (const b of front) {
    const span = wrap(b.i1 - b.i0);
    if (span <= 0 || span > 40) continue;
    const col = b.spill.clone().multiplyScalar(1 / Math.max(0.01, Math.max(b.spill.r, b.spill.g, b.spill.b)));
    // vertical blade signs sticking out over the sidewalk
    const nb = r() < 0.8 * bladeP ? (r() < 0.35 * bladeP ? 2 : 1) : 0;
    for (let k = 0; k < nb; k++) {
      const i = wrap(b.i0 + span * (0.2 + 0.6 * r()));
      const bc = k === 0 ? col : pickNeon();
      const len = 3 + r() * 4.5;
      const wd = 0.95 + r() * 0.35;
      const y0 = 3.9 + r() * 2.5;
      const off = b.side * (b.face - wd / 2 - 0.25);
      const p = worldAt(route, i, off, y0 + len / 2);
      p.y = groundY(i) + y0 + len / 2;
      const fwd = fwdAt(i);
      const lat = latAt(i);
      const seed = r();
      const m = new THREE.Matrix4().makeBasis(lat, UP, fwd.clone().negate());
      m.scale(new THREE.Vector3(wd, len, 1));
      m.setPosition(p.clone().addScaledVector(fwd, -0.13));
      blades.push({ i, m, c: pack(bc, Math.floor(r() * 8), seed) });
      const m2 = new THREE.Matrix4().makeBasis(lat.clone().negate(), UP, fwd);
      m2.scale(new THREE.Vector3(wd, len, 1));
      m2.setPosition(p.clone().addScaledVector(fwd, 0.13));
      blades.push({ i, m: m2, c: pack(bc, Math.floor(r() * 8), seed) });
      const bm = new THREE.Matrix4().makeBasis(lat, UP, fwd.clone().negate());
      bm.scale(new THREE.Vector3(wd + 0.12, len + 0.12, 0.22));
      bm.setPosition(p);
      boards.push({ i, m: bm });
      lights.push({ i, x: p.x, y: p.y, z: p.z, w: 0.42, col: neon(bc, 2.6), kind: 1, seed });
    }
    // horizontal shop sign flat on the facade
    if (r() < 0.75 * (high ? 1 : 0.6)) {
      const i = wrap(b.i0 + span * 0.5);
      const sc = r() < 0.6 ? col : pickNeon();
      const W = Math.min(10, b.w * (0.4 + r() * 0.35));
      const H = W / 4.2;
      const y = 3.6 + r() * 0.9 + H / 2;
      const p = worldAt(route, i, b.side * (b.face - 0.08), 0);
      p.y = groundY(i) + y;
      const fwd = fwdAt(i);
      const lat = latAt(i);
      const seed = r();
      const m = new THREE.Matrix4().makeBasis(fwd.clone().multiplyScalar(-b.side), UP, lat.clone().multiplyScalar(-b.side));
      m.scale(new THREE.Vector3(W, H, 1));
      m.setPosition(p);
      shops.push({ i, m, c: pack(sc, Math.floor(r() * 8), seed) });
      lights.push({ i, x: p.x, y: p.y, z: p.z, w: Math.min(1.2, W * 0.15), col: neon(sc, 1.6), kind: 1, seed });
    }
    // now and then a big video screen high on a tall facade
    const sMid = (b.i0 + span / 2) * step;
    if (b.h > 26 && sMid - lastScreen > (high ? 260 : 450) && r() < 0.5) {
      lastScreen = sMid;
      const i = wrap(b.i0 + span / 2);
      const W = Math.min(b.w * 0.8, 9 + r() * 6);
      const H = W * (0.5 + r() * 0.25);
      const y = Math.min(b.h - H / 2 - 2, 12 + r() * 10);
      const p = worldAt(route, i, b.side * (b.face - 0.1), 0);
      p.y = groundY(i) + y;
      const m = new THREE.Matrix4().makeBasis(fwdAt(i).multiplyScalar(-b.side), UP, latAt(i).multiplyScalar(-b.side));
      m.scale(new THREE.Vector3(W, H, 1));
      m.setPosition(p);
      const c1 = pickNeon();
      screens.push({ i, m, c: c1 });
      lights.push({ i, x: p.x, y: p.y, z: p.z, w: 1.0, col: neon(c1, 0.5), kind: 0, seed: 0 });
    }
  }
  const plane = new THREE.PlaneGeometry(1, 1);
  if (blades.length) out.push(chunkedInstances(route, plane, signMaterial(verticalAtlas(), true), blades, { shadow: false }));
  if (shops.length) out.push(chunkedInstances(route, plane, signMaterial(horizontalAtlas(), false), shops, { shadow: false }));
  if (screens.length) out.push(chunkedInstances(route, plane, screenMaterial(), screens, { shadow: false }));
  const metal = new THREE.MeshLambertMaterial({ color: '#1b1a22' });
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const metalBoxes: Inst[] = [...boards];

  // ---------------------------------------------------------------------
  // Street lamps with light cones
  // ---------------------------------------------------------------------
  const poles: Inst[] = [];
  const heads: Inst[] = [];
  const cones: Inst[] = [];
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const lampEvery = Math.max(1, Math.round(32 / step));
  let lampCol = LAMP_WARM;
  for (let i = 0, k = 0; i < n; i += lampEvery, k++) {
    if (k % 20 === 0) lampCol = r() < 0.65 ? LAMP_WARM : LAMP_COOL;
    const side = k % 2 ? 1 : -1;
    const off = side * (ROAD_HALF + 0.45);
    const p = worldAt(route, i, off, 0.15);
    if (nearTrack(p.x, p.z, 4)) continue;
    q.setFromAxisAngle(UP, -route.heading[i] + (side > 0 ? Math.PI : 0));
    const m = new THREE.Matrix4().compose(p, q, one);
    poles.push({ i, m });
    heads.push({ i, m, c: lampCol });
    const head = worldAt(route, i, off - side * 2.35, 0.15 + 7.32);
    cones.push({ i, m: new THREE.Matrix4().compose(head, q, one), c: neon(lampCol, 0.07) });
    lights.push({ i, x: head.x, y: head.y, z: head.z, w: 0.2, col: neon(lampCol, 1.7), kind: 0, seed: 0 });
  }
  const poleGeo = merge([
    new THREE.CylinderGeometry(0.08, 0.12, 7.6, 7).translate(0, 3.8, 0),
    new THREE.BoxGeometry(0.1, 0.1, 2.5).translate(0, 7.5, 1.2),
    new THREE.BoxGeometry(0.42, 0.14, 0.8).translate(0, 7.44, 2.35),
  ]);
  out.push(chunkedInstances(route, poleGeo, metal, poles, { shadow: false }));
  const headGeo = new THREE.BoxGeometry(0.32, 0.05, 0.66).translate(0, 7.36, 2.35);
  out.push(chunkedInstances(route, headGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 4.5, 4.5), toneMapped: false }), heads, { shadow: false }));
  const coneGeo = new THREE.ConeGeometry(3.4, 7.2, 24, 1, true).translate(0, -3.6, 0);
  const coneMesh = chunkedInstances(route, coneGeo, coneMaterial(), cones, { shadow: false });
  coneMesh.traverse((o) => (o.renderOrder = 4));
  out.push(coneMesh);

  // ---------------------------------------------------------------------
  // Traffic signals and crosswalks at the intersections
  // ---------------------------------------------------------------------
  const lamps: Inst[] = [];
  const cellsW = 2048;
  const cells = Math.ceil(route.length / 2) + 1;
  const cellsH = Math.ceil(cells / cellsW);
  const crossData = new Uint8Array(cellsW * cellsH);
  const sigHead = (i: number, off: number, y: number, phase: number) => {
    const p = worldAt(route, i, off, 0);
    p.y = route.y[i] + y;
    metalBoxes.push({ i, m: boxM(p.clone().add(new THREE.Vector3(0, -0.6, 0)), i, 0.32, 1.25, 0.46) });
    const fwd = fwdAt(i);
    for (let kind = 0; kind < 3; kind++) {
      const lp = p.clone().addScaledVector(fwd, -0.17);
      lp.y += -0.6 + 0.38 - kind * 0.38;
      lamps.push({ i, m: boxM(lp, i, 0.04, 0.24, 0.24), c: new THREE.Color(kind, phase, 0) });
    }
    lights.push({ i, x: p.x, y: p.y, z: p.z, w: 0.22, col: new THREE.Color(2.2, 0, 0), kind: 2, seed: phase });
  };
  for (const ci of crossings) {
    const sC = ci * step;
    for (const sgn of [-1, 1]) {
      for (let s = sC + sgn * (GAP + 1); Math.abs(s - sC) < GAP + 5; s += sgn * 2) {
        const c = Math.floor((((s % route.length) + route.length) % route.length) / 2);
        crossData[c] = 255;
      }
    }
    const phase = r() * 24;
    const iS = wrap(ci - (GAP + 6) / step);
    // mast on the right, arm over the road
    const base = worldAt(route, iS, ROAD_HALF + 0.7, 0.15);
    metalBoxes.push({ i: iS, m: baseBox(base, iS, 0.24, 6.6, 0.24) });
    const arm = worldAt(route, iS, ROAD_HALF + 0.7 - 3.6, 6.45);
    metalBoxes.push({ i: iS, m: boxM(arm, iS, 0.16, 0.16, 7.4) });
    sigHead(iS, 1.6, 6.3, phase);
    sigHead(iS, -1.8, 6.3, phase);
    // far-side pole signal
    const iF = wrap(ci + (GAP + 3) / step);
    const fb = worldAt(route, iF, -(ROAD_HALF + 0.8), 0.15);
    metalBoxes.push({ i: iF, m: baseBox(fb, iF, 0.16, 3.6, 0.16) });
    sigHead(iF, -(ROAD_HALF + 0.8), 4.4, phase);
  }
  const crossTex = new THREE.DataTexture(crossData, cellsW, cellsH, THREE.RedFormat, THREE.UnsignedByteType);
  crossTex.magFilter = crossTex.minFilter = THREE.NearestFilter;
  crossTex.needsUpdate = true;
  if (lamps.length) out.push(chunkedInstances(route, new THREE.BoxGeometry(1, 1, 1), signalMaterial(), lamps, { shadow: false }));

  // ---------------------------------------------------------------------
  // Overpass barriers with a glowing rail
  // ---------------------------------------------------------------------
  const rails: Inst[] = [];
  for (let i = 0; i < n; i++) {
    if (lift[i] < 1.0) continue;
    for (const side of [-1, 1]) {
      const p = worldAt(route, i, side * (EDGE + 0.28), 0.15);
      metalBoxes.push({ i, m: baseBox(p, i, step * 1.04, 1.0, 0.3) });
      const pr = p.clone();
      pr.y += 1.0;
      rails.push({ i, m: boxM(pr, i, step * 1.04, 0.05, 0.08) });
    }
    if (i % Math.round(25 / step) === 0) {
      const p = worldAt(route, i, 0, 0);
      lights.push({ i, x: p.x - Math.sin(route.heading[i]) * (EDGE + 0.28), y: p.y + 1.1, z: p.z + Math.cos(route.heading[i]) * (EDGE + 0.28), w: 0.25, col: new THREE.Color(0.2, 1.2, 1.6), kind: 0, seed: 0 });
    }
  }
  if (rails.length) out.push(chunkedInstances(route, unitBox, new THREE.MeshBasicMaterial({ color: neon(new THREE.Color('#21e4ff'), 2.5), toneMapped: false }), rails, { shadow: false }));

  // ---------------------------------------------------------------------
  // Elevated railway
  // ---------------------------------------------------------------------
  trains = [];
  const railNeon: Inst[] = [];
  const trainTex = trainTexture();
  tracks.forEach((t, ti) => {
    const ci = route.x.reduce((best, _x, i) => ((route.x[i] - t.p.x) ** 2 + (route.z[i] - t.p.z) ** 2 < (route.x[best] - t.p.x) ** 2 + (route.z[best] - t.p.z) ** 2 ? i : best), 0);
    const side = new THREE.Vector3(-t.dir.z, 0, t.dir.x);
    const beam = (y: number, thick: number, width: number, lateral: number) => {
      const m = new THREE.Matrix4().makeBasis(t.dir, UP, side);
      m.scale(new THREE.Vector3(t.half * 2, thick, width));
      m.setPosition(t.p.clone().addScaledVector(side, lateral).add(new THREE.Vector3(0, y, 0)));
      return m;
    };
    metalBoxes.push({ i: ci, m: beam(-0.9, 1.6, 7, 0) });
    metalBoxes.push({ i: ci, m: beam(0.4, 0.9, 0.3, 3.4) });
    metalBoxes.push({ i: ci, m: beam(0.4, 0.9, 0.3, -3.4) });
    railNeon.push({ i: ci, m: beam(-1.72, 0.08, 0.12, 3.3) });
    railNeon.push({ i: ci, m: beam(-1.72, 0.08, 0.12, -3.3) });
    for (let s = -t.half + 16; s < t.half; s += 34) {
      const p = t.p.clone().addScaledVector(t.dir, s);
      let clear = true;
      for (let i = 0; i < n; i += 2) if ((route.x[i] - p.x) ** 2 + (route.z[i] - p.z) ** 2 < 8.5 * 8.5) clear = false;
      if (!clear) continue;
      const h = t.p.y - 1.7 - (L.minY - 30);
      const m = new THREE.Matrix4().makeBasis(t.dir, UP, side);
      m.scale(new THREE.Vector3(1.8, h, 1.8));
      m.setPosition(p.setY(L.minY - 30));
      metalBoxes.push({ i: ci, m: m.multiply(new THREE.Matrix4().makeTranslation(0, 0.5, 0)) });
    }
    for (const lat of [-3.3, 3.3]) {
      const p = t.p.clone().addScaledVector(side, lat);
      lights.push({ i: ci, x: p.x, y: p.y - 1.8, z: p.z, w: 0.9, col: new THREE.Color(0.25, 1.6, 2.0), kind: 0, seed: 0 });
    }
    // the train: five cars running along the viaduct
    const trainG = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: '#2a2a33', emissive: new THREE.Color(2.4, 2.2, 1.9), emissiveMap: trainTex });
    for (let c = 0; c < 5; c++) {
      const car = new THREE.Mesh(new THREE.BoxGeometry(16, 3.3, 3.1), bodyMat);
      car.position.set((c - 2) * 16.8, 1.55, 0);
      trainG.add(car);
    }
    const holder = new THREE.Group();
    holder.add(trainG);
    trainG.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(t.dir, UP, side));
    trainG.position.addScaledVector(side, ti % 2 ? 1.7 : -1.7);
    out.push(holder);
    trains.push({ obj: holder, origin: t.p.clone(), dir: t.dir.clone(), span: t.half, speed: ti % 2 ? -21 : 24, offset: ti % 2 ? 900 : 480 });
  });
  if (railNeon.length) out.push(chunkedInstances(route, unitBox, new THREE.MeshBasicMaterial({ color: neon(new THREE.Color('#21e4ff'), 3), toneMapped: false }), railNeon, { shadow: false, chunkM: 4000 }));

  out.push(chunkedInstances(route, unitBox, metal, metalBoxes, { shadow: false }));

  // ---------------------------------------------------------------------
  // Overhead cables across the street
  // ---------------------------------------------------------------------
  {
    const per = Math.round(800 / step);
    const groups = new Map<number, number[]>();
    for (let s = 20; s < route.length; s += 18 + r() * 30) {
      const i = wrap(s / step);
      if (lift[i] > 0.5 || inCrossing(s, 2)) continue;
      const k = Math.floor(i / per);
      let arr = groups.get(k);
      if (!arr) groups.set(k, (arr = []));
      const count = 1 + Math.floor(r() * 3);
      for (let c = 0; c < count; c++) {
        const ii = wrap(i + (r() - 0.5) * 3);
        const a = worldAt(route, ii, -(9 + r()), 0);
        const b = worldAt(route, wrap(ii + (r() - 0.5) * 4), 9 + r(), 0);
        a.y = route.y[ii] + 8 + r() * 8;
        b.y = route.y[ii] + 8 + r() * 8;
        const sag = 0.8 + r() * 1.6;
        const SEG = 10;
        for (let j = 0; j < SEG; j++) {
          for (const tt of [j / SEG, (j + 1) / SEG]) {
            arr.push(a.x + (b.x - a.x) * tt, a.y + (b.y - a.y) * tt - sag * 4 * tt * (1 - tt), a.z + (b.z - a.z) * tt);
          }
        }
      }
    }
    const lineMat = new THREE.LineBasicMaterial({ color: '#08070c', fog: true });
    for (const arr of groups.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      out.push(new THREE.LineSegments(geo, lineMat));
    }
  }

  // ---------------------------------------------------------------------
  // Haze, distant glows down the cross streets, vent steam
  // ---------------------------------------------------------------------
  const hazeI: Inst[] = [];
  const glowI: Inst[] = [];
  const steamI: Inst[] = [];
  const sprite = (i: number, p: THREE.Vector3, s: number, c: THREE.Color) => ({ i, m: new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(s, s, s)), c });
  const nearestLightCol = (x: number, z: number) => {
    let best = Infinity;
    let col = LAMP_WARM;
    for (const l of lights) {
      const d = (l.x - x) ** 2 + (l.z - z) ** 2;
      if (d < best && l.kind !== 2) {
        best = d;
        col = l.col;
      }
    }
    return col.clone().multiplyScalar(1 / Math.max(0.01, Math.max(col.r, col.g, col.b)));
  };
  lights.sort((a, b) => a.i - b.i);
  const hazeEvery = (high ? 26 : 45) / step;
  for (let f = 0; f < n; f += hazeEvery) {
    const i = wrap(f + r() * 4);
    const p = worldAt(route, i, (r() - 0.5) * 14, 0);
    p.y = groundY(i) + 6 + r() * 16;
    const near = lights.filter((l) => Math.abs(l.i - i) < 40 / step);
    const c = near.length ? near[Math.floor(r() * near.length)].col : LAMP_WARM;
    const cn = c.clone().multiplyScalar(1 / Math.max(0.01, Math.max(c.r, c.g, c.b)));
    hazeI.push(sprite(i, p, 22 + r() * 22, cn.multiplyScalar(0.05 + r() * 0.04)));
  }
  for (const ci of crossings) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const off = clampOff(route, ci, side * (18 + k * 26 + r() * 10));
        const p = worldAt(route, ci, off, 5 + r() * 12);
        hazeI.push(sprite(ci, p, 28 + r() * 20, pickNeon().clone().multiplyScalar(0.06 + r() * 0.05)));
      }
      for (let d = 22; d < 230; d += 18 + r() * 14) {
        const off = clampOff(route, ci, side * d);
        if (Math.abs(off) < d - 1) break;
        const p = worldAt(route, ci, off, 5.5 + r() * 1.5);
        for (const along of [-6.5, 6.5]) {
          const pp = p.clone().addScaledVector(fwdAt(ci), along);
          glowI.push(sprite(ci, pp, 2.2 + r(), neon(r() < 0.75 ? LAMP_WARM : pickNeon(), 1.6)));
        }
        if (r() < 0.5) {
          const pp = p.clone().addScaledVector(fwdAt(ci), (r() < 0.5 ? -1 : 1) * 7.5);
          pp.y += 1 + r() * 6;
          glowI.push(sprite(ci, pp, 3 + r() * 3, neon(pickNeon(), 1.1)));
        }
      }
    }
  }
  const ventEvery = (high ? 150 : 260) / step;
  for (let f = 40 / step; f < n; f += ventEvery * (0.6 + r() * 0.8)) {
    const i = wrap(f);
    if (lift[i] > 0.3) continue;
    const onRoad = r() < 0.6;
    const p = worldAt(route, i, (r() < 0.5 ? -1 : 1) * (onRoad ? 1 + r() * 2.5 : ROAD_HALF + 1 + r() * 2), onRoad ? 0.1 : 0.25);
    const c = nearestLightCol(p.x, p.z).multiplyScalar(0.035).add(new THREE.Color(0.05, 0.05, 0.06));
    const parts = high ? 14 : 8;
    for (let k = 0; k < parts; k++) steamI.push(sprite(i, p.clone(), 1.6 + r() * 0.8, c));
  }
  const spriteGeo = new THREE.PlaneGeometry(1, 1);
  for (const [items, mode, order] of [
    [hazeI, 'haze', 7],
    [glowI, 'glow', 3],
    [steamI, 'steam', 7],
  ] as const) {
    if (!items.length) continue;
    const g = chunkedInstances(route, spriteGeo, billboardMaterial(mode), items as Inst[], { shadow: false });
    g.traverse((o) => {
      o.renderOrder = order;
      o.userData.noAO = true;
      o.frustumCulled = false;
    });
    out.push(g);
  }

  // ---------------------------------------------------------------------
  // Distant skyline: very tall towers fading into the haze (outside and inside the loop)
  // ---------------------------------------------------------------------
  {
    const bins = 72;
    const rMax = new Float32Array(bins);
    const rMin = new Float32Array(bins).fill(1e9);
    for (let i = 0; i < n; i += 4) {
      const dx = route.x[i] - L.cx;
      const dz = route.z[i] - L.cz;
      const b = Math.floor(((Math.atan2(dz, dx) / (2 * Math.PI) + 1) % 1) * bins);
      const rr = Math.hypot(dx, dz);
      rMax[b] = Math.max(rMax[b], rr);
      rMin[b] = Math.min(rMin[b], rr);
    }
    const sky: Inst[] = [];
    const towers: THREE.Vector3[] = [];
    const place = (ang: number, rad: number, hgt: number, wid: number) => {
      const base = new THREE.Vector3(L.cx + Math.cos(ang) * rad, L.minY - 30, L.cz + Math.sin(ang) * rad);
      const rot = new THREE.Quaternion().setFromAxisAngle(UP, r() * Math.PI);
      const d = wid * (0.6 + r() * 0.6);
      sky.push({ i: 0, m: new THREE.Matrix4().compose(base, rot, new THREE.Vector3(wid, hgt + 30, d)), c: r() < 0.3 ? pickNeon().clone().multiplyScalar(0.15) : new THREE.Color(0, 0, 0) });
      if (hgt > 260) towers.push(base.clone().setY(L.minY + hgt));
      if (r() < 0.35) {
        const crown = base.clone().setY(L.minY + hgt - 2);
        sky.push({ i: 0, m: new THREE.Matrix4().compose(crown, rot, new THREE.Vector3(wid * 0.6, hgt * 0.18, d * 0.6)), c: new THREE.Color(0, 0, 0) });
      }
    };
    const outer = high ? 520 : 260;
    for (let k = 0; k < outer; k++) {
      const ang = r() * Math.PI * 2;
      const b = Math.floor((ang / (2 * Math.PI)) * bins) % bins;
      const rad = rMax[b] + 320 + Math.pow(r(), 0.8) * 2400;
      place(ang, rad, 110 + Math.pow(r(), 1.6) * 420, 26 + r() * 40);
    }
    const inner = high ? 160 : 80;
    for (let k = 0; k < inner; k++) {
      const ang = r() * Math.PI * 2;
      const b = Math.floor((ang / (2 * Math.PI)) * bins) % bins;
      const lim = rMin[b] - 300;
      if (lim < 200) continue;
      const rad = Math.pow(r(), 0.6) * lim;
      const core = 1 - rad / lim;
      place(ang, rad, 90 + core * 260 + Math.pow(r(), 1.5) * 240, 28 + r() * 40);
    }
    const skyG = new THREE.Group();
    const skyMesh = new THREE.InstancedMesh(boxGeo, buildingMaterial({ far: true, fogNear: 250, fogFar: 4200 }), sky.length);
    sky.forEach((it, k) => {
      skyMesh.setMatrixAt(k, it.m);
      skyMesh.setColorAt(k, it.c!);
    });
    skyMesh.computeBoundingSphere();
    skyG.add(skyMesh);
    // blinking red aviation lights on the tallest
    const apos = new Float32Array(towers.length * 3);
    towers.forEach((p, k) => apos.set([p.x, p.y + 2, p.z], k * 3));
    const ageo = new THREE.BufferGeometry();
    ageo.setAttribute('position', new THREE.BufferAttribute(apos, 3));
    const amat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { fxTime },
      vertexShader: /* glsl */ `
        uniform float fxTime;
        varying float vOn;
        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float ph = fract(sin(dot(position.xz, vec2(0.013, 0.027))) * 437.5);
          vOn = step(0.82, fract(fxTime * 0.5 + ph));
          gl_PointSize = 5.0;
        }`,
      fragmentShader: /* glsl */ `
        varying float vOn;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vec3(3.0, 0.15, 0.08) * smoothstep(0.5, 0.1, d) * (0.08 + vOn), 1.0);
        }`,
    });
    const apts = new THREE.Points(ageo, amat);
    apts.frustumCulled = false;
    skyG.add(apts);
    out.push(skyG);
  }

  // ---------------------------------------------------------------------
  // Wet road + sidewalks mirroring the lights, and the rain
  // ---------------------------------------------------------------------
  const ls = cityLightSet(route, lights, NL);
  const skyGlow = new THREE.Color('#3a1530').multiplyScalar(0.55);
  const amb = new THREE.Color(0.09, 0.07, 0.12);
  const roadMat = wetMaterial({ lights: ls, count: NL, skyGlow, ambient: amb, cross: crossTex, crossW: cellsW, crossH: cellsH });
  const road = new THREE.Mesh(
    ribbon(route, [-ROAD_HALF, ROAD_HALF], () => 0.05),
    roadMat,
  );
  road.frustumCulled = false;
  road.renderOrder = 1;
  road.onBeforeRender = (_r, _s, camera) => ls.refresh(camera);
  out.push(road);
  const swMat = wetMaterial({ lights: ls, count: Math.min(NL, 16), skyGlow: skyGlow.clone().multiplyScalar(0.6), ambient: amb, sidewalk: true });
  for (const side of [-1, 1]) {
    const offs = [4.55, 6.3, 7.95].map((o) => o * side);
    const offAt = (i: number, o: number) => {
      const t = (Math.abs(o) - 4.55) / 3.4;
      return Math.sign(o) * (EDGE + 0.12 + t * (sidewalkW(lift[i]) - 0.14));
    };
    const m = new THREE.Mesh(ribbon(route, offs, () => 0.17, offAt), swMat);
    m.renderOrder = 1;
    out.push(m);
  }
  out.push(buildRain({ count: high ? 7000 : 2200, lights: ls, nl: NL, ambient: new THREE.Color(0.05, 0.045, 0.07) }));

  // flat emissive facades and the wet road would only pick up noisy halos from the AO pass
  for (const o of out) o.traverse((c) => (c.userData.noAO = true));
  return out;
}
