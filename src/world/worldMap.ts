// Top-down map of the 3D world, for the minimap.
//
// The world view registers the scenery it builds for a route (terrain ribbons,
// ground discs, water, trees, buildings...). The first time the minimap asks for
// that route's map, those meshes are rasterised from straight above, with the
// highest surface winning (a height buffer), to learn the real layout: where
// the water, woods and buildings are. The minimap draws that layout as a flat
// 2D map in simple theme colours (see stylize). The work is done once, in small
// time slices so the ride never stutters, and cached per route.
//
// Hints a theme can put on a material's (or object's) userData:
//   mapWater: true      - this surface is water
//   mapColor: '#rrggbb' - colour to use (needed for ShaderMaterials, which are skipped otherwise)
//   mapSkip: true       - leave it off the map
import * as THREE from 'three';
import type { Route } from './route';

export interface WorldMap {
  canvas: HTMLCanvasElement;
  /** world x / z of the image's top-left corner (image x → +x, image y → +z) */
  minX: number;
  minZ: number;
  mPerPx: number;
  /** colour for anything outside the image */
  fill: string;
}

export interface RasterBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  mPerPx: number;
  /** surfaces above this height (sky domes, sun discs...) are ignored */
  maxY: number;
}

export interface Raster {
  w: number;
  h: number;
  /** RGBA, row-major, row 0 = minZ */
  data: Uint8ClampedArray;
  fill: [number, number, number];
}

/** Metres of surroundings rendered around the route's bounding box. */
const MARGIN = 1500;
/** Largest image side (px); bigger routes get coarser metres per pixel. */
const MAX_PX = 2400;
const MIN_M_PER_PX = 2;

// light from the north-west, fairly high (classic hill-shading)
const LIGHT = new THREE.Vector3(-0.55, 0.75, -0.38).normalize();

// ---------------------------------------------------------------------------
// Colour helpers (vertex colours and THREE.Color are linear; output is sRGB)
// ---------------------------------------------------------------------------
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const toSrgb = (c: number) => {
  c = Math.min(1, Math.max(0, c));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

/** Downsampled copy of a texture's image for cheap colour lookups. */
interface Sampler {
  w: number;
  h: number;
  rgb: Float32Array; // linear
  avg: [number, number, number];
  tex: THREE.Texture;
  /** a tiling detail texture (sampling it per vertex only adds streaks: use its average) */
  detail: boolean;
}
const TEX_RES = 64;
const samplers = new WeakMap<THREE.Texture, Sampler | null>();
function samplerFor(tex: THREE.Texture | null | undefined): Sampler | null {
  if (!tex) return null;
  if (samplers.has(tex)) return samplers.get(tex)!;
  let s: Sampler | null = null;
  try {
    const img = tex.image as CanvasImageSource & { width?: number; height?: number };
    if (img && img.width && img.height && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = TEX_RES;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, TEX_RES, TEX_RES);
      const px = g.getImageData(0, 0, TEX_RES, TEX_RES).data;
      const srgb = tex.colorSpace === THREE.SRGBColorSpace;
      const rgb = new Float32Array(TEX_RES * TEX_RES * 3);
      const avg: [number, number, number] = [0, 0, 0];
      let wsum = 0;
      for (let i = 0; i < TEX_RES * TEX_RES; i++) {
        const a = px[i * 4 + 3] / 255;
        for (let k = 0; k < 3; k++) {
          const v = srgb ? S2L[px[i * 4 + k]] : px[i * 4 + k] / 255;
          rgb[i * 3 + k] = v;
          avg[k] += v * a;
        }
        wsum += a;
      }
      for (let k = 0; k < 3; k++) avg[k] = wsum > 0 ? avg[k] / wsum : 1;
      tex.updateMatrix();
      s = { w: TEX_RES, h: TEX_RES, rgb, avg, tex, detail: tex.wrapS !== THREE.ClampToEdgeWrapping && tex.wrapT !== THREE.ClampToEdgeWrapping };
    }
  } catch {
    s = null; // unreadable image (e.g. cross-origin): fall back to the plain colour
  }
  samplers.set(tex, s);
  return s;
}

