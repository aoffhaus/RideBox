import { useLayoutEffect, useRef, useState } from 'react';
import type { Settings } from '../storage/types';
import { ftpOn, isBeginning, weightOn } from '../training/ftp';
import { addDays, dayStart } from '../training/load';
import { SERIES } from './FitnessChart';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export type FtpMetric = 'ftp' | 'wkg';

const fmtDay = (k: string) => dayStart(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const wkg = (ftp: number, kg: number) => (kg > 0 ? ftp / kg : 0);

/** SVG path through the points as a monotone cubic curve (smooth, never overshoots between points). */
function smoothPath(p: { x: number; y: number }[]): string {
  if (!p.length) return '';
  if (p.length === 1) return `M${p[0].x},${p[0].y}`;
  const n = p.length;
  const dx = p.slice(1).map((q, i) => q.x - p[i].x);
  const m = p.slice(1).map((q, i) => (dx[i] ? (q.y - p[i].y) / dx[i] : 0));
  const t = p.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * m[i];
      t[i + 1] = s * b * m[i];
    }
  }
  let d = `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const c = dx[i] / 3;
    d += `C${(p[i].x + c).toFixed(1)},${(p[i].y + c * t[i]).toFixed(1)} ${(p[i + 1].x - c).toFixed(1)},${(p[i + 1].y - c * t[i + 1]).toFixed(1)} ${p[i + 1].x.toFixed(1)},${p[i + 1].y.toFixed(1)}`;
  }
  return d;
}

/**
 * FTP (or W/kg) over the last `days` days, as a smooth line through each
 * logged change, from the settings' FTP and weight history up to today.
 */
export function FtpChart({ settings, today, days, metric, height = 200 }: { settings: Settings; today: string; days: number; metric: FtpMetric; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const start = addDays(today, -days);
  // every day the value changed inside the window (FTP changes, and weight changes for W/kg)
  const changeDays = [...(settings.ftpHistory ?? []).map((c) => c.from), ...(metric === 'wkg' ? (settings.weightHistory ?? []).map((c) => c.from) : [])].filter(
    (d) => !isBeginning(d) && d > start && d <= today,
  );
  const dates = [...new Set([start, ...changeDays, today])].sort();
  const pts = dates.map((d) => {
    const ftp = ftpOn(settings, d);
    const kg = weightOn(settings, d);
    return { date: d, ftp, kg, v: metric === 'ftp' ? ftp : wkg(ftp, kg), change: changeDays.includes(d) };
  });
  const M = { l: 44, r: 96, t: 14, b: 24 };
  const iw = W - M.l - M.r;
  const ih = height - M.t - M.b;
  const t0 = dayStart(start).getTime();
  const t1 = dayStart(today).getTime();
  const x = (d: string) => M.l + ((dayStart(d).getTime() - t0) / Math.max(1, t1 - t0)) * iw;
  const vals = pts.map((p) => p.v);
  const pad = metric === 'ftp' ? 10 : 0.1;
  const step = metric === 'ftp' ? (Math.max(...vals) - Math.min(...vals) > 60 ? 20 : 10) : Math.max(...vals) - Math.min(...vals) > 0.6 ? 0.2 : 0.1;
  const lo = Math.floor((Math.min(...vals) - pad) / step) * step;
  const hi = Math.ceil((Math.max(...vals) + pad) / step) * step;
  const y = (v: number) => M.t + ih - ((v - lo) / (hi - lo)) * ih;
  const xy = pts.map((p) => ({ x: x(p.date), y: y(p.v) }));
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  // axis labels: weeks for 6 weeks, months otherwise
  const axis: string[] = [];
  if (days <= 60) {
    for (let k = start; k <= today; k = addDays(k, 7)) axis.push(k);
  } else {
    for (let k = start.slice(0, 7) + '-01'; k <= today; ) {
      if (k >= start) axis.push(k);
      const m = dayStart(k);
      m.setMonth(m.getMonth() + 1);
      k = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`;
    }
  }
  const axisEvery = Math.max(1, Math.ceil(axis.length / 8));
  const fmt = (v: number) => (metric === 'ftp' ? `${Math.round(v)} W` : `${v.toFixed(2)} W/kg`);
  const last = pts[pts.length - 1];
  const h = hover != null ? pts[hover] : null;

  return (
    <div ref={ref} className="chart-wrap">
      <svg
        width={W}
        height={height}
        role="img"
        aria-label={metric === 'ftp' ? 'FTP over time' : 'W/kg over time'}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          // hover the nearest logged change
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const mx = e.clientX - r.left;
          let best: number | null = null;
          pts.forEach((p, i) => {
            if (p.change && Math.abs(xy[i].x - mx) < 24 && (best == null || Math.abs(xy[i].x - mx) < Math.abs(xy[best].x - mx))) best = i;
          });
          setHover(best);
        }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={M.l + iw} y1={y(v)} y2={y(v)} className="grid" />
            <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="tick">{metric === 'ftp' ? v : v.toFixed(1)}</text>
          </g>
        ))}
        {axis.filter((_, i) => i % axisEvery === 0).map((k) => (
          <text key={k} x={x(k)} y={height - 6} className="tick" textAnchor="middle">
            {dayStart(k).toLocaleDateString(undefined, days <= 60 ? { month: 'short', day: 'numeric' } : { month: 'short' })}
          </text>
        ))}
        <path d={smoothPath(xy)} stroke={SERIES.ctl} strokeWidth={2.5} fill="none" strokeLinecap="round" />
        {pts.map((p, i) =>
          p.change ? <circle key={p.date} cx={xy[i].x} cy={xy[i].y} r={hover === i ? 5 : 3.5} fill={SERIES.ctl} stroke="var(--panel)" strokeWidth={2} /> : null,
        )}
        <circle cx={xy[xy.length - 1].x} cy={xy[xy.length - 1].y} r={4} fill={SERIES.ctl} stroke="var(--panel)" strokeWidth={2} />
        <text x={M.l + iw + 6} y={y(last.v) - 2} className="end-label">{fmt(last.v)}</text>
        <text x={M.l + iw + 6} y={y(last.v) + 12} className="tick">{metric === 'ftp' ? `${wkg(last.ftp, last.kg).toFixed(2)} W/kg` : `${last.ftp} W`}</text>
        {h && hover != null && <line x1={xy[hover].x} x2={xy[hover].x} y1={M.t} y2={M.t + ih} className="crosshair" />}
      </svg>
      {h && hover != null && (
        <div className="chart-tip" style={{ left: Math.min(W - 170, Math.max(0, xy[hover].x + 10)), top: 8 }}>
          <b>{fmtDay(h.date)}</b>
          <div>FTP {h.ftp} W</div>
          <div>{wkg(h.ftp, h.kg).toFixed(2)} W/kg at {h.kg.toFixed(1)} kg</div>
        </div>
      )}
    </div>
  );
}
