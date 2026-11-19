import { useRef } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import type { Settings } from '../storage/db';
import { formatDuration, toWatts, type Interval } from '../workout/model';
import { distUnit, elevUnit, fmtDist, fmtElev, fmtSpeed, r0, speedUnit } from './format';
import { ivColor } from './MiniMap';

/** "5 min", "90 s", "2:30" */
function forDuration(sec: number) {
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} min`;
  if (sec < 60) return `${sec} s`;
  return formatDuration(sec);
}

export function targetText(iv: Interval, ftp: number, k: number) {
  if (iv.free) return null;
  const a = Math.round(toWatts(iv.powerStart, iv.unit, ftp) * k);
  const b = Math.round(toWatts(iv.powerEnd, iv.unit, ftp) * k);
  return a === b ? `${a}w` : `${a}→${b}w`;
}

function Stat({ value, unit, sub }: { value: string; unit: string; sub?: string }) {
  return (
    <div className="zh-stat">
      <span className="zh-stat-v">{value}</span>
      <span className="zh-stat-u">
        <span>{unit}</span>
        {sub && <span>{sub}</span>}
      </span>
    </div>
  );
}

const Heart = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.8 8.2 3 4 6.9 4c2.1 0 3.6 1.2 5.1 3 1.5-1.8 3-3 5.1-3C21 4 23.2 8.2 21.6 11.8 19.5 16.4 12 21 12 21z" />
  </svg>
);
const Crank = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <path d="M12 12l5-8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);
const Flag = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M5 3h2v18H5zM8 4h11l-3 4.5L19 13H8z" />
  </svg>
);

/**
 * The main ride HUD: one light card at top centre, laid out like the
 * Zwift-style workout HUD. Speed, distance, climb and time across the top;
 * the current target on the left; big power in the middle; HR and cadence
 * on the right; interval and workout progress bars.
 */
export function RideHud({ session, settings, snap }: { session: RideSession; settings: Settings; snap: Snapshot }) {
  const ftp = settings.ftp;
  const route = session.route;
  const st = snap.workout;
  const cur = st && !st.finished ? st.interval : undefined;
  const k = (st?.intensity ?? 100) / 100;

  // Total climbing this ride (true route, positive altitude changes only).
  const climb = useRef({ last: snap.altitude, total: 0 });
  const dAlt = snap.altitude - climb.current.last;
  if (dAlt > 0 && dAlt < 20) climb.current.total += dAlt;
  climb.current.last = snap.altitude;

  const target = st?.targetWatts ?? null;
  const p3 = snap.power3s;
  const diff = target ? p3 - target : 0;
  const powerClass = !target ? '' : Math.abs(diff) <= target * 0.05 ? 'ok' : diff > 0 ? 'high' : 'low';

  const lapFrac = (snap.distance % route.length) / route.length;
  const ivFrac = cur ? Math.min(1, Math.max(0, st!.timeInInterval / cur.duration)) : 0;
  const total = session.engine ? session.engine.intervals.reduce((s, x) => s + x.duration, 0) : 0;
  const wFrac = st && total ? Math.min(1, st.elapsed / total) : lapFrac;
  const color = cur ? ivColor(cur, ftp) : '#2f9e5b';
  const tgt = cur ? targetText(cur, ftp, k) : null;
  const next = st?.next;

  return (
    <div className="zh">
      <div className="zh-stats">
        <Stat value={fmtSpeed(snap.speed, settings)} unit={speedUnit(settings)} />
        <Stat value={fmtDist(snap.distance, settings)} unit={distUnit(settings)} />
        <Stat value={fmtElev(climb.current.total, settings)} unit={elevUnit(settings)} sub="climb" />
        <Stat value={formatDuration(snap.elapsed)} unit="time" />
      </div>
      <div className="zh-lap" title={`${route.preset.name}: lap ${Math.floor(snap.distance / route.length) + 1}`}>
        <div style={{ width: `${lapFrac * 100}%` }} />
      </div>

      <div className="zh-chips">
        <span className={`zh-chip ${snap.mode === 'erg' ? 'erg' : 'sim'}`}>{snap.mode === 'erg' ? 'ERG ON' : 'SIM'}</span>
        {session.engine && <span className="zh-chip">{st?.intensity ?? 100}%</span>}
        <span className="zh-chip">{(snap.grade * 100).toFixed(1)}%</span>
        <span className="zh-chip zh-chip-r">
          {route.preset.name} · lap {Math.floor(snap.distance / route.length) + 1}
        </span>
      </div>

      {cur && (
        <div className="zh-ivbar">
          <div style={{ width: `${ivFrac * 100}%`, background: color }} />
          <span>{formatDuration(Math.ceil(st!.remaining))}</span>
        </div>
      )}

      <div className="zh-main">
        <div className="zh-target" style={{ background: color }}>
          {cur && tgt ? (
            <>
              <span>ride at</span>
              <b>{tgt}</b>
              <span>for {forDuration(cur.duration)}</span>
            </>
          ) : cur ? (
            <>
              <span>free ride</span>
              <b>{forDuration(cur.duration)}</b>
              <span>your pace</span>
            </>
          ) : (
            <>
              <span>{st?.finished ? 'done!' : 'free ride'}</span>
              <b>{(snap.grade * 100).toFixed(1)}%</b>
              <span>grade</span>
            </>
          )}
        </div>
        <div className={`zh-power ${powerClass}`}>
          {r0(p3)}
          <small>w</small>
        </div>
        <div className="zh-side">
          <span>
            {r0(snap.hr)} <i className="zh-hr"><Heart /></i>
          </span>
          <span>
            {r0(snap.cadence)} <i className="zh-cad"><Crank /></i>
          </span>
        </div>
      </div>

      <div className="zh-foot">
        <span className="zh-next">
          {next && cur ? (
            <>
              <span className="dotc" style={{ background: ivColor(next, ftp) }} /> next {formatDuration(next.duration)}
              {next.free ? ' free ride' : ` @ ${targetText(next, ftp, k)}`}
            </>
          ) : st?.finished ? (
            'workout complete'
          ) : !st ? (
            `${fmtDist(snap.distance % route.length, settings)} / ${fmtDist(route.length, settings)} ${distUnit(settings)}`
          ) : (
            'last interval'
          )}
        </span>
        <span className="zh-left">
          <Flag /> {st && !st.finished ? formatDuration(Math.ceil(st.totalRemaining)) : `lap ${Math.floor(snap.distance / route.length) + 1}`}
        </span>
      </div>
      <div className="zh-wbar">
        <div style={{ width: `${wFrac * 100}%` }} />
      </div>
    </div>
  );
}
