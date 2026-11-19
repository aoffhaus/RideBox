// Kyoto in cherry-blossom season: a paved path beside a narrow stone-walled canal,
// lined with sakura whose billowy pink canopies meet overhead. Petals tumble through
// the air and drift on the verges and the water. Stone lanterns glow along the path,
// small bridges cross the canal, vermilion torii span the road (with one tunnel of
// many small gates), wooden machiya houses sit back from the road, and cedar-dark
// hills dotted with pink rise behind, a pagoda on a distant hilltop.
import * as THREE from 'three';
import type { Route } from '../route';
import {
  EDGE,
  buildTerrainMesh,
  canvasTex,
  chunkedInstances,
  lodInstances,
  type LodLevel,
  clampOff,
  detailTex,
  lapWave,
  lerp,
  loopDelta,
  loopInfo,
  merge,
  radialTex,
  rng,
  smooth,
  worldAt,
  jitterAlong,
  type Inst,
  type TerrainModel,
} from './common';
import type { ThemeBuildOptions } from './index';
import { fxBuild, fxSurge, fxTime, windy } from '../fx';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const VERMILION = '#d8401f';
const PETAL_PALE = '#fde6ee';
const PETAL_ROSE = '#f2a6be';

export function kyotoRoad() {
  // pale, warm stone-paved path: no centre line, petals gathered towards the edges
  return canvasTex(256, 512, (g) => {
    g.fillStyle = '#a49d93';
    g.fillRect(0, 0, 256, 512);
    const r = rng(77);
    for (let i = 0; i < 9000; i++) {
      const v = 125 + r() * 70;
      g.fillStyle = `rgba(${v + 6},${v},${v - 8},0.55)`;
      g.fillRect(r() * 256, r() * 512, 1.6, 1.6);
    }
    // faint paving joints
    g.strokeStyle = 'rgba(70,64,58,0.22)';
    g.lineWidth = 1.5;
    for (let y = 0; y < 512; y += 64) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(256, y);
      g.stroke();
      const off = (y / 64) % 2 ? 0 : 32;
      for (let x = off; x < 256; x += 64) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + 64);
        g.stroke();
      }
    }
    // soft worn wheel tracks
    g.fillStyle = 'rgba(60,55,50,0.07)';
    for (const x of [70, 170]) g.fillRect(x, 0, 18, 512);
    // stone kerb edges
    g.fillStyle = '#8a8378';
    g.fillRect(0, 0, 7, 512);
    g.fillRect(249, 0, 7, 512);
    // petals: dense drifts at the kerbs, a sprinkle across the middle
    const pinks = ['#f7d3dd', '#f3bccb', '#fbe4ea', '#eaa9bd', '#f9dbe3'];
    for (let i = 0; i < 2600; i++) {
      const edge = r() < 0.75;
      const side = r() < 0.5 ? 0 : 1;
      const x = edge ? (side ? 256 - Math.pow(r(), 2.2) * 70 : Math.pow(r(), 2.2) * 70) : r() * 256;
      const y = r() * 512;
      g.fillStyle = pinks[Math.floor(r() * pinks.length)];
      g.save();
      g.translate(x, y);
      g.rotate(r() * Math.PI);
      g.beginPath();
      g.ellipse(0, 0, 1.0 + r() * 0.9, 0.6 + r() * 0.45, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
/** Tube along a smooth curve whose radius tapers from r0 to r1. */
function taperTube(pts: THREE.Vector3[], r0: number, r1: number, seg = 8, rad = 6) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
  const pos = g.attributes.position;
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let j = 0; j <= seg; j++) {
    curve.getPointAt(j / seg, c);
    const rr = lerp(r0, r1, j / seg);
    for (let k = 0; k <= rad; k++) {
      const idx = j * (rad + 1) + k;
      v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(rr).add(c);
      pos.setXYZ(idx, v.x, v.y, v.z);
    }
  }
  g.deleteAttribute('uv');
  return g;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Dark, twisted cherry trunk leaning towards +x, forking into branches that reach into the canopy.
 * `far`: just a coarse main stem (the branches are hidden in the canopy at a distance).
 */
function sakuraTrunk(seed: number, far = false) {
  const r = rng(seed);
  const j = () => (r() - 0.5) * 0.5;
  const stem = [V(0, -0.3, 0), V(0.25 + j(), 1.1, 0.15), V(0.8, 2.2, -0.2 + j()), V(1.5, 3.2, 0.1)];
  if (far) return taperTube(stem, 0.34, 0.22, 3, 4);
  const parts = [
    taperTube(stem, 0.34, 0.22, 10, 7),
    taperTube([V(1.5, 3.1, 0.1), V(2.6, 4.0, 0.8 + j()), V(3.8, 5.2, 1.4)], 0.2, 0.06, 6, 5),
    taperTube([V(1.4, 3.1, 0.0), V(1.9 + j(), 4.3, -1.0), V(2.4, 5.7, -1.8)], 0.19, 0.06, 6, 5),
    taperTube([V(1.3, 3.0, 0.1), V(0.9, 4.2, 0.9 + j()), V(0.4, 5.4, 1.1)], 0.17, 0.05, 6, 5),
    taperTube([V(1.0, 2.6, -0.1), V(2.6, 3.4, -0.4 + j()), V(4.4, 4.3, -0.2), V(5.6, 5.0, 0.2)], 0.16, 0.05, 8, 5),
  ];
  return merge(parts);
}

/** Radius boost per icosahedron detail so coarse lobes cover about as much as fine ones. */
const COARSE_GROW: Record<number, number> = { 0: 1.12 };

const PALE = new THREE.Color('#fff1f5');
const MID = new THREE.Color('#f8c9d7');
const DEEP = new THREE.Color('#dc8aa6');

/**
 * Billowy canopy: soft, lumpy lobes in an umbrella-shaped cloud, pale on top, deeper rose beneath.
 * `N` outer lobes (plus a crown); fewer, fatter lobes fill the same umbrella for distant trees.
 */
function sakuraCanopy(seed: number, detail: number, N = 20) {
  const r = rng(seed);
  const cx = 2.3;
  const cy = 6.0;
  const lobes: THREE.BufferGeometry[] = [];
  const fat = Math.pow(20 / N, 0.3); // fewer lobes: fatter ones, pulled in so the outline stays put
  const grow = COARSE_GROW[detail] ?? 1; // a coarse icosahedron sits inside its sphere
  for (let k = 0; k <= N; k++) {
    let x: number, y: number, z: number, rad: number;
    if (k === N) {
      x = cx;
      y = cy + 1.1;
      z = 0;
      rad = 2.2;
    } else {
      const th = (k / N) * Math.PI * 2 * 1.9 + r() * 0.6;
      const rf = 0.25 + 0.75 * Math.sqrt(r());
      y = cy + (1 - rf) * 1.4 + (r() - 0.5) * 0.8 - rf * rf * 0.8;
      rad = 1.95 - rf * 0.55 + r() * 0.3;
      const pull = Math.max(0.3, 1 - (rad * (fat - 1)) / (4.6 * rf));
      x = cx + Math.cos(th) * 4.6 * rf * pull;
      z = Math.sin(th) * 4.1 * rf * pull;
      rad *= fat;
    }
    rad *= grow;
    const squash = k === N ? 1 : fat; // fat lobes widen, but keep the canopy's height
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const ph = r() * 10;
    const tone = r();
    const d = new THREE.Vector3();
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v++) {
      d.fromBufferAttribute(pos, v).normalize();
      // lumpy surface (a function of direction only, so shared corners stay welded)
      const bump = 1 + 0.09 * Math.sin(d.x * 6.1 + ph) * Math.sin(d.y * 5.3 + ph * 0.7) * Math.sin(d.z * 6.7 + ph * 1.3) + 0.06 * Math.sin(d.x * 13 + d.z * 11 + ph);
      let py = (d.y * rad * bump) / squash;
      if (d.y < 0) py *= 0.72; // flatter underside
      pos.setXYZ(v, x + d.x * rad * bump, y + py, z + d.z * rad * bump);
      // soft normals: bent upwards so the canopy reads as one luminous mass
      const n = d.clone().add(V(0, 0.45, 0)).normalize();
      nor.setXYZ(v, n.x, n.y, n.z);
      // colour: pale blush on top, deeper rose underneath and inside
      const top = THREE.MathUtils.clamp(0.5 + 0.5 * d.y + (y - cy) * 0.12, 0, 1);
      c.copy(DEEP).lerp(MID, smooth(0.0, 0.55, top)).lerp(PALE, smooth(0.5, 1.0, top));
      c.multiplyScalar(0.94 + tone * 0.1);
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    lobes.push(g);
  }
  return merge(lobes);
}

/** Canopy material: per-vertex pinks × per-tree tint, with a 3D blossom-cluster speckle and soft translucency. */
function canopyMaterial() {
  const mat = windy(new THREE.MeshLambertMaterial({ vertexColors: true }), 8, 0.22);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vSkPos;
        float skHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float skNoise(vec3 x){
          vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(skHash(i), skHash(i + vec3(1,0,0)), f.x), mix(skHash(i + vec3(0,1,0)), skHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(skHash(i + vec3(0,0,1)), skHash(i + vec3(1,0,1)), f.x), mix(skHash(i + vec3(0,1,1)), skHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          float sk = skNoise(vSkPos * 1.6) * 0.55 + skNoise(vSkPos * 4.3) * 0.3 + skNoise(vSkPos * 11.0) * 0.15;
          diffuseColor.rgb *= mix(0.84, 1.1, sk);
          // fine flower-cluster grain: tiny pale florets and darker gaps
          float fine = skNoise(vSkPos * 15.0 + 2.3);
          diffuseColor.rgb *= 0.92 + 0.14 * fine;
        }`,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.22; // light glowing through the petals`,
      );
  };
  mat.customProgramCacheKey = () => 'kyoto-sakura-canopy';
  return mat;
}

/** Bend a geometry built along +z (0..span) into an arch of the given rise. */
function arch(g: THREE.BufferGeometry, span: number, rise: number) {
  const p = g.attributes.position;
  for (let v = 0; v < p.count; v++) p.setY(v, p.getY(v) + rise * Math.sin((Math.PI * p.getZ(v)) / span));
  g.computeVertexNormals();
  return g;
}

/** Myōjin-style torii, spanning ±5.5 m on x, ~8.4 m tall. */
function toriiGeos() {
  const red: THREE.BufferGeometry[] = [];
  const black: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    red.push(new THREE.CylinderGeometry(0.34, 0.4, 7.6, 12).translate(sx * 5.5, 3.8, 0));
    black.push(new THREE.CylinderGeometry(0.47, 0.5, 0.8, 12).translate(sx * 5.5, 0.4, 0));
  }
  red.push(new THREE.BoxGeometry(13.4, 0.5, 0.32).translate(0, 5.8, 0)); // nuki
  red.push(new THREE.BoxGeometry(0.5, 1.0, 0.3).translate(0, 6.55, 0)); // gakuzuka
  red.push(new THREE.BoxGeometry(13.8, 0.46, 0.52).translate(0, 7.3, 0)); // shimaki
  const kasagi = new THREE.BoxGeometry(15.6, 0.55, 0.66, 24, 1, 1);
  const p = kasagi.attributes.position;
  for (let v = 0; v < p.count; v++) p.setY(v, p.getY(v) + 0.8 * Math.pow(Math.abs(p.getX(v)) / 7.8, 3));
  kasagi.computeVertexNormals();
  black.push(kasagi.translate(0, 7.8, 0));
  return { red: merge(red), black: merge(black) };
}

