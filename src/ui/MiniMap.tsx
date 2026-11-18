import { useEffect, useMemo, useRef } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import type { Settings } from '../storage/db';
import { formatDuration, intervalFtpFraction, toWatts, zoneFor, type Interval } from '../workout/model';
import { distUnit, fmtDist } from './format';

const W = 260;
const H = 210;
const CX = W / 2;
const CY = H * 0.7; // rider sits low so you see more road ahead

function ivColor(iv: Interval | undefined, ftp: number) {
  if (!iv) return '#ffffff';
  return iv.free ? '#9aa4b2' : zoneFor(intervalFtpFraction(iv, ftp)).color;
}

/**
 * Heading-up mini map (like Zwift's): the route around you, the road between
 * you and the next interval start drawn in the current interval's colour, the
 * following intervals in their zone colours, and a marker where each starts.
 * Marker positions are projected from your current speed — the same projection
 * the arches use, so the map and arches always agree.
 */
export function MiniMap({ session, settings, snap }: { session: RideSession; settings: Settings; snap: Snapshot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const route = session.route;
  const ftp = settings.ftp;

  // decimated route outline (every ~10 m)
  const outline = useMemo(() => {
    const pts: [number, number][] = [];
    const every = Math.max(1, Math.round(10 / route.step));
    for (let i = 0; i < route.x.length; i += every) pts.push([route.x[i], route.z[i]]);
    pts.push([route.x[0], route.z[0]]);
    return pts;
  }, [route]);

  useEffect(() => {
    const cv = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr;
    cv.height = H * dpr;
    const g = cv.getContext('2d')!;
    let raf = 0;
    let heading: number | null = null;
    let scale = 0.25; // px per metre
    let last = performance.now();
    let pulse = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
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
      const next = s.upcoming[0];
      const ahead = next ? Math.min(2500, Math.max(350, (next.distance - d) * 1.25)) : 600;
      const want = (CY - 18) / ahead;
      scale += (want - scale) * (1 - Math.exp(-dt * 1.5));

      const sh = Math.sin(heading);
      const ch = Math.cos(heading);
      // world (x, z) → screen: right = (-sin h, cos h), up = (cos h, sin h)
      const a = -sh * scale;
      const c = ch * scale;
      const b = -ch * scale;
      const dd = -sh * scale;
      const e = CX - (a * p.x + c * p.z);
      const f = CY - (b * p.x + dd * p.z);

      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      g.save();
      g.beginPath();
      g.roundRect(0, 0, W, H, 12);
      g.clip();
      g.fillStyle = 'rgba(16, 28, 20, 0.82)';
      g.fillRect(0, 0, W, H);

      g.setTransform(a * dpr, b * dpr, c * dpr, dd * dpr, e * dpr, f * dpr);
      const px = 1 / scale; // one screen pixel in metres
      g.lineJoin = g.lineCap = 'round';
      // whole route
      g.beginPath();
      outline.forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 7 * px;
      g.stroke();
      g.strokeStyle = '#8d969f';
      g.lineWidth = 4 * px;
      g.stroke();

      // workout ahead: coloured segments between projected interval starts
      const st = s.workout;
      if (st && !st.finished && st.interval) {
        const ivs = session.engine!.intervals;
        const segs: { from: number; to: number; color: string }[] = [];
        let from = d;
        let color = ivColor(st.interval, ftp);
        for (const u of s.upcoming) {
          segs.push({ from, to: u.distance, color });
          from = u.distance;
          color = ivColor(ivs[u.index], ftp);
        }
        const stepM = Math.max(5, 3 * px);
        for (const sg of segs) {
          if (sg.to - sg.from < 0.5) continue;
          g.beginPath();
          for (let t = sg.from; ; t = Math.min(sg.to, t + stepM)) {
            const q = route.at(t);
            if (t === sg.from) g.moveTo(q.x, q.z);
            else g.lineTo(q.x, q.z);
            if (t >= sg.to) break;
          }
          g.strokeStyle = sg.color;
          g.lineWidth = 5.5 * px;
          g.stroke();
        }
        // markers (furthest first so the next one is on top)
        for (let k = s.upcoming.length - 1; k >= 0; k--) {
          const u = s.upcoming[k];
          const q = route.at(u.distance);
          const isFinish = u.index >= ivs.length;
          const r = (k === 0 ? 7 + Math.sin(pulse * 5) * 1.2 : 5) * px;
          g.beginPath();
          g.arc(q.x, q.z, r, 0, Math.PI * 2);
          g.fillStyle = isFinish ? '#ffffff' : ivColor(ivs[u.index], ftp);
          g.fill();
          g.lineWidth = 2 * px;
          g.strokeStyle = isFinish ? '#111' : '#fff';
          g.stroke();
        }
      }

      // rider arrow (screen space, always pointing up)
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.beginPath();
      g.moveTo(CX, CY - 9);
      g.lineTo(CX + 6.5, CY + 7);
      g.lineTo(CX, CY + 3.5);
      g.lineTo(CX - 6.5, CY + 7);
      g.closePath();
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = '#111';
      g.stroke();

      // label the next start with its countdown
      if (st && !st.finished && next) {
        const q = route.at(next.distance);
        const sx = a * q.x + c * q.z + e;
        const sy = b * q.x + dd * q.z + f;
        const txt = formatDuration(Math.ceil(next.startsIn));
        g.font = '600 12px system-ui, sans-serif';
        const tw = g.measureText(txt).width + 10;
        const lx = Math.min(W - tw - 4, Math.max(4, sx + 10));
        const ly = Math.min(H - 22, Math.max(4, sy - 22));
        g.fillStyle = 'rgba(10,12,16,0.9)';
        g.beginPath();
        g.roundRect(lx, ly, tw, 18, 5);
        g.fill();
        g.fillStyle = '#fff';
        g.fillText(txt, lx + 5, ly + 13);
      }
      g.restore();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [session, route, outline, ftp]);

  // ---- progress row under the map ----
  const st = snap.workout;
  const next = snap.upcoming[0];
  const cur = st?.interval;
  const nextIv = st?.next;
  const k = (st?.intensity ?? 100) / 100;
  const frac = cur ? Math.min(1, Math.max(0, st!.timeInInterval / cur.duration)) : 0;
  const toGo = next ? Math.max(0, next.distance - snap.distance) : 0;

  return (
    <div className="minimap">
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
      {st && !st.finished && cur ? (
        <div className="mm-info">
          <div className="mm-row">
            <span className="mm-label">{nextIv ? 'Next interval in' : 'Workout ends in'}</span>
            <b>{formatDuration(Math.ceil(st.remaining))}</b>
            <span className="muted">
              {fmtDist(toGo, settings)} {distUnit(settings)}
            </span>
          </div>
          <div className="mm-bar">
            <div style={{ width: `${frac * 100}%`, background: ivColor(cur, settings.ftp) }} />
          </div>
          {nextIv && (
            <div className="mm-next">
              <span className="dotc" style={{ background: ivColor(nextIv, settings.ftp) }} />
              {formatDuration(nextIv.duration)}{' '}
              {nextIv.free
                ? 'free ride'
                : nextIv.powerStart === nextIv.powerEnd
                  ? `@ ${Math.round(toWatts(nextIv.powerStart, nextIv.unit, settings.ftp) * k)} W`
                  : `${Math.round(toWatts(nextIv.powerStart, nextIv.unit, settings.ftp) * k)}→${Math.round(toWatts(nextIv.powerEnd, nextIv.unit, settings.ftp) * k)} W`}
            </div>
          )}
        </div>
      ) : (
        <div className="mm-info">
          <div className="mm-row">
            <span className="mm-label">{session.route.preset.name}</span>
            <span className="muted">
              lap {Math.floor(snap.distance / session.route.length) + 1} · {fmtDist(snap.distance % session.route.length, settings)} / {fmtDist(session.route.length, settings)} {distUnit(settings)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
