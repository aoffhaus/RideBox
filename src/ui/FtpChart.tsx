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

const fmtDay = (k: string) => dayStart(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const wkg = (ftp: number, kg: number) => (kg > 0 ? (ftp / kg).toFixed(2) : '–');

/**
 * FTP over time as a step line (FTP changes on a day and holds until the next
 * change), from the settings' FTP history up to today.
 */
export function FtpChart({ settings, today, height = 200 }: { settings: Settings; today: string; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const changes = (settings.ftpHistory ?? []).filter((c) => !isBeginning(c.from) && c.from <= today).map((c) => c.from).sort();
  // start a little before the first change (or 3 months back without one)
  const start = changes.length ? addDays(changes[0], -14) : addDays(today, -90);
  const dates = [start, ...changes.filter((d) => d > start), today];
  const pts = [...new Set(dates)].map((d) => ({ date: d, ftp: ftpOn(settings, d), kg: weightOn(settings, d) }));
  const M = { l: 40, r: 96, t: 14, b: 24 };
  const iw = W - M.l - M.r;
  const ih = height - M.t - M.b;
  const t0 = dayStart(start).getTime();
  const t1 = Math.max(t0 + 86_400_000, dayStart(today).getTime());
  const x = (d: string) => M.l + ((dayStart(d).getTime() - t0) / (t1 - t0)) * iw;
  const vals = pts.map((p) => p.ftp);
  const step = 10;
  const lo = Math.floor((Math.min(...vals) - 10) / step) * step;
  const hi = Math.ceil((Math.max(...vals) + 10) / step) * step;
  const y = (v: number) => M.t + ih - ((v - lo) / (hi - lo)) * ih;
  let d = '';
  pts.forEach((p, i) => {
    if (i === 0) d = `M${x(p.date).toFixed(1)},${y(p.ftp).toFixed(1)}`;
    else d += `H${x(p.date).toFixed(1)}V${y(p.ftp).toFixed(1)}`;
  });
  const ticks: number[] = [];
  const tickStep = hi - lo > 80 ? 20 : 10;
  for (let v = lo; v <= hi; v += tickStep) ticks.push(v);
  const months: string[] = [];
  for (let k = start.slice(0, 7) + '-01'; k <= today; ) {
    if (k >= start) months.push(k);
    const m = dayStart(k);
    m.setMonth(m.getMonth() + 1);
    k = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`;
  }
  const monthEvery = Math.max(1, Math.ceil(months.length / 8));
  // the change points (not the start) are the ones worth pointing at
  const marks = pts.map((p, i) => ({ ...p, i })).filter((p) => changes.includes(p.date));
  const last = pts[pts.length - 1];
  const h = hover != null ? pts[hover] : null;

  return (
    <div ref={ref} className="chart-wrap">
      <svg width={W} height={height} role="img" aria-label="FTP over time" onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={M.l + iw} y1={y(v)} y2={y(v)} className="grid" />
            <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="tick">{v}</text>
          </g>
        ))}
        {months.filter((_, i) => i % monthEvery === 0).map((k) => (
          <text key={k} x={x(k)} y={height - 6} className="tick" textAnchor="middle">
            {dayStart(k).toLocaleDateString(undefined, { month: 'short' })}
          </text>
        ))}
        <path d={d} stroke={SERIES.ctl} strokeWidth={2} fill="none" strokeLinejoin="round" />
        {marks.map((p) => (
          <g key={p.date} onMouseEnter={() => setHover(p.i)}>
            <circle cx={x(p.date)} cy={y(p.ftp)} r={10} fill="transparent" />
            <circle cx={x(p.date)} cy={y(p.ftp)} r={hover === p.i ? 5 : 4} fill={SERIES.ctl} stroke="var(--panel)" strokeWidth={2} />
          </g>
        ))}
        <circle cx={x(last.date)} cy={y(last.ftp)} r={4} fill={SERIES.ctl} stroke="var(--panel)" strokeWidth={2} />
        <text x={M.l + iw + 6} y={y(last.ftp) - 2} className="end-label">{last.ftp} W</text>
        <text x={M.l + iw + 6} y={y(last.ftp) + 12} className="tick">{wkg(last.ftp, last.kg)} W/kg</text>
      </svg>
      {h && hover != null && (
        <div className="chart-tip" style={{ left: Math.min(W - 170, Math.max(0, x(h.date) + 10)), top: 8 }}>
          <b>{fmtDay(h.date)}</b>
          <div>FTP {h.ftp} W</div>
          <div>{wkg(h.ftp, h.kg)} W/kg at {h.kg.toFixed(1)} kg</div>
        </div>
      )}
    </div>
  );
}