/** Stone tōrō lantern (~2.3 m) and the glowing light box inside its fire chamber. */
function lanternGeos() {
  const stone = [
    new THREE.CylinderGeometry(0.42, 0.48, 0.22, 6).translate(0, 0.11, 0),
    new THREE.CylinderGeometry(0.15, 0.19, 0.95, 8).translate(0, 0.69, 0),
    new THREE.CylinderGeometry(0.36, 0.22, 0.18, 6).translate(0, 1.25, 0),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.BoxGeometry(0.11, 0.42, 0.11).translate(sx * 0.2, 1.55, sz * 0.2))),
    new THREE.ConeGeometry(0.66, 0.42, 6).translate(0, 1.96, 0),
    new THREE.CylinderGeometry(0.1, 0.12, 0.12, 6).translate(0, 2.2, 0),
    new THREE.SphereGeometry(0.1, 8, 6).translate(0, 2.32, 0),
  ];
  return { stone: merge(stone), light: new THREE.BoxGeometry(0.32, 0.3, 0.32).translate(0, 1.55, 0) };
}

/** Two-storey machiya: facade box, tiled pent eave and gable roof, plastered gable ends. Ridge along x. */
function machiyaGeos() {
  const W = 7.4;
  const D = 10;
  const H = 6.2;
  const body = new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0);
  const hd = D / 2 + 0.75;
  const rh = 2.1;
  const len = Math.hypot(hd, rh);
  const ang = Math.atan2(rh, hd);
  const roof = [
    new THREE.BoxGeometry(W + 0.9, 0.18, len).rotateX(ang).translate(0, H + rh / 2, hd / 2),
    new THREE.BoxGeometry(W + 0.9, 0.18, len).rotateX(-ang).translate(0, H + rh / 2, -hd / 2),
    new THREE.BoxGeometry(W + 1.0, 0.36, 0.45).translate(0, H + rh + 0.08, 0),
    new THREE.BoxGeometry(W + 0.3, 0.13, 1.3).rotateX(0.42).translate(0, 3.35, D / 2 + 0.5),
    new THREE.BoxGeometry(W + 0.3, 0.13, 1.3).rotateX(-0.42).translate(0, 3.35, -D / 2 - 0.5),
  ];
  const shape = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(0, rh - 0.12)]);
  const attic = new THREE.ExtrudeGeometry(shape, { depth: W - 0.02, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-W / 2 + 0.01, H, 0);
  attic.deleteAttribute('uv');
  return { body, roof: merge(roof), attic };
}

