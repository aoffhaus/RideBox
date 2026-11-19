import { memo } from 'react';
import type { Route } from '../world/route';
import type { Settings } from '../storage/db';
import { elevUnit, fmtElev } from './format';

export function gradeColor(g: number): string {
  const p = g * 100;
  if (p < -2) return '#5fa8ff';
  if (p < 2) return '#3fb950';
  if (p < 4) return '#c5d94a';
  if (p < 6) return '#f2c94c';
  if (p < 8) return '#f2994a';
  return '#eb5757';
}

const BEHIND = 250;
const AHEAD = 2500;
const STEP = 25;

/** Upcoming road profile (next 2.5 km), coloured by gradient, with the rider marker. */
export const ElevationProfile = memo(function ElevationProfile({
  route,
  distance,
  grade,
  settings,
}: {
  route: Route;
  distance: number;
  /** current road grade (fraction), shown as the live readout at the rider marker */
  grade: number;
  settings: Settings;
}) {
  // quantize so we re-render ~every 5 m, not every frame
  const d0 = Math.round(distance / 5) * 5;
  const pts: { x: number; y: number }[] = [];
  for (let s = -BEHIND; s <= AHEAD; s += STEP) pts.push({ x: s, y: route.at(d0 + s).y });
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    min = Math.min(min, p.y);
    max = Math.max(max, p.y);
  }
  const span = Math.max(40, max - min);
  const W = 340;
  const H = 86;
  const X = (s: number) => ((s + BEHIND) / (AHEAD + BEHIND)) * W;
  const Y = (y: number) => H - 6 - ((y - min) / span) * (H - 20);
  const polys = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const g = (b.y - a.y) / STEP;
    polys.push(
      <path
        key={k}
        d={`M${X(a.x)},${H} L${X(a.x)},${Y(a.y)} L${X(b.x)},${Y(b.y)} L${X(b.x)},${H} Z`}
        fill={gradeColor(g)}
        opacity={a.x < 0 ? 0.35 : 0.9}
      />,
    );
  }
  const here = route.at(d0);
  // gain over the next 1 km
  const ahead1k = route.at(d0 + 1000).y - here.y;
  let climb = 0;
  for (let k = 0; k < pts.length - 1; k++) if (pts[k].x >= 0 && pts[k + 1].y > pts[k].y) climb += pts[k + 1].y - pts[k].y;
  return (
    <div className="elev panel">
      <div className="elev-head">
        <span>Road ahead</span>
        <span className="muted" title={`Climbing in the next 2.5 km: ${fmtElev(climb, settings)} ${elevUnit(settings)}`}>
          next 1 km {ahead1k >= 0 ? '+' : ''}
          {fmtElev(ahead1k, settings)} {elevUnit(settings)}
        </span>
      </div>
      <div className="elev-plot">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
          {polys}
          <line x1={X(0)} x2={X(0)} y1={0} y2={H} stroke="#fff" strokeWidth={2} />
          <circle cx={X(0)} cy={Y(here.y)} r={4.5} fill="#fff" stroke="#111" strokeWidth={1.5} />
        </svg>
        <div className="elev-grade" title="Current grade" style={{ left: `${(X(0) / W) * 100}%`, borderColor: gradeColor(grade) }}>
          <span style={{ color: gradeColor(grade) }}>{(grade * 100).toFixed(1)}</span>
          <small>%</small>
        </div>
      </div>
    </div>
  );
});