const wrap = (v: number, mode: THREE.Wrapping) => (mode === THREE.ClampToEdgeWrapping ? Math.min(1, Math.max(0, v)) : v - Math.floor(v));
const _uv = new THREE.Vector3();
function sample(s: Sampler, u: number, v: number, out: [number, number, number]) {
  _uv.set(u, v, 1).applyMatrix3(s.tex.matrix);
  const x = Math.min(s.w - 1, Math.floor(wrap(_uv.x, s.tex.wrapS) * s.w));
  const fy = wrap(_uv.y, s.tex.wrapT);
  const y = Math.min(s.h - 1, Math.floor((s.tex.flipY ? 1 - fy : fy) * s.h));
  const o = (y * s.w + x) * 3;
  out[0] = s.rgb[o];
  out[1] = s.rgb[o + 1];
  out[2] = s.rgb[o + 2];
}

// ---------------------------------------------------------------------------
// What gets drawn
// ---------------------------------------------------------------------------
type Mat = THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; vertexColors?: boolean };

interface Look {
  color: THREE.Color; // linear
  map: Sampler | null;
  vertexColors: boolean;
  water: boolean;
}

const hint = (o: THREE.Object3D, m: THREE.Material, key: string): unknown => {
  if (m.userData[key] !== undefined) return m.userData[key];
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData[key] !== undefined) return p.userData[key];
  return undefined;
};

const defaultBeforeRender = THREE.Object3D.prototype.onBeforeRender;

/** How a mesh looks from above, or null if it should not be on the map. */
function lookOf(o: THREE.Mesh): Look | null {
  const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as Mat | undefined;
  if (!mat || !mat.visible) return null;
  if (hint(o, mat, 'mapSkip')) return null;
  // camera-following domes (skies, horizons) are not part of the ground
  if (o.onBeforeRender !== defaultBeforeRender) return null;
  if (mat.side === THREE.BackSide) return null;
  const water = !!hint(o, mat, 'mapWater');
  // overlays: foam, glows, light pools, particles (water surfaces may be see-through)
  if (mat.blending !== THREE.NormalBlending || (mat.transparent && !water)) return null;
  const forced = hint(o, mat, 'mapColor');
  if (typeof forced === 'string') return { color: new THREE.Color(forced), map: null, vertexColors: false, water };
  if ((mat as THREE.ShaderMaterial).isShaderMaterial || !mat.color) return null;
  return { color: mat.color.clone(), map: samplerFor(mat.map), vertexColors: !!mat.vertexColors, water };
}

// ---------------------------------------------------------------------------
// Rasteriser
// ---------------------------------------------------------------------------
class Canvas2 {
  zbuf: Float32Array;
  data: Uint8ClampedArray;
  water: Uint8Array;
  /** 1 where any real surface (not just a far backdrop disc) lies, seen or hidden */
  cover: Uint8Array;
  /** what is on top at each pixel: 0 nothing, 1 land, 2 water, 3 tree / rock, 4 building */
  kind: Uint8Array;
  /** rough count of work done (pixels and primitives), for time slicing */
  work = 0;
  constructor(
    public w: number,
    public h: number,
  ) {
    this.zbuf = new Float32Array(w * h).fill(-Infinity);
    this.data = new Uint8ClampedArray(w * h * 4);
    this.water = new Uint8Array(w * h);
    this.cover = new Uint8Array(w * h);
    this.kind = new Uint8Array(w * h);
  }

