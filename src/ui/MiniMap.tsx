import { useEffect, useMemo, useRef } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import type { Settings } from '../storage/db';
import { formatDuration, intervalFtpFraction, zoneFor, type Interval } from '../workout/model';
import type { Route } from '../world/route';
import { themeFor } from '../world/themes';
import { worldMap } from '../world/worldMap';

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

/** Decimated route outline (every ~10 m), closed. */
function routeOutline(route: Route): [number, number][] {
  const outline: [number, number][] = [];
  const every = Math.max(1, Math.round(10 / route.step));
  for (let i = 0; i < route.x.length; i += every) outline.push([route.x[i], route.z[i]]);
  outline.push([route.x[0], route.z[0]]);
  return outline;
}

/**
 * Heading-up mini map in a tilted, top-down "game minimap" style: the actual
 * world around you seen from above (the 3D scenery rasterised once per route,
 * see world/worldMap.ts), the road as a pale ribbon with white edges, the road
 * between you and each upcoming interval start tinted in that interval's zone
 * colour, and a dot where each starts. Marker positions are projected from your
 * current speed — the same projection the arches use, so map and arches agree.
 */
export function MiniMap({ session, settings, snap }: { session: RideSession; settings: Settings; snap: Snapshot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const route = session.route;
  const ftp = settings.ftp;
  const outline = useMemo(() => routeOutline(route), [route]);
  // shown until the world map is ready (the 3D view registers its scenery first)
  const placeholder = useMemo(() => {
    const t = themeFor(route);
    return t.groundColor ?? t.haze;
  }, [route]);

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

      // ---------- flat map into the source canvas ----------
      const map = worldMap(route);
      sg.setTransform(dpr, 0, 0, dpr, 0, 0);
      sg.fillStyle = map ? map.fill : placeholder;
      sg.fillRect(0, 0, SW, SH);
      sg.setTransform(a * dpr, b * dpr, c * dpr, dd * dpr, e * dpr, f * dpr);
      if (map) {
        // just pan/rotate the pre-rendered world image
        sg.imageSmoothingEnabled = true;
        sg.drawImage(map.canvas, map.minX, map.minZ, map.canvas.width * map.mPerPx, map.canvas.height * map.mPerPx);
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
  }, [session, route, outline, placeholder, ftp]);

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
