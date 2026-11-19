// Rainy neon city: the shader effects. A wet, mirror-dark road that smears every
// nearby neon sign and street lamp into long rippling streaks, rain-drop rings and
// puddles; falling rain lit by the same lights; additive billboards for haze and
// street-vent steam; and the little CPU-side manager that picks the lights nearest
// the camera each frame and feeds them to the road and rain shaders.
import * as THREE from 'three';
import type { Route } from '../route';
import { fxBuild, fxSurge, fxTime } from '../fx';

// ---------------------------------------------------------------------------
// City lights (the reflection sources)
// ---------------------------------------------------------------------------
export interface CityLight {
  /** route sample nearest to the light (for the windowed search) */
  i: number;
  x: number;
  y: number;
  z: number;
  /** lateral half-width of the reflected streak (m) */
  w: number;
  /** linear colour × intensity */
  col: THREE.Color;
  /** 0 steady lamp, 1 neon sign (flicker by seed), 2 traffic signal (phase) */
  kind: 0 | 1 | 2;
  seed: number;
}

/** Shared GLSL: neon sign flicker. Mirrored exactly by `neonFlicker` below so reflections stay in sync. */
export const FLICKER_GLSL = /* glsl */ `
float neonFlicker(float seed, float t) {
  float buzz = 0.93 + 0.07 * sin(t * 61.0 + seed * 40.0);
  if (seed < 0.7) return buzz;
  float cyc = fract(t * (0.07 + seed * 0.05) + seed * 13.0);
  float bad = step(cyc, 0.24);
  float s = sin(t * 23.0 + seed * 40.0) + sin(t * 37.0 + seed * 17.0) + 1.2 * sin(t * 5.3 + seed * 3.0);
  float on = mix(1.0, step(-0.3, s) * 0.88 + 0.12, bad);
  return buzz * on;
}
/** Traffic signal cycle: which lamp (0 red, 1 amber, 2 green) is lit at time t for a phase offset. */
float signalState(float phase, float t) {
  float c = mod(t + phase, 24.0);
  return c < 11.0 ? 2.0 : (c < 14.0 ? 1.0 : 0.0);
}`;

export function neonFlicker(seed: number, t: number) {
  const fract = (x: number) => x - Math.floor(x);
  const buzz = 0.93 + 0.07 * Math.sin(t * 61 + seed * 40);
  if (seed < 0.7) return buzz;
  const cyc = fract(t * (0.07 + seed * 0.05) + seed * 13);
  const bad = cyc <= 0.24 ? 1 : 0;
  const s = Math.sin(t * 23 + seed * 40) + Math.sin(t * 37 + seed * 17) + 1.2 * Math.sin(t * 5.3 + seed * 3);
  const on = bad ? (s >= -0.3 ? 1 : 0) * 0.88 + 0.12 : 1;
  return buzz * on;
}

export function signalState(phase: number, t: number) {
  const c = (((t + phase) % 24) + 24) % 24;
  return c < 11 ? 2 : c < 14 ? 1 : 0;
}

export const SIGNAL_COLORS = [new THREE.Color('#ff2a1a'), new THREE.Color('#ffa21a'), new THREE.Color('#29ff9a')];

/**
 * Uniforms holding the nearest `count` lights to the camera, refreshed by `refresh(camera)`
 * (called from the road's onBeforeRender, once per rendered frame).
 */