  /**
   * Gouraud triangle in pixel space; v = [x, y(px), height, r, g, b] per vertex (sRGB 0..255).
   */
  tri(a: Float64Array, b: Float64Array, c: Float64Array, water: number, solid = 1, kind = water ? 2 : 1) {
    const { w, h } = this;
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    this.work += 8;
    if (y0 > y1 || Math.max(a[0], b[0], c[0]) < 0 || Math.min(a[0], b[0], c[0]) > w) return;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    const inv = 1 / area;
    const edges = [a, b, b, c, c, a];
    for (let py = y0; py <= y1; py++) {
      const sy = py + 0.5;
      // this row's span: where the row's centre line crosses the edges (cost ∝ area, not bounding box)
      let xl = Infinity;
      let xr = -Infinity;
      for (let e = 0; e < 6; e += 2) {
        const p = edges[e];
        const q = edges[e + 1];
        if ((sy < p[1] && sy < q[1]) || (sy > p[1] && sy > q[1]) || p[1] === q[1]) continue;
        const x = p[0] + ((sy - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
      const x0 = Math.max(0, Math.ceil(xl - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xr - 0.5));
      if (x0 > x1) continue;
      this.work += x1 - x0 + 1;
      for (let px = x0; px <= x1; px++) {
        const sx = px + 0.5;
        const wa = ((b[0] - sx) * (c[1] - sy) - (b[1] - sy) * (c[0] - sx)) * inv;
        const wb = ((c[0] - sx) * (a[1] - sy) - (c[1] - sy) * (a[0] - sx)) * inv;
        const wc = 1 - wa - wb;
        const z = wa * a[2] + wb * b[2] + wc * c[2];
        const k = py * w + px;
        if (solid) this.cover[k] = 1;
        if (z <= this.zbuf[k]) continue;
        this.zbuf[k] = z;
        const o = k * 4;
        this.data[o] = wa * a[3] + wb * b[3] + wc * c[3];
        this.data[o + 1] = wa * a[4] + wb * b[4] + wc * c[4];
        this.data[o + 2] = wa * a[5] + wb * b[5] + wc * c[5];
        this.data[o + 3] = 255;
        this.water[k] = water;
        this.kind[k] = kind;
      }
    }
  }

  /** Shaded disc (a tree crown, a boulder) seen from above. */
  disc(cx: number, cy: number, r: number, z: number, rgb: [number, number, number]) {
    const { w, h } = this;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    const r2 = Math.max(0.25, r * r);
    this.work += 8 + (x1 - x0 + 1) * (y1 - y0 + 1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const k = py * w + px;
        this.cover[k] = 1;
        // dome: the crown is higher in the middle; lit on the north-west side
        const dome = Math.sqrt(1 - d2 / r2);
        const zz = z - r * (1 - dome);
        if (zz <= this.zbuf[k]) continue;
        this.zbuf[k] = zz;
        const lit = 0.72 + 0.28 * dome - 0.22 * ((dx * LIGHT.x + dy * LIGHT.z) / Math.sqrt(r2));
        const o = k * 4;
        this.data[o] = rgb[0] * lit;
        this.data[o + 1] = rgb[1] * lit;
        this.data[o + 2] = rgb[2] * lit;
        this.data[o + 3] = 255;
        this.water[k] = 0;
        this.kind[k] = 3;
      }
    }
  }
}

const shadeOf = (nx: number, ny: number, nz: number) => {
  const l = Math.hypot(nx, ny, nz) || 1;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const d = (nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) / l;
  return 0.42 + 0.78 * Math.max(0, d);
};

/**
 * Rasterise everything under `roots` into a top-down image. A generator: it
 * yields every so often so the caller can spread the work over several frames.
 */
export function* rasterizeWorld(roots: THREE.Object3D[], b: RasterBounds, style?: MapStyle): Generator<void, Raster, void> {
  const w = Math.max(1, Math.ceil((b.maxX - b.minX) / b.mPerPx));
  const h = Math.max(1, Math.ceil((b.maxZ - b.minZ) / b.mPerPx));
  const cv = new Canvas2(w, h);
  const ipx = 1 / b.mPerPx;

  const meshes: THREE.Mesh[] = [];
  for (const r of roots) {
    r.updateMatrixWorld(true);
    r.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
  }

  const va = new Float64Array(6);
  const vb = new Float64Array(6);
  const vc = new Float64Array(6);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const texel: [number, number, number] = [1, 1, 1];
  const rgb: [number, number, number] = [0, 0, 0];
  // yield after roughly this much work (pixels touched, primitives, vertices)
  const SLICE = 200_000;
  let nextYield = SLICE;

  for (const mesh of meshes) {
    const look = lookOf(mesh);
    if (!look) continue;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos) continue;
    const col = look.vertexColors ? geo.attributes.color : undefined;
    const uv = look.map ? geo.attributes.uv : undefined;
    const isWater = look.water ? 1 : 0;
    // the huge discs under everything (far ground, open sea): only a backdrop where nothing else is
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const solid = geo.boundingSphere!.radius * mesh.matrixWorld.getMaxScaleOnAxis() > 4000 ? 0 : 1;

    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      // instances (trees, rocks, buildings): a footprint at the top of each one
      const im = mesh as THREE.InstancedMesh;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const box = geo.type === 'BoxGeometry';
      // average colour of the geometry (vertex colours, texture)
      const base = look.color.clone();
      if (col) {
        let r = 0, g = 0, bl = 0;
        for (let i = 0; i < col.count; i++) {
          r += col.getX(i);
          g += col.getY(i);
          bl += col.getZ(i);
        }
        base.multiply(new THREE.Color(r / col.count, g / col.count, bl / col.count));
      }
      if (look.map) base.multiply(new THREE.Color(...look.map.avg));
      const m = new THREE.Matrix4();
      const ic = new THREE.Color();
      const cxl = (bb.min.x + bb.max.x) / 2;
      const czl = (bb.min.z + bb.max.z) / 2;
      const corners = [
        [bb.min.x, bb.min.z],
        [bb.max.x, bb.min.z],
        [bb.max.x, bb.max.z],
        [bb.min.x, bb.max.z],
      ];
      const cw = [va, vb, vc, new Float64Array(6)];
      for (let k = 0; k < im.count; k++) {
        im.getMatrixAt(k, m);
        m.premultiply(im.matrixWorld);
        const e = m.elements;
        const sx = Math.hypot(e[0], e[1], e[2]);
        const sz = Math.hypot(e[8], e[9], e[10]);
        const rad = Math.max((bb.max.x - bb.min.x) * sx, (bb.max.z - bb.min.z) * sz) * 0.5 * ipx;
        if (rad < 0.35) continue; // smaller than a pixel (or hidden by a zero scale)
        p.set(cxl, bb.max.y, czl).applyMatrix4(m);
        if (p.y > b.maxY) continue;
        const c = ic.copy(base);
        if (im.instanceColor) c.multiply(rgbAt(im.instanceColor, k, ic.clone()));
        rgb[0] = toSrgb(c.r);
        rgb[1] = toSrgb(c.g);
        rgb[2] = toSrgb(c.b);
        const px = (p.x - b.minX) * ipx;
        const py = (p.z - b.minZ) * ipx;
        if (box) {
          // buildings: the oriented roof rectangle, lit by how it faces the sun
          for (let q = 0; q < 4; q++) {
            p.set(corners[q][0], bb.max.y, corners[q][1]).applyMatrix4(m);
            const v = cw[q];
            v[0] = (p.x - b.minX) * ipx;
            v[1] = (p.z - b.minZ) * ipx;
            v[2] = p.y;
            v[3] = rgb[0] * 1.08;
            v[4] = rgb[1] * 1.08;
            v[5] = rgb[2] * 1.08;
          }
          cv.tri(cw[0], cw[1], cw[2], 0, 1, 4);
          cv.tri(cw[0], cw[2], cw[3], 0, 1, 4);
        } else cv.disc(px, py, rad, p.y, rgb);
        cv.work += 20;
        if (cv.work >= nextYield) {
          nextYield = cv.work + SLICE;
          yield;
        }
      }
      continue;
    }

    // plain meshes: every triangle, Gouraud-shaded
    nm.getNormalMatrix(mesh.matrixWorld);
    const nrm = geo.attributes.normal;
    const count = pos.count;
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const sz = new Float64Array(count);
    const cr = new Float64Array(count);
    const cg = new Float64Array(count);
    const cb = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      sx[i] = (p.x - b.minX) * ipx;
      sy[i] = (p.z - b.minZ) * ipx;
      sz[i] = p.y;
      let r = look.color.r, g = look.color.g, bl = look.color.b;
      if (col) {
        r *= col.getX(i);
        g *= col.getY(i);
        bl *= col.getZ(i);
      }
      if (look.map) {
        if (uv && !look.map.detail) sample(look.map, uv.getX(i), uv.getY(i), texel);
        else [texel[0], texel[1], texel[2]] = look.map.avg;
        r *= texel[0];
        g *= texel[1];
        bl *= texel[2];
      }
      let s = 1;
      if (!look.water && nrm) {
        n.fromBufferAttribute(nrm, i).applyMatrix3(nm);
        s = shadeOf(n.x, n.y, n.z);
      }
      cr[i] = toSrgb(r) * s;
      cg[i] = toSrgb(g) * s;
      cb[i] = toSrgb(bl) * s;
      cv.work += 6;
      if (cv.work >= nextYield) {
        nextYield = cv.work + SLICE;
        yield;
      }
    }
    const idx = geo.index;
    const tris = idx ? idx.count / 3 : count / 3;
    const set = (v: Float64Array, i: number) => {
      v[0] = sx[i];
      v[1] = sy[i];
      v[2] = sz[i];
      v[3] = cr[i];
      v[4] = cg[i];
      v[5] = cb[i];
    };
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      if ((sz[i0] + sz[i1] + sz[i2]) / 3 > b.maxY) continue;
      set(va, i0);
      set(vb, i1);
      set(vc, i2);
      if (!nrm && !look.water) {
        // no normals: flat-shade by the face normal
        const ux = (sx[i1] - sx[i0]) * b.mPerPx, uy = sz[i1] - sz[i0], uz = (sy[i1] - sy[i0]) * b.mPerPx;
        const wx = (sx[i2] - sx[i0]) * b.mPerPx, wy = sz[i2] - sz[i0], wz = (sy[i2] - sy[i0]) * b.mPerPx;
        const s = shadeOf(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
        for (const v of [va, vb, vc]) {
          v[3] *= s;
          v[4] *= s;
          v[5] *= s;
        }
      }
      cv.tri(va, vb, vc, isWater, solid);
      if (cv.work >= nextYield) {
        nextYield = cv.work + SLICE;
        yield;
      }
    }
  }

  // ---- finishing ----
  // Beyond the terrain ribbons (and in the wedges where they stop short on tight
  // bends) the world has only its backdrop discs. Fill those holes by carrying
  // the neighbouring terrain outwards (push-pull on a coarse grid), so the map
  // shows land continuing past the ridges rather than a disc; where the nearby
  // surface is water (open sea, a fjord) it stays water.
  const { data, water, zbuf, cover } = cv;
  const B = 8;
  const gw = Math.ceil(w / B);
  const gh = Math.ceil(h / B);
  const acc = new Float32Array(gw * gh * 4); // r, g, b, water
  const wgt = new Float32Array(gw * gh);
  const accL = new Float32Array(gw * gh * 4); // land only: the colour carried into land holes
  const wgtL = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!cover[k] || zbuf[k] === -Infinity) continue;
      const c = ((y / B) | 0) * gw + ((x / B) | 0);
      acc[c * 4] += data[k * 4];
      acc[c * 4 + 1] += data[k * 4 + 1];
      acc[c * 4 + 2] += data[k * 4 + 2];
      acc[c * 4 + 3] += water[k];
      wgt[c]++;
      if (!water[k]) {
        accL[c * 4] += data[k * 4];
        accL[c * 4 + 1] += data[k * 4 + 1];
        accL[c * 4 + 2] += data[k * 4 + 2];
        wgtL[c]++;
      }
    }
    if (y % 128 === 127) yield;
  }
  const grid = pushPull(acc, wgt, gw, gh); // normalised r, g, b, water per cell
  const landGrid = pushPull(accL, wgtL, gw, gh);
  const cell = new Float32Array(4);
  const landCell = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (cover[k] && zbuf[k] !== -Infinity) continue;
      bilinear(grid, gw, gh, (x + 0.5) / B - 0.5, (y + 0.5) / B - 0.5, cell);
      const o = k * 4;
      const seaDisc = zbuf[k] !== -Infinity && water[k] === 1;
      water[k] = cell[3] >= 0.5 ? 1 : 0;
      cv.kind[k] = water[k] ? 2 : 1;
      if (water[k] && seaDisc) continue; // keep the sea disc's own colour
      if (!water[k]) {
        bilinear(landGrid, gw, gh, (x + 0.5) / B - 0.5, (y + 0.5) / B - 0.5, landCell);
        cell.set(landCell.subarray(0, 3));
      }
      const dim = water[k] ? 1 : 0.9; // land beyond the modelled terrain: a touch darker
      data[o] = cell[0] * dim;
      data[o + 1] = cell[1] * dim;
      data[o + 2] = cell[2] * dim;
      data[o + 3] = 255;
    }
    if (y % 128 === 127) yield;
  }
  // the minimap's flat 2D look: only the layout (water, woods, buildings) is kept
  if (style) return yield* stylize(cv, b, style);
  // light shorelines along every water edge
  const shoreline = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (water[k] && ((x > 0 && !water[k - 1]) || (x < w - 1 && !water[k + 1]) || (y > 0 && !water[k - w]) || (y < h - 1 && !water[k + w]))) shoreline[k] = 1;
    }
  }
  for (let k = 0; k < w * h; k++) {
    if (!shoreline[k]) continue;
    const o = k * 4;
    data[o] += (255 - data[o]) * 0.45;
    data[o + 1] += (255 - data[o + 1]) * 0.45;
    data[o + 2] += (255 - data[o + 2]) * 0.45;
  }
  // colour for beyond the image: the average along its border
  const fill: [number, number, number] = [0, 0, 0];
  let fc = 0;
  const addFill = (k: number) => {
    fill[0] += data[k * 4];
    fill[1] += data[k * 4 + 1];
    fill[2] += data[k * 4 + 2];
    fc++;
  };
  for (let x = 0; x < w; x++) {
    addFill(x);
    addFill((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    addFill(y * w);
    addFill(y * w + w - 1);
  }
  for (let i = 0; i < 3; i++) fill[i] /= fc;
  return { w, h, data, fill };
}

/**
 * Fill empty cells of a weighted grid from their surroundings (push-pull).
 * `acc` holds 4 summed channels per cell, `wgt` the weights; returns the
 * normalised channels with every cell filled.
 */
function pushPull(acc: Float32Array, wgt: Float32Array, gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh * 4);
  let empty = 0;
  for (let c = 0; c < gw * gh; c++) {
    if (wgt[c] > 0) for (let k = 0; k < 4; k++) out[c * 4 + k] = acc[c * 4 + k] / wgt[c];
    else empty++;
  }
  if (!empty) return out;
  if (gw === 1 && gh === 1) {
    out.set([128, 128, 128, 0]); // nothing at all: neutral grey
    return out;
  }
  // push: a half-size grid of the sums
  const hw = Math.ceil(gw / 2);
  const hh = Math.ceil(gh / 2);
  const acc2 = new Float32Array(hw * hh * 4);
  const wgt2 = new Float32Array(hw * hh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      const p = (y >> 1) * hw + (x >> 1);
      for (let k = 0; k < 4; k++) acc2[p * 4 + k] += acc[c * 4 + k];
      wgt2[p] += wgt[c];
    }
  }
  const coarse = pushPull(acc2, wgt2, hw, hh);
  // pull: empty cells take the (smoothly interpolated) coarser value
  const v = new Float32Array(4);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = y * gw + x;
      if (wgt[c] > 0) continue;
      bilinear(coarse, hw, hh, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5, v);
      out.set(v, c * 4);
    }
  }
  return out;
}

