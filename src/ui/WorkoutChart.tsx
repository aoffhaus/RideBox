import { memo, useMemo, useState, type MouseEvent } from 'react';
import { formatDuration, intervalFtpFraction, toWatts, totalDuration, zoneFor, type Interval } from '../workout/model';
import type { Sample } from '../app/recorder';

interface Props {
  intervals: Interval[];
  ftp: number;
  height?: number;
  elapsed?: number;
  samples?: Sample[];
  maxHr?: number;
  currentIndex?: number;
  intensity?: number; // percent
  compact?: boolean;
  /** Interval index to highlight (e.g. from a hovered row in a list). Mouse hover takes precedence. */
  highlight?: number | null;
}

/** Workout profile: zone-coloured intervals, progress marker, live power + HR lines. */
export const WorkoutChart = memo(function WorkoutChart({
  intervals,
  ftp,
  height = 120,
  elapsed,
  samples,
  maxHr = 190,
  currentIndex,
  intensity = 100,
  compact,
  highlight,
}: Props) {
  const W = 1000;
  const H = height;
  const total = Math.max(1, totalDuration(intervals));
  const k = intensity / 100;
  const maxTarget = Math.max(ftp * 1.25, ...intervals.map((iv) => Math.max(toWatts(iv.powerStart, iv.unit, ftp), toWatts(iv.powerEnd, iv.unit, ftp)) * k));
  const yMax = maxTarget * 1.08;
  const x = (t: number) => (t / total) * W;
  const y = (w: number) => H - (Math.max(0, w) / yMax) * (H - 4);

  const [hover, setHover] = useState<number | null>(null);

  const active = hover ?? highlight ?? null;

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const t = ((e.clientX - r.left) / r.width) * total;
    const i = intervals.findIndex((iv) => t >= iv.start && t < iv.start + iv.duration);
    setHover(i >= 0 ? i : null);
  };

  const blocks = useMemo(
    () =>
      intervals.map((iv) => {
        const x0 = x(iv.start);
        const x1 = x(iv.start + iv.duration);
        if (iv.free) {
          return { d: `M${x0},${H} L${x0},${y(ftp * 0.5)} L${x1},${y(ftp * 0.5)} L${x1},${H} Z`, color: '#5b6573', iv };
        }
        const w0 = toWatts(iv.powerStart, iv.unit, ftp) * k;
        const w1 = toWatts(iv.powerEnd, iv.unit, ftp) * k;
        return {
          d: `M${x0},${H} L${x0},${y(w0)} L${x1},${y(w1)} L${x1},${H} Z`,
          color: zoneFor(intervalFtpFraction(iv, ftp)).color,
          iv,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intervals, ftp, total, yMax, k, H, intervals.map((i) => i.start + ':' + i.duration).join()],
  );

  const powerPath = useMemo(() => {
    if (!samples?.length) return '';
    const step = Math.max(1, Math.floor(samples.length / 1500));
    let d = '';
    for (let i = 0; i < samples.length; i += step) {
      // 3s smoothing
      const a = samples.slice(Math.max(0, i - 2), i + 1);
      const p = a.reduce((s, x) => s + x.power, 0) / a.length;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples?.length, total, yMax]);

  const hrPath = useMemo(() => {
    if (!samples?.length) return '';
    const step = Math.max(1, Math.floor(samples.length / 1500));
    let d = '';
    for (let i = 0; i < samples.length; i += step) {
      const hr = samples[i].hr;
      if (!hr) continue;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${(H - (hr / maxHr) * (H - 4)).toFixed(1)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples?.length, total, maxHr]);

  return (
    <div className="workout-chart-wrap">
      <svg
        className="workout-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={W} y1={y(ftp)} y2={y(ftp)} stroke="rgba(255,255,255,0.35)" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
        {blocks.map((b, i) => (
          <path
            key={i}
            d={b.d}
            fill={b.color}
            opacity={currentIndex == null ? 0.9 : i === currentIndex ? 1 : elapsed != null && b.iv.start + b.iv.duration <= elapsed ? 0.35 : 0.7}
            stroke={i === active ? '#fff' : 'rgba(0,0,0,0.35)'}
            strokeWidth={i === active ? 2 : compact ? 0 : 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hrPath && <path d={hrPath} fill="none" stroke="#ff6b81" strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.9} />}
        {powerPath && <path d={powerPath} fill="none" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        {elapsed != null && (
          <line x1={x(elapsed)} x2={x(elapsed)} y1={0} y2={H} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {active != null && intervals[active] && (
        <IntervalTooltip iv={intervals[active]} ftp={ftp} k={k} leftPct={((intervals[active].start + intervals[active].duration / 2) / total) * 100} />
      )}
    </div>
  );
});

/** Human-readable target power for an interval, e.g. "260 W · 130% FTP". */
export function intervalPowerText(iv: Interval, ftp: number, k = 1): string {
  if (iv.free) return 'Free ride';
  const w0 = Math.round(toWatts(iv.powerStart, iv.unit, ftp) * k);
  const w1 = Math.round(toWatts(iv.powerEnd, iv.unit, ftp) * k);
  const p0 = Math.round((w0 / ftp) * 100);
  const p1 = Math.round((w1 / ftp) * 100);
  return w0 === w1 ? `${w0} W · ${p0}% FTP` : `${w0} → ${w1} W · ${p0} → ${p1}% FTP`;
}

function IntervalTooltip({ iv, ftp, k, leftPct }: { iv: Interval; ftp: number; k: number; leftPct: number }) {
  const power = intervalPowerText(iv, ftp, k);
  const shift = leftPct < 15 ? '0%' : leftPct > 85 ? '-100%' : '-50%';
  return (
    <div className="chart-tooltip" style={{ left: `${leftPct}%`, transform: `translateX(${shift})` }}>
      {iv.label && <div className="chart-tooltip-label">{iv.label}</div>}
      <div>
        <strong>{power}</strong>
      </div>
      <div className="muted">
        {formatDuration(iv.duration)} · starts at {formatDuration(iv.start)}
      </div>
    </div>
  );
}
