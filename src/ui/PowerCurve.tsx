// Power curve chart (best average power against duration, on a log time axis),
// used on every ride and on the Best efforts page. Hover or drag across it to see,
// for each curve, the watts, W/kg and where that best effort happened.

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useEffortSources } from '../app/efforts';
import type { Settings } from '../storage/db';
import { bestCurve, CURVE_DURATIONS, durationLabel, inRange, type CurvePoint, type PowerCurve as Curve } from '../training/efforts';
import { weightOn } from '../training/ftp';
import { dayKey } from '../training/load';
import { formatDuration } from '../workout/model';

/** Validated against the dark panel: orange for the ride / main period, blue for what it's compared with. */
export const CURVE_COLORS = { main: '#f26a10', compare: '#4a98d6' } as const;

export interface CurveSeries {
  key: string;
  label: string;
  color: string;
  /** watts per CURVE_DURATIONS index (shorter than the grid when the rides were shorter) */
  w: number[];
  /** shaded area under the line */
  fill?: boolean;
  /** text under the value at a duration index: where / when the effort happened */
  detail?: (i: number) => ReactNode;
  /** rider weight (kg) for that effort, for W/kg */
  kg?: (i: number) => number | undefined;
}

const W = 1000;
const TICKS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200];
const tickLabel = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`);

function niceStep(max: number) {
  const raw = max / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}

export function PowerCurveChart({ series, height = 200, onHover, empty }: {
  series: CurveSeries[];
  height?: number;
  /** the hovered duration index, null when the pointer leaves */
  onHover?: (i: number | null) => void;
  /** shown when there's nothing to draw */
  empty?: ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const shown = series.filter((s) => s.w.length);
  const n = Math.max(0, ...shown.map((s) => s.w.length));
  const maxD = CURVE_DURATIONS[Math.max(0, n - 1)] ?? 1;
  const lx = (d: number) => (maxD <= 1 ? 0 : Math.log(d) / Math.log(maxD));
  const x = (d: number) => lx(d) * W;
  const maxW = Math.max(1, ...shown.flatMap((s) => s.w));
  const step = niceStep(maxW * 1.05);
  const top = Math.ceil((maxW * 1.05) / step) * step;
  const H = height;
  const y = (w: number) => H - (w / top) * (H - 6);
  const grid = useMemo(() => {
    const out: number[] = [];
    for (let v = step; v < top; v += step) out.push(v);
    return out;
  }, [step, top]);
  // keep labels at least ~34 px apart
  const ticks: number[] = [];
  for (const t of TICKS) {
    if (t > maxD || (maxD > 1 && (1 - lx(t)) * width < 14)) continue;
    if (!ticks.length || (lx(t) - lx(ticks[ticks.length - 1])) * width >= 34) ticks.push(t);
  }

  const paths = useMemo(
    () =>
      shown.map((s) => {
        let d = '';
        s.w.forEach((w, i) => (d += `${i ? 'L' : 'M'}${x(CURVE_DURATIONS[i]).toFixed(1)},${y(w).toFixed(1)}`));
        const area = s.fill && s.w.length ? `${d}L${x(CURVE_DURATIONS[s.w.length - 1]).toFixed(1)},${H}L0,${H}Z` : '';
        return { key: s.key, d, area, color: s.color };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, maxD, top, H],
  );

  const set = (i: number | null) => {
    setHover(i);
    onHover?.(i);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!n) return;
    const r = box.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const d = Math.exp(f * Math.log(maxD));
    // nearest sampled duration on the log axis
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(Math.log(CURVE_DURATIONS[i] / d)) < Math.abs(Math.log(CURVE_DURATIONS[best] / d))) best = i;
    if (best !== hover) set(best);
  };

  if (!n) return <div className="curve-empty muted small">{empty ?? 'No power data.'}</div>;
  const at = hover ?? -1;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  return (
    <div className="curve">
      <div className="curve-readout small">
        {hover == null ? (
          <span className="muted">{coarse ? 'Touch and drag' : 'Hover or drag'} across the curve to see each best effort and when it happened</span>
        ) : (
          <>
            <b className="curve-dur">{durationLabel(CURVE_DURATIONS[at])}</b>
            {shown.map((s) => {
              const w = s.w[at];
              const kg = s.kg?.(at);
              return (
                <span key={s.key} className="curve-val">
                  <i className="swatch" style={{ background: s.color }} />
                  <span className="muted">{s.label}</span>{' '}
                  {w == null ? (
                    <span className="muted">—</span>
                  ) : (
                    <>
                      <b>{w} W</b>
                      {kg ? <span className="muted"> · {(w / kg).toFixed(2)} W/kg</span> : null}
                      {s.detail && <span className="curve-detail muted"> · {s.detail(at)}</span>}
                    </>
                  )}
                </span>
              );
            })}
          </>
        )}
      </div>
      <div className="curve-plot" style={{ height: H }}>
        <div className="curve-y">
          {grid.map((v) => (
            <span key={v} style={{ top: y(v) }}>{v}</span>
          ))}
          <span className="curve-unit">W</span>
        </div>
        <div
          className="curve-area"
          ref={box}
          onPointerMove={move}
          onPointerDown={move}
          onPointerLeave={(e) => e.pointerType === 'mouse' && set(null)}
          style={{ touchAction: 'pan-y' }}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} role="img" aria-label="Power curve">
            {grid.map((v) => (
              <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="#ffffff" strokeOpacity={0.07} vectorEffect="non-scaling-stroke" />
            ))}
            {ticks.map((t) => (
              <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={H} stroke="#ffffff" strokeOpacity={0.05} vectorEffect="non-scaling-stroke" />
            ))}
            {paths.map((p) => p.area && <path key={`${p.key}-a`} d={p.area} fill={p.color} opacity={0.14} />)}
            {paths.map((p) => (
              <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {hover != null && (
            <>
              <div className="curve-cursor" style={{ left: `${lx(CURVE_DURATIONS[at]) * 100}%` }} />
              {shown.map((s) =>
                s.w[at] == null ? null : (
                  <i key={s.key} className="curve-dot" style={{ left: `${lx(CURVE_DURATIONS[at]) * 100}%`, top: y(s.w[at]), background: s.color }} />
                ),
              )}
            </>
          )}
          <div className="curve-axis">
            {ticks.map((t) => (
              <span key={t} style={{ left: `${lx(t) * 100}%` }}>{tickLabel(t)}</span>
            ))}
          </div>
        </div>
      </div>
      {shown.length > 1 && (
        <div className="muted small legend">
          {shown.map((s) => (
            <span key={s.key}>
              <i className="swatch" style={{ background: s.color }} /> {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- periods ----------

export type PeriodId = '6w' | '3m' | '6m' | '1y' | 'ytd' | 'all' | 'custom';
export const PERIODS: { id: PeriodId; label: string; long: string }[] = [
  { id: '6w', label: '6W', long: 'Past 6 weeks' },
  { id: '3m', label: '3M', long: 'Past 3 months' },
  { id: '6m', label: '6M', long: 'Past 6 months' },
  { id: '1y', label: '1Y', long: 'Past year' },
  { id: 'ytd', label: 'YTD', long: 'This year' },
  { id: 'all', label: 'All', long: 'All time' },
  { id: 'custom', label: 'Custom', long: 'Custom' },
];

const DAY = 86_400_000;
const endOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const parseDay = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

/** [from, to] in ms for a period ending on `end` (a ride's start, or now). */
export function periodRange(id: PeriodId, end: number, custom?: { from: string; to: string }): [number, number] {
  const to = endOfDay(end);
  const back = (days: number) => startOfDay(end - days * DAY);
  switch (id) {
    case '6w':
      return [back(42), to];
    case '3m':
      return [back(91), to];
    case '6m':
      return [back(182), to];
    case '1y':
      return [back(365), to];
    case 'ytd':
      return [new Date(new Date(end).getFullYear(), 0, 1).getTime(), to];
    case 'custom':
      return custom?.from && custom.to ? [parseDay(custom.from), endOfDay(parseDay(custom.to))] : [back(42), to];
    default:
      return [0, to];
  }
}

export function PeriodSelect({ value, onChange, ids }: { value: PeriodId; onChange: (id: PeriodId) => void; ids?: PeriodId[] }) {
  return (
    <div className="seg" role="group" aria-label="Time period">
      {PERIODS.filter((p) => !ids || ids.includes(p.id)).map((p) => (
        <button key={p.id} className={value === p.id ? 'active' : ''} aria-pressed={value === p.id} title={p.long} onClick={() => onChange(p.id)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

export const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** A curve series for the best of a set of rides, with each point's date and ride. */
export function periodSeries(points: CurvePoint[], key: string, label: string, color: string, settings: Settings, opts: { fill?: boolean; thisId?: string } = {}): CurveSeries {
  return {
    key,
    label,
    color,
    fill: opts.fill,
    w: points.map((p) => p.w),
    kg: (i) => (points[i] ? weightOn(settings, dayKey(points[i].src.start)) : undefined),
    detail: (i) => {
      const p = points[i];
      if (!p) return null;
      if (p.src.id === opts.thisId) return 'this ride';
      return (
        <>
          {shortDate(p.src.start)} · {p.src.name}
        </>
      );
    },
  };
}

// ---------- on a ride ----------

const ACTIVITY_PERIODS: PeriodId[] = ['6w', '3m', '6m', '1y', 'all'];

/**
 * A ride's power curve against the best of a period up to that ride (6 weeks by default).
 * Hovering reports the window of the ride's own best effort so the ride's chart can mark it.
 */
export function ActivityPowerCurve({ id, start, curve, settings, onHighlight }: {
  id: string;
  /** ride start (ms) */
  start: number;
  curve: Curve;
  settings: Settings;
  onHighlight?: (range: [number, number] | null) => void;
}) {
  const [period, setPeriod] = useState<PeriodId>('6w');
  const sources = useEffortSources();
  const range = periodRange(period, start);
  const compare = useMemo(() => (sources ? bestCurve(inRange(sources, range[0], range[1])) : []), [sources, range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const kg = weightOn(settings, dayKey(start));
  const label = PERIODS.find((p) => p.id === period)!.long;
  const series: CurveSeries[] = [
    periodSeries(compare, 'period', label, CURVE_COLORS.compare, settings, { fill: true, thisId: id }),
    {
      key: 'ride',
      label: 'This ride',
      color: CURVE_COLORS.main,
      w: curve.w,
      kg: () => kg,
      detail: (i) => `at ${formatDuration(curve.s[i])}`,
    },
  ];
  return (
    <div className="activity-curve">
      <div className="row space">
        <div className="card-title">Power curve</div>
        <PeriodSelect value={period} onChange={setPeriod} ids={ACTIVITY_PERIODS} />
      </div>
      <PowerCurveChart
        series={series}
        height={180}
        onHover={(i) => onHighlight?.(i == null || curve.s[i] == null ? null : [curve.s[i], curve.s[i] + CURVE_DURATIONS[i]])}
      />
      <div className="muted small">{label} is up to and including this ride.</div>
    </div>
  );
}