/** Five-storey pagoda, ~36 m before scaling. */
function pagodaGeos() {
  const bodies: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  let y = 0;
  bodies.push(new THREE.BoxGeometry(9, 1.2, 9).translate(0, 0.6, 0)); // stone plinth
  y = 1.2;
  for (let k = 0; k < 5; k++) {
    const s = 1 - k * 0.11;
    const w = 6.2 * s;
    const h = k === 0 ? 4.0 : 2.7;
    bodies.push(new THREE.BoxGeometry(w, h, w).translate(0, y + h / 2, 0));
    y += h;
    const wr = w + 4.6 * s;
    const slab = new THREE.BoxGeometry(wr, 0.32, wr, 8, 1, 8);
    const p = slab.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const ax = Math.abs(p.getX(v)) / (wr / 2);
      const az = Math.abs(p.getZ(v)) / (wr / 2);
      p.setY(v, p.getY(v) + 0.5 * Math.pow(Math.max(ax, az), 3) + 0.55 * Math.pow(ax * az, 3));
    }
    slab.computeVertexNormals();
    roofs.push(slab.translate(0, y + 0.1, 0));
    const pr = (w / 2 + 0.9) * Math.SQRT2;
    roofs.push(new THREE.ConeGeometry(pr, 1.1, 4).rotateY(Math.PI / 4).translate(0, y + 0.8, 0));
    y += 0.9;
  }
  roofs.push(new THREE.CylinderGeometry(0.14, 0.24, 9, 6).translate(0, y + 4.5, 0));
  for (let k = 0; k < 9; k++) roofs.push(new THREE.CylinderGeometry(0.55, 0.55, 0.14, 8).translate(0, y + 1.6 + k * 0.62, 0));
  roofs.push(new THREE.SphereGeometry(0.35, 8, 6).translate(0, y + 9.2, 0));
  return { body: merge(bodies), roof: merge(roofs) };
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------
function facadeTex() {
  return canvasTex(256, 256, (g) => {
    const r = rng(5);
    // upper storey: cream plaster with a mushiko lattice window and dark timbers
    g.fillStyle = '#e6d9c0';
    g.fillRect(0, 0, 256, 120);
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = `rgba(120,100,70,${0.04 + r() * 0.06})`;
      g.fillRect(r() * 256, r() * 120, 2, 2);
    }
    g.fillStyle = '#2b211b';
    g.fillRect(40, 38, 176, 44);
    g.fillStyle = '#ddd0b6';
    for (let x = 44; x < 214; x += 11) g.fillRect(x, 38, 6, 44);
    g.fillStyle = '#3a2b21';
    g.fillRect(0, 0, 256, 6);
    g.fillRect(0, 0, 8, 120);
    g.fillRect(248, 0, 8, 120);
    // eave shadow band
    g.fillStyle = '#231c17';
    g.fillRect(0, 112, 256, 18);
    // ground floor: dark wood with fine koshi lattice, a doorway with an indigo noren
    g.fillStyle = '#3b2a1f';
    g.fillRect(0, 130, 256, 126);
    for (let x = 0; x < 256; x += 5) {
      g.fillStyle = `rgba(${120 + r() * 30},${84 + r() * 20},${56 + r() * 14},0.85)`;
      g.fillRect(x, 136, 2, 116);
    }
    g.fillStyle = '#2a1e16';
    for (const y of [136, 180, 248]) g.fillRect(0, y, 256, 5);
    g.fillStyle = '#1b1410';
    g.fillRect(160, 140, 60, 116);
    g.fillStyle = '#26365c';
    g.fillRect(160, 140, 60, 44);
    g.fillStyle = 'rgba(240,235,225,0.8)';
    g.beginPath();
    g.arc(190, 160, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1b1410';
    g.fillRect(189, 140, 2, 44);
  });
}

function tileTex() {
  const t = canvasTex(128, 64, (g) => {
    g.fillStyle = '#4a4d55';
    g.fillRect(0, 0, 128, 64);
    for (let x = 0; x < 128; x += 8) {
      const gr = g.createLinearGradient(x, 0, x + 8, 0);
      gr.addColorStop(0, '#30333a');
      gr.addColorStop(0.5, '#6a6e78');
      gr.addColorStop(1, '#30333a');
      g.fillStyle = gr;
      g.fillRect(x, 0, 8, 64);
    }
    g.fillStyle = 'rgba(20,20,24,0.35)';
    for (let y = 0; y < 64; y += 16) g.fillRect(0, y, 128, 2);
  });
  t.repeat.set(6, 2);
  return t;
}