/** Bilinear lookup of a 4-channel grid at fractional cell coordinates (clamped). */
function bilinear(g: Float32Array, gw: number, gh: number, fx: number, fy: number, out: Float32Array) {
  fx = Math.min(gw - 1, Math.max(0, fx));
  fy = Math.min(gh - 1, Math.max(0, fy));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  for (let k = 0; k < 4; k++) {
    const a = g[(y0 * gw + x0) * 4 + k];
    const b = g[(y0 * gw + x1) * 4 + k];
    const c = g[(y1 * gw + x0) * 4 + k];
    const d = g[(y1 * gw + x1) * 4 + k];
    out[k] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
}

function rgbAt(attr: THREE.BufferAttribute | THREE.InstancedBufferAttribute, i: number, out: THREE.Color) {
  return out.setRGB(attr.getX(i), attr.getY(i), attr.getZ(i));
}

/** Bounds of the map for a route: its footprint plus a margin, at a resolution that keeps the image small. */
export function boundsFor(route: Route): RasterBounds {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
  for (let i = 0; i < route.x.length; i++) {
    minX = Math.min(minX, route.x[i]);
    maxX = Math.max(maxX, route.x[i]);
    minZ = Math.min(minZ, route.z[i]);
    maxZ = Math.max(maxZ, route.z[i]);
    maxY = Math.max(maxY, route.y[i]);
  }
  minX -= MARGIN;
  minZ -= MARGIN;
  maxX += MARGIN;
  maxZ += MARGIN;
  const mPerPx = Math.max(MIN_M_PER_PX, Math.max(maxX - minX, maxZ - minZ) / MAX_PX);
  return { minX, minZ, maxX, maxZ, mPerPx, maxY: maxY + 1500 };
}

// ---------------------------------------------------------------------------
// Registry: the world view publishes, the minimap consumes
// ---------------------------------------------------------------------------
interface Entry {
  roots: THREE.Object3D[] | null;
  drawn: Route | null;
  version: number;
  map: WorldMap | null;
  mapVersion: number; // version the map was built from
  building: number; // version being built (-1 = none)
}
const entries = new WeakMap<Route, Entry>();
const entryFor = (route: Route) => {
  let e = entries.get(route);
  if (!e) entries.set(route, (e = { roots: null, drawn: null, version: 0, map: null, mapVersion: -1, building: -1 }));
  return e;
};

/**
 * Called by the world view whenever it (re)builds the scenery of `route`.
 * `drawn` is the route the meshes were built from (it may have exaggerated heights).
 */
export function registerWorld(route: Route, drawn: Route, roots: THREE.Object3D[]) {
  const e = entryFor(route);
  e.roots = roots;
  e.drawn = drawn;
  e.version++;
}

/** Forget the meshes of `route` (the view is going away); an already built map is kept. */
export function releaseWorld(route: Route) {
  const e = entries.get(route);
  if (e) e.roots = null;
}

/**
 * The top-down map of `route`'s world, or null while it is not ready yet (the
 * first call starts building it in the background). While a newer version is
 * being built, the previous map is returned.
 */
export function worldMap(route: Route): WorldMap | null {
  const e = entries.get(route);
  if (!e) return null;
  if (e.roots && e.mapVersion !== e.version && e.building !== e.version) start(route, e);
  return e.map;
}

function start(route: Route, e: Entry) {
  const version = e.version;
  const roots = e.roots!;
  const b = boundsFor(e.drawn ?? route);
  const job = rasterizeWorld(roots, b, styleFor(route));
  e.building = version;
  const tick = () => {
    if (e.version !== version) {
      // superseded by a rebuild: let the next worldMap() call start over
      if (e.building === version) e.building = -1;
      return;
    }
    const t0 = performance.now();
    let r = job.next();
    while (!r.done && performance.now() - t0 < 8) r = job.next();
    if (!r.done) {
      setTimeout(tick, 16);
      return;
    }
    const { w, h, data, fill } = r.value;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0);
    const map: WorldMap = { canvas, minX: b.minX, minZ: b.minZ, mPerPx: b.mPerPx, fill: `rgb(${fill.map(Math.round).join(',')})` };
    e.map = map;
    e.mapVersion = version;
    e.building = -1;
    if (e.version === version) e.roots = null; // done with the meshes: don't keep them alive
  };
  setTimeout(tick, 0);
}

