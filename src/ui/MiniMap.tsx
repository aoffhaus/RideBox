import { useEffect, useMemo, useRef } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import type { Settings } from '../storage/db';
import { formatDuration, intervalFtpFraction, zoneFor, type Interval } from '../workout/model';
import { rng, type Route } from '../world/route';

const W = 280;
const H = 210;
const CX = W / 2;
/** Perspective strength: the top edge shows (1 + T)× as much ground as the bottom edge. */
const T = 0.55;
/** Rider's screen row as a fraction of the height (from the top). */
const RIDER_V = 0.72;
// The flat (top-down) map is rendered to an offscreen "source" canvas, then
// warped row by row onto the visible canvas to give a tilted look.
const SW = Math.ceil(W * (1 + T));
const SH = Math.ceil(H * (1 + T / 2));
const SCX = SW / 2;
const srcRowFromBottom = (u: number) => H * (u + (T * u * u) / 2);
const RIDER_SY = SH - srcRowFromBottom(1 - RIDER_V);

export function ivColor(iv: Interval | undefined, ftp: number) {
  if (!iv) return '#ffffff';
  return iv.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(iv, ftp)).color;
}

interface Palette {
  ground: [number, number, number];
  light: [number, number, number];
  dark: [number, number, number];
  patch: string;
  water: string;
  shore: string;
}

const PALETTES: Record<string, Palette> = {
  countryside: { ground: [116, 178, 70], light: [150, 202, 92], dark: [84, 146, 54], patch: 'rgba(70,128,48,0.4)', water: '#8fd3f0', shore: '#c8ecfa' },
  redwoods: { ground: [88, 146, 66], light: [112, 166, 80], dark: [62, 116, 52], patch: 'rgba(42,92,40,0.45)', water: '#86c9e6', shore: '#c2e6f4' },
  bigsur: { ground: [160, 172, 88], light: [192, 186, 112], dark: [116, 146, 70], patch: 'rgba(98,130,60,0.5)', water: '#7cc6ec', shore: '#c4e8f8' },
  zion: { ground: [196, 128, 88], light: [214, 156, 112], dark: [170, 104, 72], patch: 'rgba(120,138,72,0.5)', water: '#8fd0e8', shore: '#cdeaf3' },
  synthwave: { ground: [38, 14, 62], light: [58, 22, 88], dark: [22, 8, 40], patch: 'rgba(255,43,214,0.22)', water: '#12062a', shore: '#19f3ff' },
  aurora: { ground: [196, 210, 222], light: [226, 236, 244], dark: [150, 168, 186], patch: 'rgba(60,72,90,0.35)', water: '#0e2438', shore: '#5fe0a8' },
  crystal: { ground: [52, 42, 72], light: [74, 60, 102], dark: [34, 28, 50], patch: 'rgba(154,91,255,0.3)', water: '#2fd9c8', shore: '#bff7f0' },
};

interface Blob {
  x: number;
  z: number;
  r: number; // bounding radius
  pts: [number, number][];
  water: boolean;
}

interface Layers {
  terrain: HTMLCanvasElement; // low-res colour-variation raster in world space
  minX: number;
  minZ: number;
  mPerPx: number;
  blobs: Blob[];
  pal: Palette;
  outline: [number, number][];
}