export function cityLightSet(route: Route, lights: CityLight[], count: number) {
  lights.sort((a, b) => a.i - b.i);
  const n = route.x.length;
  const pos = Array.from({ length: count }, () => new THREE.Vector4());
  const col = Array.from({ length: count }, () => new THREE.Vector4());
  const uniforms = { uLP: { value: pos }, uLC: { value: col } };
  // index of the first light at or after each route sample (for windowed lookups)
  const first = new Int32Array(n + 1);
  for (let s = 0, k = 0; s <= n; s++) {
    while (k < lights.length && lights[k].i < s) k++;
    first[s] = k;
  }
  let camI = 0;
  let lastFrame = -1;
  const cand: { l: CityLight; d: number }[] = [];
  const RANGE = 230;
  const tmp = new THREE.Color();
  const refresh = (camera: THREE.Camera) => {
    const t = fxTime.value;
    if (t === lastFrame) return;
    lastFrame = t;
    const cx = camera.position.x;
    const cz = camera.position.z;
    // track the nearest route sample (local search; full search if lost)
    let best = Infinity;
    let bi = camI;
    for (let d = -80; d <= 80; d++) {
      const i = (camI + d + n) % n;
      const dd = (route.x[i] - cx) ** 2 + (route.z[i] - cz) ** 2;
      if (dd < best) {
        best = dd;
        bi = i;
      }
    }
    if (best > 400 * 400) {
      for (let i = 0; i < n; i++) {
        const dd = (route.x[i] - cx) ** 2 + (route.z[i] - cz) ** 2;
        if (dd < best) {
          best = dd;
          bi = i;
        }
      }
    }
    camI = bi;
    cand.length = 0;
    const back = Math.round(70 / route.step);
    const ahead = Math.round(RANGE / route.step);
    for (let s = camI - back; s <= camI + ahead; s++) {
      const ss = ((s % n) + n) % n;
      for (let k = first[ss]; k < first[ss + 1]; k++) {
        const l = lights[k];
        const d = Math.hypot(l.x - cx, l.z - cz);
        if (d < RANGE) cand.push({ l, d });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    for (let k = 0; k < count; k++) {
      const c = cand[k];
      if (!c) {
        col[k].set(0, 0, 0, 0);
        pos[k].set(0, -1000, 0, 1);
        continue;
      }
      const l = c.l;
      let f = 1;
      if (l.kind === 1) f = neonFlicker(l.seed, t);
      tmp.copy(l.col);
      if (l.kind === 2) tmp.copy(SIGNAL_COLORS[signalState(l.seed, t)]).multiplyScalar(l.col.r);
      // fade out towards the range limit, and towards the end of the list, so lights never pop
      const fade = (1 - THREE.MathUtils.smoothstep(c.d, RANGE * 0.6, RANGE)) * (1 - THREE.MathUtils.smoothstep(k, count * 0.75, count));
      pos[k].set(l.x, l.y, l.z, l.w);
      col[k].set(tmp.r * f * fade, tmp.g * f * fade, tmp.b * f * fade, 1);
    }
  };
  return { uniforms, refresh };
}

// ---------------------------------------------------------------------------
// GLSL helpers
// ---------------------------------------------------------------------------
export const NOISE_GLSL = /* glsl */ `
float nHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float nNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(nHash(i), nHash(i + vec2(1.0, 0.0)), u.x), mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

export const FOG_GLSL = /* glsl */ `
float cityFog() {
  #ifdef USE_FOG
    return smoothstep(fogNear, fogFar, vFogDepth);
  #else
    return 0.0;
  #endif
}`;

// ---------------------------------------------------------------------------
// Wet road (and wet sidewalks)
// ---------------------------------------------------------------------------
export interface WetOpts {
  lights: ReturnType<typeof cityLightSet>;
  count: number;
  skyGlow: THREE.Color;
  ambient: THREE.Color;
  /** crosswalk mask: one texel per 2 m of road (R channel) */
  cross?: THREE.DataTexture;
  crossW?: number;
  crossH?: number;
  sidewalk?: boolean;
}

export function wetMaterial(o: WetOpts): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    fog: true,
    defines: { NL: o.count, ...(o.sidewalk ? { SIDEWALK: 1 } : {}), ...(o.cross ? { CROSS: 1 } : {}) },
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uSky: { value: o.skyGlow },
      uAmb: { value: o.ambient },
      uCross: { value: o.cross ?? null },
      uCrossSize: { value: new THREE.Vector2(o.crossW ?? 1, o.crossH ?? 1) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime, fxBuild, fxSurge;
      uniform vec4 uLP[NL];
      uniform vec4 uLC[NL];
      uniform vec3 uSky, uAmb;
      uniform sampler2D uCross;
      uniform vec2 uCrossSize;
      varying vec3 vW;
      varying vec2 vUv;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      float band(float x, float c, float hw) {
        float fw = fwidth(x);
        return 1.0 - smoothstep(hw - fw, hw + fw, abs(x - c));
      }
      // expanding rain-drop rings: xy = normal tilt, z = ring brightness
      vec3 rings(vec2 p, float t) {
        vec3 acc = vec3(0.0);
        for (int L = 0; L < 2; L++) {
          vec2 q = p * 2.2 + float(L) * vec2(0.37, 0.71);
          vec2 id = floor(q);
          float h = nHash(id + float(L) * 17.0);
          vec2 c = vec2(nHash(id + 3.1), nHash(id + 7.7)) * 0.4 + 0.3;
          vec2 f = fract(q) - c;
          float age = fract(t * (0.9 + 0.5 * h) + h * 11.0);
          float r = age * 0.38;
          float d = length(f);
          float x = (d - r) / 0.03;
          float ring = exp(-x * x) * (1.0 - age) * (1.0 - age) * step(0.45, h);
          acc.xy += f / max(d, 1e-3) * ring * sin(x * 2.0);
          acc.z += ring;
        }
        return acc;
      }
      void main() {
        vec3 V = cameraPosition - vW;
        float dist = length(V);
        vec3 v = V / dist;
        float t = fxTime;

        // puddles (smoother, darker, sharper mirror) and asphalt grain
        float pn = nNoise(vW.xz * 0.16) * 0.6 + nNoise(vW.xz * 0.5 + 3.1) * 0.4;
        #ifdef SIDEWALK
          float puddle = smoothstep(0.6, 0.66, pn) * 0.8;
        #else
          float puddle = smoothstep(0.5, 0.57, pn);
        #endif
        float grain = nHash(floor(vW.xz * 37.0));
        float near = 1.0 - smoothstep(8.0, 30.0, dist);
        vec3 rp = rings(vW.xz, t) * near;
        vec2 wob = vec2(nNoise(vW.xz * 1.2 + vec2(0.0, t * 0.7)), nNoise(vW.xz * 1.2 + 7.0 - vec2(t * 0.6, 0.0))) - 0.5;
        float rough = mix(1.0, 0.4, puddle);
        vec2 P = vW.xz + wob * mix(0.5, 0.12, puddle) + rp.xy * 0.12 + (grain - 0.5) * 0.05 * rough;

        // albedo: near-black asphalt with faint wet paint
        float x = vUv.x;
        float s = vUv.y;
        #ifdef SIDEWALK
          vec2 tile = vec2(abs(x) * 1.6, s * 1.6);
          float joint = max(band(fract(tile.x), 0.5, 0.03), band(fract(tile.y), 0.5, 0.03));
          float alb = mix(0.07, 0.035, joint) * (0.8 + 0.4 * grain);
          float curb = band(abs(x), 4.65, 0.12);
          alb = mix(alb, 0.12, curb);
        #else
          float ax = abs(x);
          float paint = band(ax, 4.05, 0.07);
          paint = max(paint, band(x, 0.0, 0.06) * step(fract(s / 9.0), 0.45));
          #ifdef CROSS
            float ci = floor(s / 2.0);
            vec2 cuv = vec2(mod(ci, uCrossSize.x) + 0.5, floor(ci / uCrossSize.x) + 0.5) / uCrossSize;
            float cw = texture2D(uCross, cuv).r;
            paint = max(paint, cw * step(0.5, fract(x / 1.1)) * step(ax, 3.9));
          #endif
          float alb = mix(0.045 * (0.75 + 0.5 * grain), 0.45, paint * 0.7);
        #endif
        alb *= mix(1.0, 0.55, puddle);

        // reflections of every nearby light: a streak along the line from the light's foot
        // towards the viewer, centred on the mirror point, smeared by the wet roughness
        vec2 C = cameraPosition.xz;
        float hc = max(cameraPosition.y - vW.y, 0.3);
        vec3 refl = vec3(0.0);
        vec3 pool = vec3(0.0);
        for (int k = 0; k < NL; k++) {
          vec3 lc = uLC[k].rgb;
          if (lc.r + lc.g + lc.b < 1e-4) continue;
          vec4 L = uLP[k];
          float h = max(L.y - vW.y, 0.4);
          vec2 FC = C - L.xz;
          float lenFC = length(FC) + 1e-3;
          vec2 a = FC / lenFC;
          vec2 D = P - L.xz;
          float along = dot(D, a);
          float perp = dot(D, vec2(-a.y, a.x));
          float tp = lenFC * h / (h + hc);
          float w = L.w * (0.55 + 0.4 * rough) + 0.005 * max(along, 0.0) * rough;
          float lat = exp(-perp * perp / (w * w));
          lat *= 0.35 + 1.1 * nNoise(vec2(along * 1.6, perp * 3.0 + float(k) * 7.3));
          float spread = (tp * 0.6 + 1.5 + h * 0.5) * (0.6 + 0.4 * rough);
          float da = (along - tp) / spread;
          float lon = exp(-da * da) * smoothstep(-0.5, 1.5, along);
          refl += lc * lat * lon;
          float dd = dot(vW.xz - L.xz, vW.xz - L.xz);
          pool += lc * exp(-dd / (h * h * 0.6)) / (1.0 + h * 0.3);
        }
        float cosv = clamp(v.y, 0.0, 1.0);
        float fres = 0.05 + 0.95 * pow(1.0 - cosv, 5.0);
        #ifdef SIDEWALK
          float gloss = mix(0.35, 0.9, puddle);
        #else
          float gloss = mix(0.6, 1.2, puddle);
        #endif
        vec3 col = alb * (uAmb + pool * 0.12);
        col += uSky * fres * gloss;
        // keep the mirror from blowing out right under the rider
        refl = refl / (1.0 + 0.12 * dot(refl, vec3(0.333)));
        // the street comes alive as you push: reflections intensify with effort
        col += refl * 0.3 * gloss * (0.35 + 0.65 * fres) * (1.0 + 0.9 * fxBuild + 0.7 * fxSurge);
        // ring rims catch the sky glow and the lights
        col += rp.z * (uSky * 0.5 + pool * 0.03 + refl * 0.12) * (0.3 + puddle);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  mat.uniforms.fxBuild = fxBuild;
  mat.uniforms.fxSurge = fxSurge;
  mat.uniforms.uLP = o.lights.uniforms.uLP;
  mat.uniforms.uLC = o.lights.uniforms.uLC;
  return mat;
}

/** A ribbon along the route between lateral offsets [o0, o1] at height dy(i, off) above the centreline. */
export function ribbon(route: Route, offs: number[], dy: (i: number, off: number) => number, offAt?: (i: number, off: number) => number): THREE.BufferGeometry {
  const n = route.x.length;
  const cols = offs.length;
  const pos = new Float32Array((n + 1) * cols * 3);
  const uv = new Float32Array((n + 1) * cols * 2);
  const idx: number[] = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    const h = route.heading[i];
    for (let c = 0; c < cols; c++) {
      const off = offAt ? offAt(i, offs[c]) : offs[c];
      const o = (k * cols + c) * 3;
      pos[o] = route.x[i] - Math.sin(h) * off;
      pos[o + 1] = route.y[i] + dy(i, off);
      pos[o + 2] = route.z[i] + Math.cos(h) * off;
      uv[(k * cols + c) * 2] = offs[c];
      uv[(k * cols + c) * 2 + 1] = k * route.step;
    }
    if (k < n) {
      for (let c = 0; c < cols - 1; c++) {
        const a = k * cols + c;
        const b = a + cols;
        if (offs[c + 1] > offs[c]) idx.push(a, a + 1, b, a + 1, b + 1, b);
        else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Rain: slanted streaks in a box that follows the camera, lit by the nearest lights
// ---------------------------------------------------------------------------
export function buildRain(o: { count: number; lights: ReturnType<typeof cityLightSet>; nl: number; ambient: THREE.Color }): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(o.count * 4);
  for (let k = 0; k < o.count * 4; k++) seeds[k] = Math.random();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = o.count;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    defines: { NL: o.nl, NLR: Math.min(o.nl, 12) },
    uniforms: {
      uBox: { value: new THREE.Vector3(34, 16, 34) },
      uAmb: { value: o.ambient },
      uPx: { value: 0.0012 },
    },
    vertexShader: /* glsl */ `
      uniform float fxTime;
      uniform vec3 uBox;
      uniform vec3 uAmb;
      uniform float uPx;
      uniform vec4 uLP[NL];
      uniform vec4 uLC[NL];
      attribute vec4 aSeed;
      varying vec2 vQ;
      varying vec3 vCol;
      void main() {
        float speed = 8.5 + aSeed.w * 3.5;
        vec3 vel = vec3(1.3, -speed, 0.7);
        vec3 half_ = uBox * 0.5;
        vec3 p = aSeed.xyz * uBox + vel * fxTime;
        p = mod(p - cameraPosition + half_, uBox) - half_ + cameraPosition;
        vec3 axis = normalize(vel);
        float len = 0.45 + aSeed.w * 0.5;
        vec3 toCam = cameraPosition - p;
        float dist = length(toCam);
        vec3 side = normalize(cross(axis, toCam / max(dist, 1e-3)));
        float w0 = 0.007 + aSeed.y * 0.006;
        float w = max(w0, dist * uPx);
        vec3 wp = p + axis * (position.y - 0.5) * len + side * position.x * w;
        vQ = position.xy;
        // lit by the city: ambient glow plus the nearest lamps and signs
        vec3 c = uAmb;
        for (int k = 0; k < NLR; k++) {
          vec3 d = uLP[k].xyz - p;
          c += uLC[k].rgb / (1.0 + dot(d, d) * 0.06);
        }
        vec3 q = abs(p - cameraPosition) / half_;
        float fade = (1.0 - smoothstep(0.65, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(0.6, 2.2, dist);
        vCol = c * fade * (w0 / w) * 0.55;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vQ;
      varying vec3 vCol;
      void main() {
        float a = sin(3.14159 * vQ.y) * (1.0 - abs(vQ.x) * 2.0);
        gl_FragColor = vec4(vCol * a * a, 1.0);
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  mat.uniforms.uLP = o.lights.uniforms.uLP;
  mat.uniforms.uLC = o.lights.uniforms.uLC;
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 6;
  m.userData.noAO = true;
  return m;
}

// ---------------------------------------------------------------------------
// Additive billboards: haze glows between buildings, distant street glows, vent steam
// ---------------------------------------------------------------------------
export function billboardMaterial(mode: 'haze' | 'steam' | 'glow'): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: true,
    defines: { [mode.toUpperCase()]: 1 },
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) },
    vertexShader: /* glsl */ `
      uniform float fxTime;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vA;
      varying float vSeed;
      #include <fog_pars_vertex>
      float bHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      void main() {
        vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float s = length(instanceMatrix[0].xyz);
        float seed = bHash(c.xz * 0.731);
        vSeed = seed;
        vA = 1.0;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        #ifdef STEAM
          float life = fract(fxTime * (0.16 + 0.08 * seed) + float(gl_InstanceID) * 0.618);
          float sd = bHash(vec2(float(gl_InstanceID), seed));
          c.y += life * (4.0 + 2.5 * sd);
          c.x += sin(fxTime * 0.7 + sd * 20.0) * life * 1.2 + life * 0.9;
          c.z += cos(fxTime * 0.5 + sd * 13.0) * life * 1.0;
          s *= 0.5 + life * 2.2;
          vA = smoothstep(0.0, 0.15, life) * (1.0 - life) * (1.0 - life);
          vSeed = sd;
        #endif
        #ifdef HAZE
          vA = 0.75 + 0.25 * sin(fxTime * 0.2 + seed * 30.0);
          c.x += sin(fxTime * 0.05 + seed * 9.0) * 2.0;
        #endif
        vec3 wp = c + (right * position.x + up * position.y) * s;
        vUv = uv;
        vCol = instanceColor;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        float dist = -mvPosition.z;
        // fade as the camera flies into a big sprite
        vA *= smoothstep(s * 0.15, s * 0.7, dist);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vA;
      varying float vSeed;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      ${FOG_GLSL}
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        #ifdef GLOW
          float a = exp(-r * r * 9.0) * 1.4 + exp(-r * r * 2.5) * 0.25;
        #else
          float n = nNoise(vUv * 3.0 + vSeed * 17.0 + vec2(0.0, fxTime * 0.05)) * 0.6 + nNoise(vUv * 7.0 - vSeed * 5.0) * 0.4;
          float a = smoothstep(1.0, 0.0, r) * (0.4 + 0.9 * n);
          a *= a;
        #endif
        vec3 col = vCol * a * vA * (1.0 - cityFog() * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  mat.uniforms.fxTime = fxTime;
  return mat;
}