// ---------------------------------------------------------------------------
// Flat 2D style: the minimap draws the real layout (where the water, woods and
// buildings are) in simple flat map colours, not a shaded render of the 3D view.
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
export interface MapStyle {
  ground: RGB;
  light: RGB;
  dark: RGB;
  /** woods / tree cover, blended over the ground by `patchA` */
  patch: RGB;
  patchA: number;
  water: RGB;
  shore: RGB;
  building: RGB;
  seed: number;
}

type Pal = Omit<MapStyle, 'seed'>;
const ROOF: RGB = [226, 222, 212];
const PALETTES: Record<string, Pal> = {
  countryside: { ground: [116, 178, 70], light: [150, 202, 92], dark: [84, 146, 54], patch: [52, 108, 38], patchA: 0.6, water: [143, 211, 240], shore: [200, 236, 250], building: ROOF },
  redwoods: { ground: [88, 146, 66], light: [112, 166, 80], dark: [62, 116, 52], patch: [36, 84, 34], patchA: 0.6, water: [134, 201, 230], shore: [194, 230, 244], building: ROOF },
  bigsur: { ground: [160, 172, 88], light: [192, 186, 112], dark: [116, 146, 70], patch: [86, 120, 52], patchA: 0.6, water: [124, 198, 236], shore: [196, 232, 248], building: ROOF },
  zion: { ground: [196, 128, 88], light: [214, 156, 112], dark: [170, 104, 72], patch: [110, 130, 66], patchA: 0.6, water: [143, 208, 232], shore: [205, 234, 243], building: ROOF },
  synthwave: { ground: [38, 14, 62], light: [58, 22, 88], dark: [22, 8, 40], patch: [255, 43, 214], patchA: 0.3, water: [18, 6, 42], shore: [25, 243, 255], building: [90, 40, 130] },
  aurora: { ground: [196, 210, 222], light: [226, 236, 244], dark: [150, 168, 186], patch: [60, 72, 90], patchA: 0.5, water: [14, 36, 56], shore: [95, 224, 168], building: [120, 90, 70] },
  alien: { ground: [72, 40, 110], light: [96, 58, 140], dark: [48, 26, 82], patch: [64, 224, 200], patchA: 0.4, water: [27, 143, 154], shore: [143, 255, 240], building: [150, 120, 190] },
  neoncity: { ground: [30, 27, 40], light: [46, 40, 60], dark: [18, 16, 26], patch: [255, 47, 142], patchA: 0.3, water: [11, 24, 48], shore: [33, 228, 255], building: [70, 64, 92] },
  iceland: { ground: [120, 112, 98], light: [176, 150, 106], dark: [70, 68, 66], patch: [100, 140, 58], patchA: 0.6, water: [166, 207, 216], shore: [214, 230, 232], building: ROOF },
  crystal: { ground: [52, 42, 72], light: [74, 60, 102], dark: [34, 28, 50], patch: [154, 91, 255], patchA: 0.4, water: [47, 217, 200], shore: [191, 247, 240], building: [120, 100, 160] },
  kyoto: { ground: [132, 168, 92], light: [150, 178, 104], dark: [74, 112, 64], patch: [232, 150, 182], patchA: 0.55, water: [134, 196, 214], shore: [212, 236, 240], building: [140, 120, 110] },
  patagonia: { ground: [196, 172, 112], light: [218, 196, 136], dark: [150, 140, 92], patch: [100, 120, 84], patchA: 0.6, water: [70, 200, 196], shore: [191, 238, 232], building: ROOF },
};

