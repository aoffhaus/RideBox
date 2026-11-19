// Shared, shader-level effects layered onto any theme's materials:
//  - drifting cloud shadows (world-space noise that dims direct sunlight)
//  - wind sway for foliage (materials opt in with `windy(mat, height, amp)`)
// plus a dust-mote particle field. One global time uniform drives everything,
// so the per-frame cost is a single uniform update.
import * as THREE from 'three';

/** Seconds since start; updated once per frame by the world view. */
export const fxTime = { value: 0 };
/** Sustained-effort level 0..1 (see effort.ts): slow to build, slow to relax. */
export const fxBuild = { value: 0 };
/** Sprint surge 0..1: near-instant attack, fades over a few seconds. */
export const fxSurge = { value: 0 };

export interface WindParams {
  /** Local-space height (m) of the top of the plant: sway grows with (y / height)^2. */
  height: number;
  /** Sway at the top, in local units. */
  amp: number;
}

/** Mark a foliage material to sway in the wind (picked up by `applyWorldFx`). */
export function windy<T extends THREE.Material>(mat: T, height: number, amp: number): T {
  mat.userData.wind = { height, amp } satisfies WindParams;
  return mat;
}

export interface WorldFxOptions {
  /** Cloud-shadow strength 0..1 (0 = off): how much direct sunlight is blocked under a cloud. */
  cloudShadows: number;
  /** Wind on/off (foliage materials must also be marked with `windy`). */
  wind: boolean;
}

