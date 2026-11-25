import { useLayoutEffect, useRef, useState } from 'react';
import type { FitnessDay } from '../training/load';
import { dayStart } from '../training/load';

// Validated (dataviz validator, dark surface #161b22): blue / orange / aqua.
export const SERIES = { ctl: '#3987e5', atl: '#d95926', tsb: '#199e70' } as const;

export const FITNESS_RANGES = [
  { id: '4w', label: '4w', days: 28 },
  { id: '3m', label: '3m', days: 91 },
  { id: '6m', label: '6m', days: 182 },
  { id: '1y', label: '1y', days: 365 },
] as const;
export type FitnessRangeId = (typeof FITNESS_RANGES)[number]['id'];
export const rangeDays = (id: FitnessRangeId) => FITNESS_RANGES.find((r) => r.id === id)!.days;

/** Time scale selector for the fitness chart (shared by the desktop and phone layouts). */
export function RangeSelect({ value, onChange }: { value: FitnessRangeId; onChange: (id: FitnessRangeId) => void }) {
  return (
    <div className="seg" role="group" aria-label="Time scale">
      {FITNESS_RANGES.map((r) => (
        <button key={r.id} className={value === r.id ? 'active' : ''} aria-pressed={value === r.id} onClick={() => onChange(r.id)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

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

const fmtDay = (k: string) => dayStart(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const niceStep = (span: number) => {
  const raw = span / 5;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
};

/** Fitness (CTL), fatigue (ATL) and form (TSB) over time, on one TSS/day axis. Future days are the plan's projection. */
export function FitnessChart({ days, height = 260 }: { days: FitnessDay[]; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return null;
  const M = { l: 36, r: 64, t: 12, b: 24 };
  const iw = W - M.l - M.r;
  const ih = height - M.t - M.b;
  let lo = 0;
  let hi = 10;
  for (const d of days) {
    lo = Math.min(lo, d.tsb, d.ctl, d.atl);
    hi = Math.max(hi, d.tsb, d.ctl, d.atl);
  }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const x = (i: number) => M.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v: number) => M.t + ih - ((v - lo) / (hi - lo)) * ih;
  const firstFuture = days.findIndex((d) => d.future);
  const split = firstFuture === -1 ? days.length : firstFuture;

  const path = (key: 'ctl' | 'atl' | 'tsb', from: number, to: number) => {
    let s = '';
    for (let i = Math.max(0, from); i < Math.min(days.length, to); i++) s += `${s ? 'L' : 'M'}${x(i).toFixed(1)},${y(days[i][key]).toFixed(1)}`;
    return s;
  };
  const area = (from: number, to: number) => {
    const a = Math.max(0, from);
    const b = Math.min(days.length, to);
    if (b - a < 2) return '';
    let s = `M${x(a)},${y(0)}`;
    for (let i = a; i < b; i++) s += `L${x(i).toFixed(1)},${y(days[i].tsb).toFixed(1)}`;
    return `${s}L${x(b - 1)},${y(0)}Z`;
  };
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  // short windows get date labels every 1-2 weeks; long ones get month names
  const byWeek = days.length <= 90;
  const weekStep = (iw / days.length) * 7 >= 56 ? 7 : 14;
  const months: number[] = [];
  days.forEach((d, i) => {
    if (byWeek ? i % weekStep === 0 && i < days.length - 4 : d.date.endsWith('-01')) months.push(i);
  });
  const last = days[split - 1] ?? days[days.length - 1];
  const h = hover != null ? days[hover] : null;
  // keep end labels apart
  const ends = (['ctl', 'atl', 'tsb'] as const).map((k) => ({ k, y: y(last[k]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  const names = { ctl: 'Fitness', atl: 'Fatigue', tsb: 'Form' };

  return (
    <div ref={ref} className="chart-wrap">
      <svg
        width={W}
        height={height}
        role="img"
        aria-label="Fitness, fatigue and form over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - M.l) / iw) * (days.length - 1));
          setHover(i >= 0 && i < days.length ? i : null);
        }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={M.l + iw} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis-zero' : 'grid'} />
            <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="tick">
              {v}
            </text>
          </g>
        ))}
        {months.map((i) => (
          <text key={i} x={x(i)} y={height - 6} className="tick" textAnchor="middle">
            {dayStart(days[i].date).toLocaleDateString(undefined, byWeek ? { month: 'short', day: 'numeric' } : { month: 'short' })}
          </text>
        ))}
        {split < days.length && (
          <>
            <rect x={x(split - 1)} y={M.t} width={x(days.length - 1) - x(split - 1)} height={ih} className="future-band" />
            <text x={x(split - 1) + 4} y={M.t + 12} className="tick">
              plan →
            </text>
          </>
        )}
        <path d={area(0, split)} fill={SERIES.tsb} opacity={0.28} />
        <path d={area(split - 1, days.length)} fill={SERIES.tsb} opacity={0.12} />
        {(['tsb', 'atl', 'ctl'] as const).map((k) => (
          <g key={k}>
            <path d={path(k, 0, split)} stroke={SERIES[k]} strokeWidth={2} fill="none" strokeLinejoin="round" />
            <path d={path(k, split - 1, days.length)} stroke={SERIES[k]} strokeWidth={2} fill="none" strokeDasharray="4 4" />
          </g>
        ))}
        {ends.map(({ k, y: ly }) => (
          <g key={k}>
            <circle cx={x(split - 1)} cy={y(last[k])} r={4} fill={SERIES[k]} stroke="var(--panel)" strokeWidth={2} />
            <text x={M.l + iw + 6} y={ly + 4} className="end-label">
              {names[k]} {Math.round(last[k])}
            </text>
          </g>
        ))}
        {h && hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + ih} className="crosshair" />
            {(['ctl', 'atl', 'tsb'] as const).map((k) => (
              <circle key={k} cx={x(hover)} cy={y(h[k])} r={4} fill={SERIES[k]} stroke="var(--panel)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {h && hover != null && (
        <div className="chart-tip" style={{ left: Math.min(W - 170, Math.max(0, x(hover) + 10)), top: 8 }}>
          <b>{fmtDay(h.date)}</b>
          {h.future ? ' (planned)' : ''}
          <div>{h.future ? `Planned TSS ${Math.round(h.planned)}` : `TSS ${Math.round(h.tss)}`}</div>
          {(['ctl', 'atl', 'tsb'] as const).map((k) => (
            <div key={k}>
              <i className="swatch" style={{ background: SERIES[k] }} /> {names[k]} {Math.round(h[k])}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Weekly training load bars (one series). */
export function WeeklyBars({ weeks, height = 120 }: { weeks: { week: string; tss: number; seconds: number }[]; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!weeks.length) return null;
  const M = { l: 36, r: 8, t: 8, b: 22 };
  const iw = W - M.l - M.r;
  const ih = height - M.t - M.b;
  const max = Math.max(50, ...weeks.map((w) => w.tss));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = iw / weeks.length;
  const y = (v: number) => M.t + ih - (v / top) * ih;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const h = hover != null ? weeks[hover] : null;
  return (
    <div ref={ref} className="chart-wrap">
      <svg width={W} height={height} role="img" aria-label="Weekly TSS" onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={M.l + iw} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis-zero' : 'grid'} />
            <text x={M.l - 6} y={y(v) + 4} textAnchor="end" className="tick">
              {v}
            </text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const bh = Math.max(0, y(0) - y(w.tss));
          const bx = M.l + i * bw + 1;
          const width = Math.max(2, bw - 2);
          const r = Math.min(4, width / 2, bh);
          return (
            <g key={w.week} onMouseEnter={() => setHover(i)}>
              <rect x={M.l + i * bw} y={M.t} width={bw} height={ih} fill="transparent" />
              {bh > 0 && (
                <path
                  d={`M${bx},${y(0)}V${y(w.tss) + r}Q${bx},${y(w.tss)} ${bx + r},${y(w.tss)}H${bx + width - r}Q${bx + width},${y(w.tss)} ${bx + width},${y(w.tss) + r}V${y(0)}Z`}
                  fill={SERIES.ctl}
                  opacity={hover == null || hover === i ? 1 : 0.55}
                />
              )}
              {i % Math.ceil(weeks.length / 8) === 0 && (
                <text x={bx + width / 2} y={height - 6} textAnchor="middle" className="tick">
                  {fmtDay(w.week)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover != null && (
        <div className="chart-tip" style={{ left: Math.min(W - 150, M.l + hover * bw + bw), top: 4 }}>
          <b>Week of {fmtDay(h.week)}</b>
          <div>TSS {Math.round(h.tss)}</div>
          <div>{(h.seconds / 3600).toFixed(1)} h</div>
        </div>
      )}
    </div>
  );
}