export function styleFor(route: Route): MapStyle {
  const pal = PALETTES[route.preset.theme ?? 'countryside'] ?? PALETTES.countryside;
  return { ...pal, seed: route.seed };
}

/** Colour of open ground on the minimap (also shown before the map is ready). */
export function mapGround(route: Route): string {
  return `rgb(${styleFor(route).ground.join(',')})`;
}

const hash2 = (ix: number, iy: number, seed: number) => {
  let t = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
};
/** Smooth value noise in [0, 1]. */
function valueNoise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let tx = x - ix, ty = y - iy;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

const mix = (a: RGB, b: RGB, t: number, out: RGB) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

function* stylize(cv: Canvas2, b: RasterBounds, s: MapStyle): Generator<void, Raster, void> {
  const { w, h, kind, water } = cv;
  const data = new Uint8ClampedArray(w * h * 4);
  const isWater = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || water[y * w + x] === 1;
  // shoreline about 6 m wide (at least one pixel)
  const sr = Math.max(1, Math.round(6 / b.mPerPx));
  const c: RGB = [0, 0, 0];
  const land: RGB = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const wz = b.minZ + (y + 0.5) * b.mPerPx;
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const o = k * 4;
      if (water[k]) {
        let shore = false;
        for (let d = 1; d <= sr && !shore; d++) shore = !isWater(x - d, y) || !isWater(x + d, y) || !isWater(x, y - d) || !isWater(x, y + d);
        const col = shore ? s.shore : s.water;
        data[o] = col[0];
        data[o + 1] = col[1];
        data[o + 2] = col[2];
        data[o + 3] = 255;
        continue;
      }
      // soft two-octave ground tint, like a game minimap
      const wx = b.minX + (x + 0.5) * b.mPerPx;
      const t = Math.min(1, Math.max(0, valueNoise(wx / 350, wz / 350, s.seed) * 0.7 + valueNoise(wx / 100, wz / 100, s.seed + 7) * 0.3));
      if (t < 0.5) mix(s.dark, s.ground, t * 2, land);
      else mix(s.ground, s.light, t * 2 - 1, land);
      const near = (x > 0 && kind[k - 1] === 3) || (x < w - 1 && kind[k + 1] === 3) || (y > 0 && kind[k - w] === 3) || (y < h - 1 && kind[k + w] === 3);
      if (kind[k] === 3) mix(land, s.patch, s.patchA, c);
      else if (near && kind[k] !== 4) mix(land, s.patch, s.patchA * 0.6, c);
      else if (kind[k] === 4) mix(land, s.building, 0.85, c);
      else c.splice(0, 3, ...land);
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
    if (y % 24 === 23) yield;
  }
  return { w, h, data, fill: [...s.ground] as RGB };
}