const NOISE = /* glsl */ `
uniform float fxTime;
uniform float fxBuild;
uniform float fxSurge;
varying vec3 vFxWorld;
float fxHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fxNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const patched = new WeakSet<THREE.Material>();

type LitMaterial = THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshStandardMaterial;
function isLit(m: THREE.Material): m is LitMaterial {
  const t = m as Partial<Record<'isMeshLambertMaterial' | 'isMeshPhongMaterial' | 'isMeshStandardMaterial', boolean>>;
  return !!(t.isMeshLambertMaterial || t.isMeshPhongMaterial || t.isMeshStandardMaterial);
}

/** Patch one lit material with cloud shadows and (if marked) wind. Idempotent. */
function patchMaterial(mat: THREE.Material, opts: WorldFxOptions) {
  if (patched.has(mat) || !isLit(mat)) return;
  const wind = opts.wind ? (mat.userData.wind as WindParams | undefined) : undefined;
  const clouds = opts.cloudShadows;
  if (!wind && clouds <= 0) return;
  patched.add(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.fxTime = fxTime;
    shader.uniforms.fxBuild = fxBuild;
    shader.uniforms.fxSurge = fxSurge;
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${NOISE}`);
    if (wind) {
      vs = vs.replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 fxRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            vec3 fxRoot = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float fxH = clamp(position.y / ${wind.height.toFixed(3)}, 0.0, 1.5);
          fxH *= fxH;
          // a broad gust front rolling across the landscape + a quicker per-plant flutter
          float gust = 0.55 + 0.45 * sin(dot(fxRoot.xz, vec2(0.021, 0.013)) - fxTime * 0.9);
          float sway = sin(fxTime * 1.7 + fxRoot.x * 0.37 + fxRoot.z * 0.23) * 0.7 + sin(fxTime * 3.1 + fxRoot.z * 0.51) * 0.3;
          // the wind picks up as a sustained effort builds, and whips on a sprint
          float a = ${wind.amp.toFixed(3)} * fxH * (0.35 + gust) * sway * (1.0 + 1.8 * fxBuild + 0.9 * fxSurge);
          transformed.x += a;
          transformed.z += a * 0.6 * sin(fxTime * 1.3 + fxRoot.x);
        }`,
      );
    }
    vs = vs.replace(
      '#include <project_vertex>',
      /* glsl */ `#include <project_vertex>
      {
        vec4 fxW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          fxW = instanceMatrix * fxW;
        #endif
        vFxWorld = (modelMatrix * fxW).xyz;
      }`,
    );
    shader.vertexShader = vs;
    if (clouds > 0) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${NOISE}`)
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `#include <lights_fragment_end>
          {
            // two octaves of value noise, drifting with the wind; thresholded into cloud patches
            vec2 cp = vFxWorld.xz / 420.0 + vec2(fxTime * 0.011, fxTime * 0.006);
            float c = fxNoise(cp) * 0.65 + fxNoise(cp * 2.3 + 7.1) * 0.35;
            // cloud cover thickens as a long effort builds: the sky turns moodier
            float cover = 0.52 - 0.14 * fxBuild;
            float shade = smoothstep(cover, cover + 0.16, c) * ${clouds.toFixed(3)} * (1.0 + 0.35 * fxBuild);
            reflectedLight.directDiffuse *= 1.0 - shade;
            reflectedLight.directSpecular *= 1.0 - shade;
          }`,
        );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vFxWorld;`);
    }
  };
  const key = `fx:${clouds.toFixed(2)}:${wind ? `${wind.height}:${wind.amp}` : '-'}`;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + key;
  mat.needsUpdate = true;
}

/** Apply cloud shadows / wind to every lit material under `root`. */
export function applyWorldFx(root: THREE.Object3D, opts: WorldFxOptions) {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) patchMaterial(m, opts);
  });
}

/**
 * Additive "breathing" for light-shaft materials: each instance's opacity drifts slowly
 * so shafts brighten and fade as if clouds and branches pass in front of the sun.
 */
export function breathingShafts(mat: THREE.MeshBasicMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.fxTime = fxTime;
    shader.uniforms.fxBuild = fxBuild;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float fxTime;\nuniform float fxBuild;\nvarying float vBreath;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 fxRoot = instanceMatrix[3].xyz;
        #else
          vec3 fxRoot = vec3(0.0);
        #endif
        vBreath = (0.35 + 0.65 * pow(0.5 + 0.5 * sin(fxTime * 0.35 + fxRoot.x * 0.11 + fxRoot.z * 0.07), 2.0)) * (1.0 + 1.4 * fxBuild);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBreath;')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vBreath;\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'breathing-shafts';
  return mat;
}

/**
 * Floating dust / pollen motes in a box that follows the camera (positions wrap in the
 * shader, so it costs one draw call and no per-frame CPU work). Warm, additive, soft.
 */
export function buildDustMotes(opts: { count: number; box: number; color: string; size: number; opacity: number }): THREE.Points {
  const n = opts.count;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    pos[k * 3] = Math.random() * opts.box;
    pos[k * 3 + 1] = Math.random() * opts.box * 0.5;
    pos[k * 3 + 2] = Math.random() * opts.box;
    seed[k] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      fxTime,
      fxBuild,
      box: { value: opts.box },
      color: { value: new THREE.Color(opts.color) },
      size: { value: opts.size },
      opacity: { value: opts.opacity },
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float fxTime; uniform float fxBuild; uniform float box; uniform float size; uniform float pixelRatio;
      attribute float seed;
      varying float vFade;
      void main(){
        vec3 drift = vec3(sin(fxTime * 0.21 + seed * 40.0) * 1.6, fxTime * (0.08 + seed * 0.12), cos(fxTime * 0.17 + seed * 23.0) * 1.6);
        vec3 half_ = vec3(box * 0.5, box * 0.25, box * 0.5);
        vec3 p = mod(position + drift - cameraPosition + half_, vec3(box, box * 0.5, box)) - half_ + cameraPosition;
        p.y -= box * 0.08; // bias the slab toward the ground the rider sees
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        // fade at the box edges (no popping as motes wrap) and very close to the lens
        vec3 q = abs(p - cameraPosition) / half_;
        vFade = (1.0 - smoothstep(0.6, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(0.5, 2.0, dist);
        vFade *= 0.55 + 0.45 * sin(fxTime * (0.8 + seed) + seed * 17.0); // twinkle as they turn in the light
        vFade *= 1.0 + 1.2 * fxBuild;
        gl_PointSize = size * pixelRatio * (40.0 / max(dist, 0.5));
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color; uniform float opacity;
      varying float vFade;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(color * a * vFade * opacity, 1.0);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return pts;
}