function petalScatterTex() {
  return canvasTex(
    256,
    256,
    (g) => {
      const r = rng(19);
      const pinks = ['#fbe1e9', '#f6c6d4', '#f0afc3', '#fdeef2', '#eba0b8'];
      for (let i = 0; i < 1400; i++) {
        // clumped towards the middle, sparse at the rim (soft, irregular drift)
        const a = r() * Math.PI * 2;
        const d = Math.pow(r(), 0.75) * 120 * (0.75 + 0.25 * Math.sin(a * 3 + 1));
        g.fillStyle = pinks[Math.floor(r() * pinks.length)];
        g.save();
        g.translate(128 + Math.cos(a) * d, 128 + Math.sin(a) * d);
        g.rotate(r() * Math.PI);
        g.beginPath();
        g.ellipse(0, 0, 2.6 + r() * 2, 1.6 + r() * 1.1, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    },
    false,
  );
}

// ---------------------------------------------------------------------------
// Animated layers
// ---------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
float kHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float kNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(kHash(i), kHash(i + vec2(1.0, 0.0)), u.x), mix(kHash(i + vec2(0.0, 1.0)), kHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;

/**
 * Falling cherry petals in a box that follows the camera. Each petal drifts down on the
 * breeze, spins and flips (its sprite is rotated and squashed in the fragment shader), and
 * catches the light as it turns. Normal alpha blending, one draw call, no CPU per frame.
 */
function buildPetalFall(opts: { count: number; box: number; size: number }): THREE.Points {
  const n = opts.count;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const storm = new Float32Array(n);
  const r = rng(101);
  for (let k = 0; k < n; k++) {
    pos[k * 3] = r() * opts.box;
    pos[k * 3 + 1] = r() * opts.box * 0.5;
    pos[k * 3 + 2] = r() * opts.box;
    seed[k] = r();
    storm[k] = r();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('storm', new THREE.BufferAttribute(storm, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      fxTime,
      fxBuild,
      fxSurge,
      box: { value: opts.box },
      size: { value: opts.size },
      pale: { value: new THREE.Color('#f7c3d3') },
      rose: { value: new THREE.Color('#ea8aa8') },
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float fxTime; uniform float box; uniform float size; uniform float pixelRatio;
      uniform float fxBuild; uniform float fxSurge;
      attribute float seed;
      attribute float storm;
      varying float vFade; varying float vRot; varying float vFlip; varying float vSeed;
      void main(){
        float t = fxTime;
        // blossom storm: a hard effort shakes more petals loose and the swirl grows wilder
        float charge = clamp(fxBuild + 0.7 * fxSurge, 0.0, 1.0);
        float shown = 1.0 - smoothstep(-0.06, 0.0, storm - (0.4 + 0.6 * charge));
        float sw = 1.0 + 1.6 * charge;
        // fall + a steady breeze along x/z + a lazy swirl
        vec3 drift = vec3(
          t * (0.7 + seed * 0.5) + sin(t * 0.6 + seed * 37.0) * 1.4 * sw,
          -t * (0.45 + seed * 0.4) + sin(t * 1.3 + seed * 19.0) * 0.25 * sw,
          t * 0.3 + cos(t * 0.5 + seed * 23.0) * 1.4 * sw);
        vec3 half_ = vec3(box * 0.5, box * 0.25, box * 0.5);
        vec3 p = mod(position + drift - cameraPosition + half_, vec3(box, box * 0.5, box)) - half_ + cameraPosition;
        p.y += box * 0.12; // most petals above eye level, falling past
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        vec3 q = abs(p - cameraPosition - vec3(0.0, box * 0.12, 0.0)) / half_;
        vFade = (1.0 - smoothstep(0.65, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(0.3, 1.2, dist) * shown;
        vRot = t * (0.8 + seed * 2.2) + seed * 40.0;
        vFlip = cos(t * (1.2 + seed * 2.6) + seed * 11.0);
        vSeed = seed;
        gl_PointSize = shown > 0.001 ? size * pixelRatio * (40.0 / max(dist, 0.3)) : 0.0;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 pale; uniform vec3 rose;
      varying float vFade; varying float vRot; varying float vFlip; varying float vSeed;
      void main(){
        vec2 c = gl_PointCoord - 0.5;
        float s = sin(vRot), co = cos(vRot);
        c = mat2(co, -s, s, co) * c;
        float w = max(abs(vFlip), 0.18);
        c.x /= w;
        // rounded petal with a small notch at the tip
        float d = length(vec2(c.x * 1.7, c.y * 1.05 + 0.04 * c.x * c.x * 20.0));
        float a = 1.0 - smoothstep(0.36, 0.44, d);
        a *= 1.0 - (1.0 - smoothstep(0.05, 0.1, length(c - vec2(0.0, 0.43))));
        if (a * vFade < 0.02) discard;
        vec3 col = mix(pale, rose, 0.35 + 0.65 * fract(vSeed * 7.31)) * (0.6 + 0.45 * abs(vFlip));
        col = mix(col, vec3(1.0, 0.88, 0.9) * 1.1, smoothstep(0.75, 1.0, vFlip) * 0.35); // glint as it faces the sun
        gl_FragColor = vec4(col, a * vFade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  return pts;
}

function waterMaterial(sunDir: THREE.Vector3) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      deep: { value: new THREE.Color('#2e4d45') },
      bank: { value: new THREE.Color('#5d6e4c') },
      skyLo: { value: new THREE.Color('#f2d9cf') },
      skyHi: { value: new THREE.Color('#8fb3dc') },
      pink: { value: new THREE.Color('#f3bccb') },
      trunk: { value: new THREE.Color('#3c3a34') },
      petalA: { value: new THREE.Color(PETAL_PALE) },
      petalB: { value: new THREE.Color(PETAL_ROSE) },
      sunDir: { value: sunDir.clone().normalize() },
      sunCol: { value: new THREE.Color('#ffe2bf') },
    },
  ]);
  uniforms.fxTime = fxTime;
  return new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vW; varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float fxTime;
      uniform vec3 bank, deep, skyLo, skyHi, pink, trunk, petalA, petalB, sunDir, sunCol;
      #include <common>
      #include <fog_pars_fragment>
      varying vec3 vW; varying vec2 vUv;
      ${GLSL_NOISE}
      float rip(vec2 q){ return kNoise(q) + 0.5 * kNoise(q * 2.7 - fxTime * 0.09); }
      float petals(vec2 fp, float scale, float density, float salt, out float tone){
        vec2 g = fp * scale;
        vec2 cell = floor(g);
        vec2 f = fract(g);
        float h = kHash(cell + salt);
        vec2 c = vec2(kHash(cell + salt + 1.7), kHash(cell + salt + 3.1)) * 0.6 + 0.2;
        float an = h * 6.2831;
        vec2 r = mat2(cos(an), -sin(an), sin(an), cos(an)) * (f - c);
        float d = length(vec2(r.x, r.y * 1.7));
        tone = kHash(cell + salt + 5.3);
        return (1.0 - smoothstep(0.17, 0.23, d)) * step(h, density);
      }
      void main(){
        float t = fxTime;
        vec2 q = vW.xz * 1.1 + vec2(t * 0.05, t * 0.03);
        float e = 0.12;
        float n0 = rip(q);
        vec3 N = normalize(vec3(-(rip(q + vec2(e, 0.0)) - n0) / e * 0.05, 1.0, -(rip(q + vec2(0.0, e)) - n0) / e * 0.05));
        vec3 Vd = normalize(cameraPosition - vW);
        float fres = 0.3 + 0.7 * pow(1.0 - max(dot(N, Vd), 0.0), 2.0);
        vec3 R = reflect(-Vd, N);
        vec3 sky = mix(skyLo, skyHi, smoothstep(-0.04, 0.35, R.y));
        // reflections of the blossom lining both banks (soft pink masses, darker trunks/gaps)
        float along = vUv.y;
        float tree = smoothstep(0.3, 0.65, kNoise(vec2(along * 0.08, 3.1)) * 0.65 + kNoise(vec2(along * 0.3, vUv.x * 2.0 + t * 0.02)) * 0.35);
        float low = 1.0 - smoothstep(0.3, 0.7, R.y);
        vec3 refl = mix(sky, pink, (0.15 + 0.6 * tree) * low);
        // lowest reflections: the far bank's stone wall and greenery
        refl = mix(refl, bank, 1.0 - smoothstep(0.02, 0.2, R.y));
        refl = mix(refl, trunk, smoothstep(0.82, 0.95, kNoise(vec2(along * 0.6, 1.3))) * low * 0.5);
        vec3 col = mix(deep, refl, clamp(fres * 1.15, 0.0, 1.0));
        col += sunCol * pow(max(dot(R, sunDir), 0.0), 400.0) * 3.0;
        // shadowed water against the stone walls
        float edge = min(vUv.x, 1.0 - vUv.x);
        col *= 0.55 + 0.45 * smoothstep(0.0, 0.12, edge);
        // floating petals: rafts drifting downstream, collecting along the walls
        vec2 fp = vec2(along - t * 0.18, vUv.x * 4.4);
        float raft = smoothstep(0.6, 0.85, kNoise(fp * vec2(0.25, 0.6))) * 0.7;
        raft = max(raft, 1.0 - smoothstep(0.01, 0.1, edge));
        float tone1, tone2;
        float p1 = petals(fp, 7.0, raft * 0.9 + 0.02, 0.0, tone1);
        float p2 = petals(fp + 0.37, 11.0, raft * 0.9, 9.0, tone2);
        vec3 pc1 = mix(petalA, petalB, tone1) * 0.92;
        vec3 pc2 = mix(petalA, petalB, tone2) * 0.85;
        col = mix(col, pc1, p1);
        col = mix(col, pc2, p2 * (1.0 - p1));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
export const KYOTO_SUN = { elevation: 24, azimuth: 28 };

export function buildKyoto(route: Route, opts: ThemeBuildOptions): THREE.Object3D[] {
  const L = loopInfo(route);
  const n = L.n;
  const step = route.step;
  const r = rng(route.seed * 97 + 11);
  const w01 = (i: number, cpk: number, ph: number) => 0.5 + 0.5 * lapWave(route, i, cpk, ph);
  const canal = -L.inward as 1 | -1; // canal on the outside of the loop
  const C0 = 7.0; // near canal wall
  const C1 = 12.2; // far canal wall
  const WATER = -0.38;
  const BED = -1.4;
  const high = opts.high;
  const density = high ? 1 : 0.5;

  // ---- special zones along the lap
  const tunnelStart = Math.floor(n * 0.6);
  const tunnelLen = Math.round(260 / step);
  const inTunnel = (i: number) => {
    const d = (i - tunnelStart + n) % n;
    return d >= -4 && d <= tunnelLen + 4;
  };
  const toriiAt: number[] = [];
  {
    const every = Math.round(1000 / step);
    for (let k = 0; k * every < n; k++) {
      const i = (k * every + Math.round(every * 0.35) + Math.floor((r() - 0.5) * every * 0.3)) % n;
      if (!inTunnel(i) && Math.abs(loopDelta(i, tunnelStart + tunnelLen / 2, n)) > tunnelLen) toriiAt.push(i);
    }
  }
  const bridgeAt: number[] = [];
  for (let d = 180; d < route.length - 100; d += 380 + r() * 220) {
    const i = Math.floor(d / step);
    if (!inTunnel(i) && !toriiAt.some((t) => Math.abs(loopDelta(i, t, n)) < 30 / step)) bridgeAt.push(i);
  }
  const nearTorii = (i: number, m: number) => toriiAt.some((t) => Math.abs(loopDelta(i, t, n)) * step < m);
  const nearBridge = (i: number, m: number) => bridgeAt.some((t) => Math.abs(loopDelta(i, t, n)) * step < m);

  // ---- terrain
  const hill = (i: number, side: number) => 40 + 130 * Math.pow(w01(i, 0.28, side > 0 ? 0.4 : 2.9), 1.4) + 35 * w01(i, 1.1, side * 1.7);
  const height = (i: number, off: number) => {
    const a = Math.abs(off);
    const side = Math.sign(off) || 1;
    if (a < EDGE + 0.6) return -0.1;
    if (side === canal && a > C0 + 0.01 && a < C1 - 0.01) return BED;
    let dy = -0.1 + smooth(EDGE + 0.6, 14, a) * 0.25 + Math.sin(i * 0.07 + a * 0.2) * 0.15 * smooth(14, 30, a);
    dy += Math.max(0, a - 45) * 0.035;
    dy += smooth(55, 420, a) * hill(i, side);
    dy += Math.sin(i * 0.031 + a * 0.013 + side) * 14 * smooth(150, 420, a);
    dy += Math.sin(i * 0.11 - a * 0.04) * 4 * smooth(100, 300, a);
    return dy;
  };
  const far = [16, 20, 26, 34, 45, 60, 80, 105, 140, 190, 250, 330, 430, 560, 720, 900];
  const canalMags = [EDGE, 5.4, 6.4, C0 - 0.45, C0, C0 + 0.04, C1 - 0.04, C1, C1 + 0.5, 13.5, ...far];
  const otherMags = [EDGE, 5.4, 6.6, 8.2, 10.2, 13, ...far];
  const negMags = canal < 0 ? canalMags : otherMags;
  const posMags = canal < 0 ? otherMags : canalMags;
  const offs = [...negMags.map((m) => -m).reverse(), ...posMags];

  const drift = (i: number, side: number) => smooth(0.25, 0.85, w01(i, 2.3, side * 1.1) * 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(i * 0.17 + side)));
  const C = {
    verge: new THREE.Color('#b9ab90'),
    grass: new THREE.Color('#8ea653'),
    grassD: new THREE.Color('#6a8a3c'),
    petal: new THREE.Color('#f3c9d4'),
    coping: new THREE.Color('#b9b3a6'),
    wall: new THREE.Color('#7d796f'),
    bed: new THREE.Color('#2c3a31'),
    yard: new THREE.Color('#a69d88'),
    cedar: new THREE.Color('#2f4a30'),
    fresh: new THREE.Color('#6b8f3e'),
    wildPink: new THREE.Color('#e6a9c0'),
  };
  const model: TerrainModel = {
    cols: offs.length,
    roadCol: negMags.length - 1,
    colOff: (_i, c) => offs[c],
    height,
    color(i, off, dy, out) {
      const a = Math.abs(off);
      const side = Math.sign(off) || 1;
      const t = 0.5 + 0.5 * Math.sin(i * 0.043 + off * 0.11);
      out.copy(C.grass).lerp(C.grassD, t * 0.7);
      if (a > 14 && a < 45) out.lerp(C.yard, 0.35 * (1 - smooth(30, 45, a)));
      // petal drifts carpeting the verges under the trees
      out.lerp(C.petal, drift(i, side) * (1 - smooth(6.5, 10, a)) * 0.55);
      if (a < EDGE + 0.6) out.copy(C.verge).lerp(C.petal, 0.25 + 0.4 * drift(i, side));
      if (side === canal && a >= C0 - 0.46 && a <= C1 + 0.51) {
        if (dy < BED + 0.05) out.copy(C.bed);
        else if (a > C0 + 0.02 && a < C1 - 0.02) out.copy(C.wall);
        else out.copy(C.coping);
      }
      // forested hills: dark cedar with pockets of fresh green and wild cherry
      const f = smooth(35, 150, a);
      if (f > 0) {
        const pk = 0.5 + 0.5 * Math.sin(i * 0.013 + a * 0.009 + side) * Math.sin(i * 0.029 - a * 0.017 + 1.3);
        const g2 = 0.5 + 0.5 * Math.sin(i * 0.021 - a * 0.011 + side * 2.1);
        const forest = C.cedar.clone().lerp(C.fresh, smooth(0.6, 0.85, g2) * 0.6).lerp(C.wildPink, smooth(0.62, 0.82, pk) * 0.75);
        out.lerp(forest, f);
      }
    },
    map: detailTex(61, (g, rr) => {
      for (let k = 0; k < 7000; k++) {
        const v = 150 + rr() * 105;
        g.fillStyle = `rgb(${v},${v},${v - 6})`;
        g.save();
        g.translate(rr() * 256, rr() * 256);
        g.rotate(rr() * Math.PI);
        g.fillRect(0, 0, 1 + rr() * 1.5, 3 + rr() * 4);
        g.restore();
      }
    }),
  };
  const out: THREE.Object3D[] = [buildTerrainMesh(route, model)];

  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const spot = (i: number, off0: number, sink = 0.2) => {
    const off = clampOff(route, i, off0);
    return worldAt(route, i, off, height(i, off) - sink);
  };
  /** Yaw so local +x points along the world direction (dx, dz). */
  const yawTo = (dx: number, dz: number) => Math.atan2(-dz, dx);
  const lat = (i: number) => [-Math.sin(route.heading[i]), Math.cos(route.heading[i])];

  // ---- canal water
  {
    const rows = Math.ceil(n / 2) + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx: number[] = [];
    const p = new THREE.Vector3();
    for (let k = 0; k < rows; k++) {
      const i = (k * 2) % n;
      for (let s = 0; s < 2; s++) {
        worldAt(route, i, canal * (s === 0 ? C0 + 0.02 : C1 - 0.02), WATER, p);
        pos.set([p.x, p.y, p.z], (k * 2 + s) * 3);
        uv[(k * 2 + s) * 2] = s;
        uv[(k * 2 + s) * 2 + 1] = k * 2 * step;
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
    geo.computeBoundingSphere();
    const sunDir = new THREE.Vector3(
      Math.cos(THREE.MathUtils.degToRad(KYOTO_SUN.elevation)) * Math.cos(THREE.MathUtils.degToRad(KYOTO_SUN.azimuth)),
      Math.sin(THREE.MathUtils.degToRad(KYOTO_SUN.elevation)),
      Math.cos(THREE.MathUtils.degToRad(KYOTO_SUN.elevation)) * Math.sin(THREE.MathUtils.degToRad(KYOTO_SUN.azimuth)),
    );
    const m = new THREE.Mesh(geo, waterMaterial(sunDir));
    Object.assign(m.userData, { mapWater: true, mapColor: '#3f6f6a' }); // minimap
    m.frustumCulled = false; // one long ribbon around the lap
    out.push(m);
  }

  // ---- sakura
  const trunks: Inst[][] = [[], [], []];
  const canopies: Inst[][] = [[], [], []];
  const tint = () => {
    const k = r();
    if (k < 0.18) return new THREE.Color(1.0, 0.8, 0.86); // deeper rose (yaezakura)
    if (k < 0.55) return new THREE.Color(1.0, 0.92, 0.95);
    return new THREE.Color(1.0, 0.97 + r() * 0.03, 0.98 + r() * 0.02); // pale somei-yoshino
  };
  const addSakura = (i: number, off: number, faceRoad: boolean, sMin = 0.8, sMax = 1.25, far = false) => {
    const p = spot(i, off, 0.15);
    jitterAlong(p, route, i, 3, r);
    const [lx, lz] = lat(i);
    const side = Math.sign(off);
    let yaw: number;
    if (faceRoad) yaw = yawTo(-side * lx, -side * lz) + (r() - 0.5) * 0.9;
    else yaw = r() * Math.PI * 2;
    const s = sMin + r() * (sMax - sMin);
    const v = far ? 2 : r() < 0.5 ? 0 : 1;
    const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, yaw), new THREE.Vector3(s, s * (0.9 + r() * 0.2), s));
    trunks[v].push({ i, m });
    canopies[v].push({ i, m, c: tint() });
  };
  const lanterns: Inst[] = [];
  const glowPos: number[] = [];
  const addLantern = (i: number, off: number) => {
    const p = spot(i, off, 0.05);
    const s = 0.95 + r() * 0.15;
    lanterns.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, -route.heading[i]), new THREE.Vector3(s, s, s)) });
    glowPos.push(p.x, p.y + 1.55 * s, p.z);
  };
  const decals: Inst[] = [];
  const addDecal = (i: number, off: number, dy: number | null, size: number) => {
    const offc = clampOff(route, i, off);
    const p = worldAt(route, i, offc, (dy ?? height(i, offc)) + 0.035);
    jitterAlong(p, route, i, 4, r);
    decals.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(size, 1, size * (0.6 + r() * 0.5))) });
  };

  const shrubs: Inst[] = [];
  const groveAt = (i: number) => Math.pow(w01(i, 0.55, 0.3) * 0.7 + w01(i, 1.7, 1.9) * 0.3, 1.4);
  const other = -canal;
  for (let i = 0; i < n; i += 2) {
    const grove = groveAt(i); // dense avenues and open stretches
    const tun = inTunnel(i);
    const blocked = nearTorii(i, 9);
    // roadside avenue on the open side
    if (!tun && !blocked && r() < (0.06 + 0.85 * grove) * Math.max(density, 0.7)) addSakura(i, other * (6.4 + r() * 1.4), true);
    // between the road and the canal
    if (!tun && !blocked && !nearBridge(i, 6) && r() < (0.03 + 0.55 * grove) * Math.max(density, 0.7)) addSakura(i, canal * (6.1 + r() * 0.3), r() < 0.6, 0.75, 1.1);
    // far canal bank, leaning out over the water
    if (!nearBridge(i, 5) && r() < (0.1 + 0.7 * grove) * Math.max(density, 0.7)) addSakura(i, canal * (C1 + 1.3 + r() * 1.2), !tun, 0.85, 1.2);
    // scattered behind, in gardens and between houses
    for (const side of [-1, 1]) {
      if (r() < 0.22 * density) addSakura(i, side * (18 + Math.pow(r(), 1.5) * 45), false, 0.8, 1.35, true);
    }
    // petal drifts on the verges and on the canal
    for (const side of [-1, 1]) {
      const dr = drift(i, side);
      const nd = (0.3 + 1.1 * dr) * density;
      let k = Math.floor(nd) + (r() < nd % 1 ? 1 : 0);
      while (k-- > 0) {
        const lim = side === canal ? C0 - 0.6 : 9;
        const sz = 1.6 + r() * 2.2;
        const a = EDGE + 0.4 + sz * 0.4 + r() * Math.max(0.2, lim - EDGE - 0.4 - sz * 0.4);
        addDecal(i, side * a, null, sz);
      }
    }
    if (r() < 0.5 * density) addDecal(i, canal * (C1 + 0.8 + r() * 4), null, 2 + r() * 2);
    // clipped garden shrubs (azalea / boxwood) and the odd flowering azalea
    for (const side of [-1, 1]) {
      const ns = 1.4 * density;
      let k = Math.floor(ns) + (r() < ns % 1 ? 1 : 0);
      while (k-- > 0) {
        const a = side === canal ? C1 + 0.9 + r() * 6 : 8.5 + r() * 8;
        const p = spot(i, side * a, 0.15);
        jitterAlong(p, route, i, 9, r);
        const sc = 0.5 + r() * 0.7;
        const flower = r() < 0.18;
        shrubs.push({
          i,
          m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(sc * (1 + r() * 0.6), sc * 0.8, sc)),
          c: flower ? new THREE.Color().setHSL(0.93 + r() * 0.05, 0.55, 0.62) : new THREE.Color().setHSL(0.24 + r() * 0.06, 0.45, 0.2 + r() * 0.08),
        });
      }
    }
  }
  // lanterns at regular spacing
  {
    const every = Math.max(1, Math.round(26 / step));
    for (let i = 0; i < n; i += every) {
      if (nearTorii(i, 8) || nearBridge(i, 4) || inTunnel(i)) continue;
      addLantern(i, canal * 5.75);
      if ((i / every) % 2 === 1) addLantern((i + Math.round(every / 2)) % n, other * 5.6);
    }
  }

  const trunkMat = new THREE.MeshLambertMaterial({ color: '#3b2c27' });
  const canopyMat = canopyMaterial();
  // Canopies are the bulk of Kyoto's triangles (21 lobes each), so they step down in detail
  // with distance: full detail up close, detail 1 in the middle distance, detail 0 far off
  // (a few pixels per lobe by then). Only near trees cast shadows: the sun's shadow box
  // reaches ~75 m from the camera at its far corner (see SHADOW_HALF / SHADOW_AHEAD in
  // scene.ts), and a low sun throws a canopy's shadow ~30 m further.
  const NEAR = 100;
  const MID = 260;
  const FAR = 600;
  for (let v = 0; v < 3; v++) {
    const seed = 400 + v * 17;
    const trunk = sakuraTrunk(300 + v);
    out.push(
      lodInstances(
        route,
        [
          { geo: trunk, upTo: NEAR, shadow: true },
          { geo: trunk, upTo: MID },
          { geo: sakuraTrunk(300 + v, true), upTo: Infinity },
        ],
        trunkMat,
        trunks[v],
        { chunkM: 500 },
      ),
    );
    // detail 2 up close on High (the far-row variant 2 is already detail 1 at its nearest)
    const mid = sakuraCanopy(seed, 1);
    const levels: LodLevel[] = [
      { geo: high && v !== 2 ? sakuraCanopy(seed, 2) : mid, upTo: NEAR, shadow: high },
      { geo: mid, upTo: MID },
      { geo: sakuraCanopy(seed, 0), upTo: FAR },
      { geo: sakuraCanopy(seed, 0, 8), upTo: Infinity },
    ];
    out.push(lodInstances(route, levels, canopyMat, canopies[v], { chunkM: 500 }));
  }

  // garden shrubs: about a metre tall, so a couple of pixels by 300 m: drop them there
  const shrubGeo = (detail: number) =>
    merge([
      new THREE.IcosahedronGeometry(1 * (COARSE_GROW[detail] ?? 1), detail).scale(1.2, 0.75, 1.1).translate(0, 0.55, 0),
      new THREE.IcosahedronGeometry(0.75 * (COARSE_GROW[detail] ?? 1), detail).translate(0.8, 0.45, 0.3),
    ]);
  out.push(
    lodInstances(
      route,
      [
        { geo: shrubGeo(1), upTo: NEAR, shadow: high },
        { geo: shrubGeo(0), upTo: 300 },
        { geo: null, upTo: Infinity },
      ],
      windy(new THREE.MeshLambertMaterial({}), 1.2, 0.03),
      shrubs,
      { chunkM: 500 },
    ),
  );

  // ---- petal carpets (flat alpha-tested decals on the ground)
  {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ map: petalScatterTex(), alphaTest: 0.45, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const g = chunkedInstances(route, geo, mat, decals, { shadow: false, receive: true, chunkM: 500 });
    g.userData.noAO = true;
    g.traverse((o) => (o.userData.noAO = true));
    out.push(g);
  }

  // ---- stone lanterns + their warm glow
  {
    const lg = lanternGeos();
    // ~1.7 m tall: a couple of pixels by 500 m (the glow sprites still carry them further)
    out.push(
      lodInstances(
        route,
        [
          { geo: lg.stone, upTo: NEAR, shadow: true },
          { geo: lg.stone, upTo: 500 },
          { geo: null, upTo: Infinity },
        ],
        new THREE.MeshLambertMaterial({ color: '#9d998e' }),
        lanterns,
        { chunkM: 600 },
      ),
    );
    out.push(chunkedInstances(route, lg.light, new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffb466').multiplyScalar(2.6) }), lanterns, { shadow: false, chunkM: 600 }));
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(glowPos), 3));
    const glow = new THREE.Points(
      gg,
      new THREE.PointsMaterial({
        map: radialTex('rgba(255,255,255,1)', 'rgba(255,255,255,0)'),
        color: new THREE.Color('#ffae5c').multiplyScalar(0.9),
        size: 1.9,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.frustumCulled = false;
    out.push(glow);
  }

  // ---- torii: big gates every km or so, plus a tunnel of small gates
  {
    const tg = toriiGeos();
    const redItems: Inst[] = [];
    for (const i of toriiAt) {
      const p = worldAt(route, i, 0, -0.1);
      const [lx, lz] = lat(i);
      redItems.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, yawTo(lx, lz)), new THREE.Vector3(1, 1, 1)) });
    }
    const d0 = tunnelStart * step;
    for (let d = 0; d < tunnelLen * step; d += 2.8) {
      const pt = route.at(d0 + d);
      const i = Math.floor((d0 + d) / step) % n;
      const p = new THREE.Vector3(pt.x, pt.y - 0.1, pt.z);
      redItems.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, yawTo(-Math.sin(pt.heading), Math.cos(pt.heading))), new THREE.Vector3(0.9, 0.62, 0.6)) });
    }
    const red = new THREE.MeshLambertMaterial({ color: VERMILION, emissive: new THREE.Color('#5a1206') });
    out.push(chunkedInstances(route, tg.red, red, redItems, { shadow: true, chunkM: 400 }));
    out.push(chunkedInstances(route, tg.black, new THREE.MeshLambertMaterial({ color: '#1e1b1a' }), redItems, { shadow: true, chunkM: 400 }));
  }

  // ---- bridges over the canal (stone and vermilion-railed wood)
  {
    const span = C1 - C0 + 1.4;
    const rise = 0.85;
    const deck = arch(new THREE.BoxGeometry(2.4, 0.45, span, 1, 1, 20).translate(0, -0.12, span / 2), span, rise);
    const parapets = merge([-1, 1].map((sx) => arch(new THREE.BoxGeometry(0.28, 0.7, span, 1, 1, 20).translate(sx * 1.16, 0.4, span / 2), span, rise)));
    const rails: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      rails.push(arch(new THREE.BoxGeometry(0.13, 0.13, span, 1, 1, 20).translate(sx * 1.12, 0.95, span / 2), span, rise));
      for (let k = 0; k <= 6; k++) {
        const z = (k / 6) * (span - 0.3) + 0.15;
        rails.push(new THREE.BoxGeometry(0.15, 0.95, 0.15).translate(sx * 1.12, 0.48 + rise * Math.sin((Math.PI * z) / span), z));
      }
    }
    const railGeo = merge(rails);
    const stoneB: Inst[] = [];
    const woodB: Inst[] = [];
    for (const i of bridgeAt) {
      const p = worldAt(route, i, canal * (C0 - 0.7), -0.05);
      // local +z across the canal, local +x along the road
      const yaw = yawTo(Math.cos(route.heading[i]), Math.sin(route.heading[i])) + (canal < 0 ? Math.PI : 0);
      const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, yaw), new THREE.Vector3(1, 1, 1));
      (r() < 0.5 ? stoneB : woodB).push({ i, m });
    }
    const stoneMat = new THREE.MeshLambertMaterial({ color: '#a39e92' });
    out.push(chunkedInstances(route, merge([deck, parapets]), stoneMat, stoneB, { shadow: true, receive: true }));
    out.push(chunkedInstances(route, deck, new THREE.MeshLambertMaterial({ color: '#76563d' }), woodB, { shadow: true, receive: true }));
    out.push(chunkedInstances(route, railGeo, new THREE.MeshLambertMaterial({ color: VERMILION, emissive: new THREE.Color('#4a0f05') }), woodB, { shadow: true }));
  }

  // ---- machiya houses set back from the road
  {
    const hg = machiyaGeos();
    const houses: Inst[] = [];
    for (const side of [-1, 1]) {
      const base = side === canal ? C1 + 4.5 : 13.5;
      let d = r() * 20;
      while (d < route.length - 10) {
        const i = Math.floor(d / step) % n;
        const row = w01(i, 0.9, side * 2.3 + 0.7);
        const wScale = 0.9 + r() * 0.35;
        const width = 7.4 * wScale;
        if (row > 0.42 && !(side === other && inTunnel(i))) {
          const setback = base + 5 + r() * 2.5;
          const p = spot(i, side * setback, 0.1);
          const yaw = yawTo(Math.cos(route.heading[i]), Math.sin(route.heading[i]));
          houses.push({ i, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, yaw), new THREE.Vector3(wScale, 0.9 + r() * 0.18, 0.9 + r() * 0.2)) });
          d += width + 0.4 + (r() < 0.25 ? 4 + r() * 8 : r() * 1.2);
        } else d += 12 + r() * 10;
      }
    }
    const facade = facadeTex();
    out.push(chunkedInstances(route, hg.body, new THREE.MeshLambertMaterial({ map: facade }), houses, { shadow: true, receive: true }));
    out.push(chunkedInstances(route, hg.roof, new THREE.MeshLambertMaterial({ map: tileTex() }), houses, { shadow: true, receive: true }));
    out.push(chunkedInstances(route, hg.attic, new THREE.MeshLambertMaterial({ color: '#e3d6bd' }), houses, { shadow: false }));
  }

  // ---- forested hills: cedars, dark pines, wild cherry
  {
    const cedars: Inst[] = [];
    const pines: Inst[] = [];
    const wild: Inst[] = [];
    const per = high ? 6.5 : 2.5;
    for (let i = 0; i < n; i += 2) {
      for (const side of [-1, 1]) {
        let k = Math.floor(per) + (r() < per % 1 ? 1 : 0);
        while (k-- > 0) {
          const a = 45 + Math.pow(r(), 1.25) * 650;
          const p = spot(i, side * a, 0.8);
          jitterAlong(p, route, i, 10, r);
          const pk = 0.5 + 0.5 * Math.sin(i * 0.013 + a * 0.009 + side) * Math.sin(i * 0.029 - a * 0.017 + 1.3);
          const roll = r();
          const s = 0.8 + r() * 0.7;
          const m = new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(s, s * (0.8 + r() * 0.5), s));
          if (roll < 0.08 + 0.5 * smooth(0.6, 0.85, pk)) wild.push({ i, m, c: new THREE.Color().setHSL(0.94 + r() * 0.04, 0.5 + r() * 0.2, 0.8 + r() * 0.08) });
          else if (roll < 0.7) cedars.push({ i, m, c: new THREE.Color().setHSL(0.3 + r() * 0.06, 0.32, 0.14 + r() * 0.07) });
          else pines.push({ i, m, c: new THREE.Color().setHSL(0.24 + r() * 0.08, 0.35, 0.18 + r() * 0.08) });
        }
      }
    }
    const cedarGeo = merge([new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0), new THREE.ConeGeometry(2.3, 10, 8).translate(0, 7.5, 0), new THREE.ConeGeometry(1.7, 7, 8).translate(0, 12.5, 0), new THREE.ConeGeometry(1.0, 4, 8).translate(0, 16.5, 0)]);
    // far off (thousands of them on the hills): the same stacked tiers, six-sided, no trunk or bases
    const cedarFar = merge([new THREE.ConeGeometry(2.3, 10, 6, 1, true).translate(0, 7.5, 0), new THREE.ConeGeometry(1.7, 7, 6, 1, true).translate(0, 12.5, 0), new THREE.ConeGeometry(1.0, 4, 6, 1, true).translate(0, 16.5, 0)]);
    const pineGeo = merge([new THREE.IcosahedronGeometry(3.2, 0).scale(1.3, 0.8, 1.2).translate(0, 8, 0), new THREE.IcosahedronGeometry(2.4, 0).scale(1.2, 0.7, 1.1).translate(2.2, 6, 1)]);
    const wildGeo = (detail: number) => {
      const k = COARSE_GROW[detail] ?? 1;
      return merge([new THREE.IcosahedronGeometry(3.4 * k, detail).scale(1.3, 0.85, 1.2).translate(0, 6.5, 0), new THREE.IcosahedronGeometry(2.6 * k, detail).translate(2.4, 5.6, -1)]);
    };
    const fMat = new THREE.MeshLambertMaterial({ flatShading: true });
    out.push(
      lodInstances(
        route,
        [
          { geo: cedarGeo, upTo: 300 },
          { geo: cedarFar, upTo: Infinity },
        ],
        fMat,
        cedars,
      ),
    );
    out.push(chunkedInstances(route, pineGeo, fMat, pines, { shadow: false }));
    out.push(
      lodInstances(
        route,
        [
          { geo: wildGeo(1), upTo: 250 },
          { geo: wildGeo(0), upTo: Infinity },
        ],
        new THREE.MeshLambertMaterial({}),
        wild,
      ),
    );
  }

  // ---- pagodas on hilltops
  {
    const pg = pagodaGeos();
    const items: Inst[] = [];
    for (const f of [0.12, 0.45, 0.78]) {
      // in an open stretch (few roadside trees) so the hills are in view
      let i0 = Math.floor(f * n);
      let best = Infinity;
      for (let d = -Math.floor(n * 0.08); d <= n * 0.08; d += 4) {
        const ii = (Math.floor(f * n) + d + n) % n;
        const g = groveAt(ii) + groveAt((ii - Math.round(400 / step) + n) % n);
        if (g < best) {
          best = g;
          i0 = ii;
        }
      }
      // the higher hill side here
      const side = hill(i0, 1) > hill(i0, -1) ? 1 : -1;
      const off = clampOff(route, i0, side * (240 + r() * 100));
      const p = worldAt(route, i0, off, height(i0, off) - 1.5);
      items.push({ i: i0, m: new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, r() * 6.3), new THREE.Vector3(2, 2, 2)) });
    }
    out.push(chunkedInstances(route, pg.body, new THREE.MeshLambertMaterial({ color: '#9a4a2f' }), items, { shadow: false }));
    out.push(chunkedInstances(route, pg.roof, new THREE.MeshLambertMaterial({ color: '#35363c' }), items, { shadow: false }));
  }

  // ---- petals tumbling through the air around the rider
  out.push(buildPetalFall({ count: high ? 8000 : 2750, box: 44, size: 1.3 })); // 40% fall at rest; the rest join in a hard effort
  return out;
}
