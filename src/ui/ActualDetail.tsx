import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { RideRecord } from '../app/recorder';
import type { Settings } from '../storage/db';
import { fetchStreams } from '../strava/activities';
import { comparePlan, seriesFromRide, seriesFromStreams, seriesStats, verdict, type ActualSeries } from '../training/actual';
import type { StravaActivity } from '../training/model';
import { formatDuration, intervalFtpFraction, plannedStats, toWatts, totalDuration, zoneFor, type Interval } from '../workout/model';
import { CADENCE_COLOR } from './WorkoutChart';

const HR_COLOR = '#ff6b81';
const TARGET_COLOR = '#f2c94c';
const r0 = (x: number | undefined) => (x == null || !Number.isFinite(x) ? '--' : String(Math.round(x)));

// ---------- loading ----------

/** The ride's 1 Hz series: straight from a RideBox ride, or fetched from Strava. */
export function useActualSeries(ride?: RideRecord, act?: StravaActivity) {
  const fromRide = useMemo(() => (ride && ride.samples.length > 1 ? seriesFromRide(ride) : null), [ride]);
  const [streams, setStreams] = useState<{ id: number; series: ActualSeries | null; error?: string } | null>(null);
  const stravaId = !fromRide ? act?.stravaId : undefined;
  useEffect(() => {
    if (!stravaId) return;
    let live = true;
    fetchStreams(stravaId)
      .then((st) => live && setStreams({ id: stravaId, series: st.time ? seriesFromStreams(st) : null }))
      .catch((e) => live && setStreams({ id: stravaId, series: null, error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [stravaId]);
  if (fromRide) return { series: fromRide, loading: false };
  if (!stravaId) return { series: null, loading: false };
  if (streams?.id !== stravaId) return { series: null, loading: true };
  return { series: streams.series, loading: false, error: streams.error };
}

// ---------- chart ----------

export function linePath(values: (number | undefined)[], n: number, x: (i: number) => number, y: (v: number) => number, smooth = 1) {
  const step = Math.max(1, Math.ceil(values.length / 1200));
  let d = '';
  let pen = false;
  for (let i = 0; i < values.length; i += step) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - smooth + 1); j <= Math.min(values.length - 1, i + step - 1); j++) {
      const v = values[j];
      if (v != null && Number.isFinite(v) && v > 0) {
        sum += v;
        cnt++;
      }
    }
    if (!cnt) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(Math.min(n, i + step / 2)).toFixed(1)},${y(sum / cnt).toFixed(1)}`;
    pen = true;
  }
  return d;
}

const W = 1000;

/** Power (with the plan behind it), heart rate and cadence, stacked on one timeline with a hover readout. */
export function MetricsChart({ series, intervals, ftp }: { series: ActualSeries; intervals?: Interval[]; ftp: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const planned = intervals ? totalDuration(intervals) : 0;
  const n = Math.max(series.length, planned, 1);
  const x = (s: number) => (s / n) * W;
  const hasHr = !!series.hr?.some((v) => v);
  const hasCad = !!series.cadence?.some((v) => v);
  const hasPower = !!series.power?.some((v) => v > 0);

  const P_H = 130;
  const targetMax = intervals?.length ? Math.max(...intervals.filter((iv) => !iv.free).map((iv) => Math.max(toWatts(iv.powerStart, iv.unit, ftp), toWatts(iv.powerEnd, iv.unit, ftp))), 0) : 0;
  const maxP = Math.max(ftp * 1.2, targetMax * 1.1, ...(series.power ?? []).map((p, i, a) => (i >= 2 ? (p + a[i - 1] + a[i - 2]) / 3 : 0))) || 1;
  const yP = (w: number) => P_H - (Math.min(w, maxP) / maxP) * (P_H - 4);
  const hrs = (series.hr ?? []).filter((v): v is number => !!v);
  const hrLo = hrs.length ? Math.min(...hrs) - 5 : 0;
  const hrHi = hrs.length ? Math.max(...hrs) + 5 : 1;
  const L_H = 60;
  const yHr = (b: number) => L_H - ((b - hrLo) / (hrHi - hrLo)) * (L_H - 4) - 2;
  const cadHi = Math.max(130, ...(series.cadence ?? []).map((c) => c ?? 0));
  const yCad = (c: number) => L_H - (c / cadHi) * (L_H - 4) - 2;

  const paths = useMemo(
    () => ({
      power: hasPower ? linePath(series.power!, n, x, yP, 5) : '',
      target: series.target ? linePath(series.target, n, x, yP) : '',
      hr: hasHr ? linePath(series.hr!, n, x, yHr) : '',
      cad: hasCad ? linePath(series.cadence!, n, x, yCad, 3) : '',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, n, maxP, hrLo, hrHi, cadHi],
  );

  const ticks = useMemo(() => {
    const every = [60, 300, 600, 900, 1800, 3600].find((s) => n / s <= 8) ?? 7200;
    const out: number[] = [];
    for (let t = every; t < n - every / 3; t += every) out.push(t);
    return out;
  }, [n]);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * n))));
  };
  const at = hover ?? -1;
  const iv = intervals?.find((v) => at >= v.start && at < v.start + v.duration);
  const planW = iv && !iv.free ? Math.round(toWatts(iv.powerStart + ((iv.powerEnd - iv.powerStart) * (at - iv.start)) / iv.duration, iv.unit, ftp)) : undefined;
  const tgt = series.target?.[at] ?? planW;
  const avg3 = (a: (number | undefined)[] | undefined) => {
    const v = (a ?? []).slice(Math.max(0, at - 2), at + 1).filter((q): q is number => q != null);
    return v.length ? v.reduce((p, q) => p + q, 0) / v.length : undefined;
  };

  return (
    <div className="metrics">
      <div className="metrics-readout small">
        {hover == null ? (
          <span className="muted">Hover or drag across the chart for second-by-second values</span>
        ) : (
          <>
            <b>{formatDuration(at)}</b>
            {iv?.label && <span className="muted">{iv.label}</span>}
            {hasPower && <span>{r0(avg3(series.power))} W{tgt != null && <span style={{ color: TARGET_COLOR }}> / {tgt} target</span>}</span>}
            {hasHr && <span style={{ color: HR_COLOR }}>{r0(series.hr?.[at])} bpm</span>}
            {hasCad && <span style={{ color: CADENCE_COLOR }}>{r0(series.cadence?.[at])} rpm</span>}
          </>
        )}
      </div>
      <div
        className="metrics-lanes"
        ref={box}
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={() => setHover(null)}
        style={{ touchAction: 'pan-y' }}
      >
        {(hasPower || intervals) && (
          <div className="metrics-lane">
            <span className="metrics-label">Power</span>
            <svg viewBox={`0 0 ${W} ${P_H}`} preserveAspectRatio="none" style={{ height: P_H }}>
              {intervals?.map((v) => {
                if (v.free) return null;
                const a = toWatts(v.powerStart, v.unit, ftp);
                const b = toWatts(v.powerEnd, v.unit, ftp);
                return (
                  <polygon
                    key={v.index}
                    points={`${x(v.start)},${P_H} ${x(v.start)},${yP(a)} ${x(v.start + v.duration)},${yP(b)} ${x(v.start + v.duration)},${P_H}`}
                    fill={zoneFor(intervalFtpFraction(v, ftp)).color}
                    opacity={0.35}
                  />
                );
              })}
              {ftp > 0 && <line x1={0} x2={W} y1={yP(ftp)} y2={yP(ftp)} stroke="#ffffff" strokeOpacity={0.15} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
              {paths.target && <path d={paths.target} fill="none" stroke={TARGET_COLOR} strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.85} />}
              {paths.power && <path d={paths.power} fill="none" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
            </svg>
          </div>
        )}
        {hasHr && (
          <div className="metrics-lane">
            <span className="metrics-label">Heart rate · {Math.round(hrLo + 5)}–{Math.round(hrHi - 5)} bpm</span>
            <svg viewBox={`0 0 ${W} ${L_H}`} preserveAspectRatio="none" style={{ height: L_H }}>
              <path d={paths.hr} fill="none" stroke={HR_COLOR} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        )}
        {hasCad && (
          <div className="metrics-lane">
            <span className="metrics-label">Cadence</span>
            <svg viewBox={`0 0 ${W} ${L_H}`} preserveAspectRatio="none" style={{ height: L_H }}>
              <path d={paths.cad} fill="none" stroke={CADENCE_COLOR} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        )}
        {hover != null && <div className="metrics-cursor" style={{ left: `${(at / n) * 100}%` }} />}
        <div className="metrics-axis">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${(t / n) * 100}%` }}>{formatDuration(t)}</span>
          ))}
        </div>
      </div>
      {!hasPower && !hasHr && !hasCad && <div className="muted small">No power, heart rate or cadence was recorded.</div>}
    </div>
  );
}

