import { memo, useMemo } from 'react';
import type { RideRecord } from '../app/recorder';
import { comparePlan, seriesStats, verdict, type ActualSeries } from '../training/actual';
import type { StravaActivity } from '../training/model';
import { formatDuration, intervalFtpFraction, toWatts, totalDuration, zoneFor, type Interval } from '../workout/model';
import { linePath, useActualSeries } from './ActualDetail';

const r0 = (x?: number) => (x == null || !Number.isFinite(x) ? undefined : Math.round(x));

/** Intervals that hit their target (not under it; over-power is fine), out of those with a target that were ridden. */
export function hitCount(intervals: Interval[], ftp: number, s: ActualSeries) {
  const rows = comparePlan(intervals, ftp, s).filter((c) => !c.free && c.actualDuration > 0 && c.targetW);
  return { hit: rows.filter((c) => ['hit', 'over'].includes(verdict(c) as string)).length, of: rows.length };
}

/** Tiny plan-vs-actual chart: planned blocks, actual power, heart rate. */
export function MiniChart({ series, intervals, ftp, height = 40 }: { series: ActualSeries; intervals?: Interval[]; ftp: number; height?: number }) {
  const W = 300;
  const H = height;
  const n = Math.max(series.length, intervals ? totalDuration(intervals) : 0, 1);
  const x = (s: number) => (s / n) * W;
  const pw = series.power ?? [];
  const maxP = Math.max(ftp * 1.3, ...(intervals ?? []).filter((v) => !v.free).map((v) => Math.max(toWatts(v.powerStart, v.unit, ftp), toWatts(v.powerEnd, v.unit, ftp)) * 1.1)) || 1;
  const yP = (w: number) => H - (Math.min(w, maxP) / maxP) * (H - 2);
  const hrs = (series.hr ?? []).filter((v): v is number => !!v);
  const lo = hrs.length ? Math.min(...hrs) - 3 : 0;
  const hi = hrs.length ? Math.max(...hrs) + 3 : 1;
  const yH = (b: number) => H - ((b - lo) / (hi - lo)) * (H - 4) - 2;
  const power = pw.some((v) => v > 0) ? linePath(pw, n, x, yP, 15) : '';
  const hr = hrs.length ? linePath(series.hr!, n, x, yH, 10) : '';
  return (
    <svg className="mini-actual" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} aria-hidden>
      {intervals?.map((v) =>
        v.free ? null : (
          <polygon
            key={v.index}
            points={`${x(v.start)},${H} ${x(v.start)},${yP(toWatts(v.powerStart, v.unit, ftp))} ${x(v.start + v.duration)},${yP(toWatts(v.powerEnd, v.unit, ftp))} ${x(v.start + v.duration)},${H}`}
            fill={zoneFor(intervalFtpFraction(v, ftp)).color}
            opacity={0.35}
          />
        ),
      )}
      {hr && <path d={hr} fill="none" stroke="#ff6b81" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.9} />}
      {power && <path d={power} fill="none" stroke="#fff" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/**
 * What was ridden, right on the calendar card: time and TSS (vs plan), NP, average power,
 * heart rate, how many intervals hit their target, and a mini chart. Strava activities use the
 * saved streams (downloaded in the background), so the calendar itself makes no requests.
 */
export function useCardStats(ride: RideRecord | undefined, act: StravaActivity | undefined, intervals: Interval[] | undefined, ftp: number, tss?: number) {
  const { series } = useActualSeries(ride, act);
  const rideFtp = ride?.ftp || ftp;
  const st = useMemo(() => (series ? seriesStats(series, rideFtp) : null), [series, rideFtp]);
  const hits = useMemo(() => (series && intervals && intervals.length > 1 ? hitCount(intervals, rideFtp, series) : null), [series, intervals, rideFtp]);
  return {
    series,
    rideFtp,
    hits,
    duration: ride?.summary.duration ?? st?.duration ?? act?.movingTime,
    tss: r0(ride?.summary.tss ?? st?.tss ?? tss),
    np: r0(ride?.summary.np ?? st?.np ?? act?.weightedWatts),
    avgPower: r0(ride?.summary.avgPower ?? st?.avgPower ?? act?.avgWatts),
    hr: r0(ride?.summary.avgHr ?? st?.avgHr ?? act?.avgHr),
    maxHr: r0(ride?.summary.maxHr ?? st?.maxHr ?? act?.maxHr),
    intensity: ride?.summary.if ?? st?.if ?? (act?.weightedWatts && rideFtp ? act.weightedWatts / rideFtp : undefined),
    cadence: r0(ride?.summary.avgCadence ?? st?.avgCadence ?? act?.avgCadence),
  };
}

export const CardActual = memo(function CardActual({ ride, act, intervals, ftp, tss, plannedTss }: {
  ride?: RideRecord;
  act?: StravaActivity;
  intervals?: Interval[];
  ftp: number;
  /** TSS from the load model (covers Strava activities without power) */
  tss?: number;
  plannedTss?: number;
}) {
  const { series, rideFtp, hits, duration, tss: actualTss, np, avgPower: avgW, hr, maxHr, intensity } = useCardStats(ride, act, intervals, ftp, tss);

  return (
    <div className="card-actual">
      <div className="cal-card-meta">
        {duration != null && <span>{formatDuration(duration)}</span>}
        {actualTss != null && (
          <span>
            TSS {actualTss}
            {plannedTss != null && <span className="muted">/{Math.round(plannedTss)}</span>}
          </span>
        )}
      </div>
      {(np != null || avgW != null || hr != null) && (
        <div className="cal-card-meta card-metrics">
          {intensity != null && Number.isFinite(intensity) && <span title="Intensity factor (NP / FTP)">IF {intensity.toFixed(2)}</span>}
          {(avgW != null || np != null) && (
            <span title="Average / normalized power">
              {avgW ?? '–'}/{np ?? '–'}W
            </span>
          )}
          {hr != null && (
            <span title="Average / max heart rate">
              ♥{hr}
              {maxHr != null ? `/${maxHr}` : ''}
            </span>
          )}
        </div>
      )}
      {hits && hits.of > 0 && (
        <div className="cal-card-meta">
          <span className={`verdict ${hits.hit === hits.of ? 'v-hit' : hits.hit >= hits.of * 0.7 ? 'v-over' : 'v-under'}`} title="Intervals at or above target (first 10 s ignored)">
            {hits.hit}/{hits.of} on target
          </span>
        </div>
      )}
      {series && <MiniChart series={series} intervals={intervals} ftp={rideFtp} />}
    </div>
  );
});