/** Deterministic (route-seeded) terrain colour field, lakes and darker patches. */
function buildLayers(route: Route): Layers {
  const pal = PALETTES[route.preset.theme ?? 'countryside'] ?? PALETTES.countryside;
  const outline: [number, number][] = [];
  const every = Math.max(1, Math.round(10 / route.step));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < route.x.length; i += every) {
    const x = route.x[i], z = route.z[i];
    outline.push([x, z]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  outline.push([route.x[0], route.z[0]]);
  const margin = 4000;
  minX -= margin; minZ -= margin; maxX += margin; maxZ += margin;

  const rand = rng(route.seed * 31337 + route.preset.id.length * 977 + Math.round(route.length));

  // ---- terrain: two octaves of value noise at ~25 m/px, smoothed when upscaled ----
  const mPerPx = 25;
  const tw = Math.ceil((maxX - minX) / mPerPx);
  const th = Math.ceil((maxZ - minZ) / mPerPx);
  const lattice = (cell: number) => {
    const gw = Math.ceil(tw / cell) + 2, gh = Math.ceil(th / cell) + 2;
    const v = new Float32Array(gw * gh);
    for (let i = 0; i < v.length; i++) v[i] = rand();
    return (x: number, y: number) => {
      const fx = x / cell, fy = y / cell;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy;
      tx = tx * tx * (3 - 2 * tx);
      ty = ty * ty * (3 - 2 * ty);
      const a = v[iy * gw + ix], b = v[iy * gw + ix + 1];
      const c = v[(iy + 1) * gw + ix], d = v[(iy + 1) * gw + ix + 1];
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    };
  };
  const n1 = lattice(14);
  const n2 = lattice(4);
  const terrain = document.createElement('canvas');
  terrain.width = tw;
  terrain.height = th;
  const tg = terrain.getContext('2d')!;
  const img = tg.createImageData(tw, th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const t = Math.min(1, Math.max(0, n1(x, y) * 0.62 + n2(x, y) * 0.28 + rand() * 0.1));
      const [c0, c1] = t < 0.5 ? [pal.dark, pal.ground] : [pal.ground, pal.light];
      const w = t < 0.5 ? t * 2 : t * 2 - 1;
      const o = (y * tw + x) * 4;
      img.data[o] = c0[0] + (c1[0] - c0[0]) * w;
      img.data[o + 1] = c0[1] + (c1[1] - c0[1]) * w;
      img.data[o + 2] = c0[2] + (c1[2] - c0[2]) * w;
      img.data[o + 3] = 255;
    }
  }
  tg.putImageData(img, 0, 0);

  // ---- lakes and darker patches, kept clear of the road ----
  const near = outline.filter((_, i) => i % 2 === 0); // ~20 m spacing is plenty here
  const clearance = (x: number, z: number) => {
    let best = Infinity;
    for (const [px, pz] of near) {
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const blobs: Blob[] = [];
  const area = ((maxX - minX) * (maxZ - minZ)) / 1e6; // km²
  const tries = Math.round(area * 6);
  for (let i = 0; i < tries; i++) {
    const water = rand() < 0.6;
    const x = minX + rand() * (maxX - minX);
    const z = minZ + rand() * (maxZ - minZ);
    const big = rand() < 0.15;
    const r = (big ? 180 + rand() * 360 : 35 + rand() * 120) * (water ? 1 : 1.4);
    const free = clearance(x, z);
    if (free < r * 1.1 + 22) continue;
    if (blobs.some((b) => b.water && water && Math.hypot(b.x - x, b.z - z) < b.r + r + 20)) continue;
    // irregular outline: radius modulated by a few random harmonics
    const n = 26;
    const harm = [1, 2, 3, 5].map((k) => ({ k, a: (rand() * 0.22) / Math.sqrt(k), p: rand() * Math.PI * 2 }));
    const stretch = 0.65 + rand() * 0.5;
    const rot = rand() * Math.PI;
    const pts: [number, number][] = [];
    for (let j = 0; j < n; j++) {
      const t = (j / n) * Math.PI * 2;
      let m = 1;
      for (const h of harm) m += h.a * Math.sin(h.k * t + h.p);
      const lx = Math.cos(t) * r * m;
      const lz = Math.sin(t) * r * m * stretch;
      pts.push([x + lx * Math.cos(rot) - lz * Math.sin(rot), z + lx * Math.sin(rot) + lz * Math.cos(rot)]);
    }
    blobs.push({ x, z, r: r * 1.5, pts, water });
  }
  blobs.sort((a, b) => Number(a.water) - Number(b.water)); // patches under water
  return { terrain, minX, minZ, mPerPx, blobs, pal, outline };
}

/** Smooth closed path through the points (quadratic curves via midpoints). */
function blobPath(g: CanvasRenderingContext2D, pts: [number, number][]) {
  const n = pts.length;
  const mid = (i: number): [number, number] => {
    const a = pts[i % n], b = pts[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  g.beginPath();
  const m0 = mid(0);
  g.moveTo(m0[0], m0[1]);
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n];
    const m = mid(i);
    g.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  g.closePath();
}

/**
 * Heading-up mini map in a tilted, top-down "game minimap" style: soft green
 * terrain with lakes, the road as a pale ribbon with white edges, the road
 * between you and each upcoming interval start tinted in that interval's zone
 * colour, and a dot where each starts. Marker positions are projected from your
 * current speed — the same projection the arches use, so map and arches agree.
 */
export function MiniMap({ session, settings, snap }: { session: RideSession; settings: Settings; snap: Snapshot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const route = session.route;
  const ftp = settings.ftp;
  const layers = useMemo(() => buildLayers(route), [route]);

  useEffect(() => {
    const cv = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d')!;
    const src = document.createElement('canvas');
    src.width = SW * dpr;
    src.height = SH * dpr;
    const sg = src.getContext('2d')!;
    const { terrain, blobs, pal, outline } = layers;

    let raf = 0;
    let heading: number | null = null;
    let scale = 0.25; // source px per metre
    let last = performance.now();
    let lastDraw = 0;
    let pulse = 0;

    // source (flat map, CSS px) → screen (CSS px)
    const warp = (sx: number, sy: number): [number, number] => {
      const s = SH - sy; // rows from bottom
      const u = (Math.sqrt(1 + 2 * T * (s / H)) - 1) / T;
      const k = 1 / (1 + T * u);
      return [CX + (sx - SCX) * k, H * (1 - u)];
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      if (now - lastDraw < 30) return; // ~30 fps is plenty for a minimap
      lastDraw = now;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      pulse += dt;
      const s = session.snapshot();
      const d = s.distance;
      const p = route.at(d);
      // smooth the heading so the map doesn't spin on every bend
      const target = route.at(d + 30).heading;
      if (heading == null) heading = target;
      let dh = target - heading;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      heading += dh * (1 - Math.exp(-dt * 2));

      // zoom so the next interval start fits (between 350 m and 2.5 km ahead)
      const st = s.workout;
      const next = st && !st.finished ? s.upcoming[0] : undefined;
      const ahead = next ? Math.min(2500, Math.max(450, (next.distance - d) * 1.2)) : 800;
      const want = (RIDER_SY - 24) / ahead;
      scale += (want - scale) * (1 - Math.exp(-dt * 1.5));

      const sh = Math.sin(heading);
      const ch = Math.cos(heading);
      // world (x, z) → source: right = (-sin h, cos h), up = (cos h, sin h)
      const a = -sh * scale;
      const c = ch * scale;
      const b = -ch * scale;
      const dd = -sh * scale;
      const e = SCX - (a * p.x + c * p.z);
      const f = RIDER_SY - (b * p.x + dd * p.z);
      const px = 1 / scale; // one source pixel in metres
      const viewR = Math.hypot(SW, SH) * px; // metres from rider that can be visible

      // ---------- flat map into the source canvas ----------
      sg.setTransform(dpr, 0, 0, dpr, 0, 0);
      sg.fillStyle = `rgb(${pal.ground.join(',')})`;
      sg.fillRect(0, 0, SW, SH);
      sg.setTransform(a * dpr, b * dpr, c * dpr, dd * dpr, e * dpr, f * dpr);
      sg.imageSmoothingEnabled = true;
      sg.drawImage(terrain, layers.minX, layers.minZ, terrain.width * layers.mPerPx, terrain.height * layers.mPerPx);

      for (const bl of blobs) {
        if (Math.hypot(bl.x - p.x, bl.z - p.z) > viewR + bl.r) continue;
        blobPath(sg, bl.pts);
        if (bl.water) {
          sg.fillStyle = pal.shore;
          sg.fill();
          sg.lineWidth = 3.5 * px;
          sg.strokeStyle = pal.shore;
          sg.stroke();
          sg.fillStyle = pal.water;
          sg.fill();
        } else {
          sg.fillStyle = pal.patch;
          sg.fill();
        }
      }

      // road ribbon: soft shadow, pale edge, grey surface
      sg.lineJoin = sg.lineCap = 'round';
      sg.beginPath();
      outline.forEach(([x, z], i) => (i ? sg.lineTo(x, z) : sg.moveTo(x, z)));
      sg.strokeStyle = 'rgba(30,50,20,0.22)';
      sg.lineWidth = 15 * px;
      sg.stroke();
      sg.strokeStyle = '#f3f5ef';
      sg.lineWidth = 11 * px;
      sg.stroke();
      sg.strokeStyle = '#b8bdc2';
      sg.lineWidth = 8.5 * px;
      sg.stroke();

      const stepM = Math.max(5, 3 * px);
      const strokeAlong = (from: number, to: number) => {
        sg.beginPath();
        for (let t = from; ; t = Math.min(to, t + stepM)) {
          const q = route.at(t);
          if (t === from) sg.moveTo(q.x, q.z);
          else sg.lineTo(q.x, q.z);
          if (t >= to) break;
        }
      };

      if (st && !st.finished && st.interval) {
        // workout ahead: the road tinted between projected interval starts
        const ivs = session.engine!.intervals;
        let from = d;
        let color = ivColor(st.interval, ftp);
        const segs: { from: number; to: number; color: string }[] = [];
        for (const up of s.upcoming) {
          segs.push({ from, to: up.distance, color });
          from = up.distance;
          color = ivColor(ivs[up.index], ftp);
        }
        sg.globalAlpha = 0.9;
        for (const sg2 of segs) {
          if (sg2.to - sg2.from < 0.5) continue;
          strokeAlong(sg2.from, sg2.to);
          sg.strokeStyle = sg2.color;
          sg.lineWidth = 6.5 * px;
          sg.stroke();
        }
        sg.globalAlpha = 1;
        // start markers (furthest first so the next one is on top)
        for (let k = s.upcoming.length - 1; k >= 0; k--) {
          const up = s.upcoming[k];
          const q = route.at(up.distance);
          const isFinish = up.index >= ivs.length;
          const r = (k === 0 ? 6 + Math.sin(pulse * 5) * 1 : 4.5) * px;
          sg.beginPath();
          sg.arc(q.x, q.z, r, 0, Math.PI * 2);
          sg.fillStyle = isFinish ? '#ffffff' : ivColor(ivs[up.index], ftp);
          sg.fill();
          sg.lineWidth = 2 * px;
          sg.strokeStyle = isFinish ? '#222' : '#ffffff';
          sg.stroke();
        }
      } else {
        // free ride: the route ahead as an orange stripe down the road
        strokeAlong(d, d + ahead * 1.6);
        sg.strokeStyle = 'rgba(255,150,40,0.9)';
        sg.lineWidth = 4.5 * px;
        sg.stroke();
      }

      // ---------- warp the flat map onto the visible canvas ----------
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.imageSmoothingEnabled = true;
      const rows = H * dpr;
      const strip = 2;
      for (let j = 0; j < rows; j += strip) {
        const u0 = 1 - j / rows; // top of the strip, 1 = top edge
        const u1 = 1 - Math.min(rows, j + strip) / rows;
        const uc = (u0 + u1) / 2;
        const k = 1 / (1 + T * uc);
        const sy0 = (SH - srcRowFromBottom(u0)) * dpr;
        const sy1 = (SH - srcRowFromBottom(u1)) * dpr;
        const sw = (W / k) * dpr;
        g.drawImage(src, SCX * dpr - sw / 2, sy0, sw, sy1 - sy0, 0, j, W * dpr, strip + 0.5);
      }
      // gentle haze toward the far edge for depth
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const haze = g.createLinearGradient(0, 0, 0, H * 0.45);
      haze.addColorStop(0, 'rgba(225,240,255,0.28)');
      haze.addColorStop(1, 'rgba(225,240,255,0)');
      g.fillStyle = haze;
      g.fillRect(0, 0, W, H * 0.45);

      // rider: small orange arrow with a white outline, always pointing up
      const ry = H * RIDER_V;
      g.beginPath();
      g.arc(CX, ry, 11, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,170,40,0.25)';
      g.fill();
      g.beginPath();
      g.moveTo(CX, ry - 9);
      g.lineTo(CX + 7, ry + 7);
      g.lineTo(CX, ry + 3.5);
      g.lineTo(CX - 7, ry + 7);
      g.closePath();
      g.fillStyle = '#ff9f1c';
      g.fill();
      g.lineWidth = 1.6;
      g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      g.stroke();

      // countdown tag next to the next interval start
      if (next) {
        const q = route.at(next.distance);
        const [qx, qy] = warp(a * q.x + c * q.z + e, b * q.x + dd * q.z + f);
        const txt = formatDuration(Math.ceil(next.startsIn));
        g.font = '600 11px system-ui, sans-serif';
        const tw = g.measureText(txt).width + 10;
        const lx = Math.min(W - tw - 4, Math.max(4, qx + 9));
        const ly = Math.min(H - 20, Math.max(30, qy - 20));
        g.fillStyle = 'rgba(14,18,24,0.72)';
        g.beginPath();
        g.roundRect(lx, ly, tw, 17, 8.5);
        g.fill();
        g.fillStyle = '#fff';
        g.fillText(txt, lx + 5, ly + 12.5);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [session, route, layers, ftp]);

  // progress pill: workout progress when a workout is loaded, else lap progress
  const st = snap.workout;
  let pct: number;
  if (st) pct = st.finished ? 100 : (st.elapsed / Math.max(1, st.elapsed + st.totalRemaining)) * 100;
  else pct = ((snap.distance % route.length) / route.length) * 100;

  return (
    <div className="minimap">
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
      <div className="mm-pill" title={st ? 'Workout progress' : 'Lap progress'}>
        {st ? (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <path d="M9.5 1 3 9h4l-1 6 6.5-8h-4z" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <path d="M3 1v14h1.6V9.5h8.4L11 5.75 13 2H4.6V1z" fill="currentColor" />
          </svg>
        )}
        <span>{Math.floor(pct)}%</span>
      </div>
    </div>
  );
}