// ---------- plan vs actual ----------

const VERDICT = { hit: 'On target', over: 'Over', under: 'Under', short: 'Cut short' } as const;

function PlanTable({ intervals, ftp, series }: { intervals: Interval[]; ftp: number; series: ActualSeries }) {
  const rows = useMemo(() => comparePlan(intervals, ftp, series), [intervals, ftp, series]);
  const hasHr = !!series.hr;
  const hasCad = !!series.cadence;
  return (
    <div className="table-scroll">
      <table className="laps plan-vs">
        <thead>
          <tr>
            <th>#</th>
            <th>Interval</th>
            <th>Planned</th>
            <th>Target</th>
            <th>Actual</th>
            <th>Avg W</th>
            <th>vs target</th>
            {hasHr && <th>Avg / max HR</th>}
            {hasCad && <th>Cadence</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const v = verdict(c);
            return (
              <tr key={c.index} className={c.actualDuration ? '' : 'muted'}>
                <td>{c.index + 1}</td>
                <td>{c.label ?? ''}</td>
                <td>{formatDuration(c.duration)}</td>
                <td className="nowrap">{c.free ? 'free' : c.rampW ? `${r0(c.rampW[0])}→${r0(c.rampW[1])} W` : `${r0(c.targetW)} W`}</td>
                <td>{c.actualDuration ? formatDuration(c.actualDuration) : '--'}</td>
                <td>{r0(c.avgPower)}</td>
                <td className="nowrap">
                  {c.ratio != null && <span>{Math.round(c.ratio * 100)}% </span>}
                  {v && c.actualDuration > 0 && <span className={`verdict v-${v}`}>{VERDICT[v]}</span>}
                </td>
                {hasHr && <td className="nowrap">{c.avgHr ? `${r0(c.avgHr)} / ${r0(c.maxHr)}` : '--'}</td>}
                {hasCad && <td>{r0(c.avgCadence)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Everything about a ride that happened: summary stats (next to the plan's when there was one),
 * the power / HR / cadence chart, and a per-interval plan vs actual table.
 */
export function ActualDetail({ ride, act, intervals, settings, tss }: {
  ride?: RideRecord;
  /** estimated TSS to show when there's no power series (e.g. HR-based for a Strava activity) */
  tss?: number;
  act?: StravaActivity;
  /** the planned workout this ride completed */
  intervals?: Interval[];
  settings: Settings;
}) {
  const { series, loading, error } = useActualSeries(ride, act);
  const ftp = ride?.ftp || settings.ftp;
  const st = useMemo(() => (series ? seriesStats(series, ftp) : null), [series, ftp]);
  const plan = useMemo(() => (intervals?.length ? plannedStats(intervals, ftp) : null), [intervals, ftp]);
  const isPlan = !!plan;

  // summary numbers: prefer the full-resolution series, fall back to Strava's summary
  const actual = {
    duration: st?.duration ?? ride?.summary.duration ?? act?.movingTime,
    avgPower: st?.avgPower ?? act?.avgWatts,
    np: st?.np ?? act?.weightedWatts,
    if: st?.if,
    tss: st?.tss ?? ride?.summary.tss ?? tss,
    maxPower: st?.maxPower,
    avgHr: st?.avgHr ?? act?.avgHr,
    maxHr: st?.maxHr ?? act?.maxHr,
    avgCadence: st?.avgCadence,
  };
  const rows: [string, string, string?][] = [
    ['Time', actual.duration ? formatDuration(actual.duration) : '--', plan ? formatDuration(plan.duration) : undefined],
    ['TSS', r0(actual.tss), plan ? r0(plan.tss) : undefined],
    ['IF', actual.if ? actual.if.toFixed(2) : '--', plan ? plan.if.toFixed(2) : undefined],
    ['NP', actual.np ? `${r0(actual.np)} W` : '--', plan ? `${r0(plan.np)} W` : undefined],
    ['Avg power', actual.avgPower ? `${r0(actual.avgPower)} W` : '--'],
    ['Max power', actual.maxPower ? `${r0(actual.maxPower)} W` : '--'],
    ['Avg HR', actual.avgHr ? `${r0(actual.avgHr)} bpm` : '--'],
    ['Max HR', actual.maxHr ? `${r0(actual.maxHr)} bpm` : '--'],
    ['Avg cadence', actual.avgCadence ? `${r0(actual.avgCadence)} rpm` : '--'],
  ];

  return (
    <div className="actual">
      <div className="stats-grid compact">
        {rows.map(([k, v, p]) => (
          <div key={k} className="stat">
            <div className="muted small">{k}</div>
            <div className="stat-v">{v}</div>
            {isPlan && p != null && <div className="muted small">plan {p}</div>}
          </div>
        ))}
      </div>
      {loading && (
        <div className="muted small row">
          <span className="spinner" aria-hidden /> Loading power, heart rate and cadence from Strava…
        </div>
      )}
      {error && <div className="banner err small">{error}</div>}
      {series && <MetricsChart series={series} intervals={intervals} ftp={ftp} />}
      {series && (
        <div className="muted small legend">
          <span style={{ color: '#fff' }}>■ power</span>
          {(intervals || series.target) && <span style={{ color: TARGET_COLOR }}>■ planned</span>}
          {series.hr && <span style={{ color: HR_COLOR }}>■ heart rate</span>}
          {series.cadence && <span style={{ color: CADENCE_COLOR }}>■ cadence</span>}
        </div>
      )}
      {series && intervals && intervals.length > 1 && (
        <>
          <div className="card-title">Plan vs actual</div>
          <PlanTable intervals={intervals} ftp={ftp} series={series} />
          {act && !ride && <div className="muted small">Intervals are lined up by moving time from the start of the activity.</div>}
        </>
      )}
      {!loading && !series && !error && act && <div className="muted small">Strava has no second-by-second data for this activity.</div>}
    </div>
  );
}
