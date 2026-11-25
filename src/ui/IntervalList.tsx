import { useRef } from 'react';
import type { RideSession, Snapshot } from '../app/session';
import { formatDuration, intervalFtpFraction, zoneFor, type Interval } from '../workout/model';
import { r0 } from './format';
import { ivColor } from './MiniMap';
import { targetText } from './RideHud';
import { avgHrBetween, avgPowerBetween, intervalWindow } from './intervalWindow';

function ivName(iv: Interval, ftp: number) {
  return iv.label ?? (iv.free ? 'Free ride' : zoneFor(intervalFtpFraction(iv, ftp)).name);
}

/**
 * Compact vertical list of workout intervals for the left HUD panel: the last
 * couple of completed intervals (dimmed, with a check and the average power
 * actually ridden), the current one highlighted with its progress, and the
 * next few upcoming. The window slides along as the workout advances.
 * Renders nothing for free rides.
 */
export function IntervalList({ session, snap, ftp }: { session: RideSession; snap: Snapshot; ftp: number }) {
  const engine = session.engine;
  const st = snap.workout;
  // Completed intervals never change, so cache their average power by timeline position.
  const avgCache = useRef(new Map<string, number | undefined>());
  if (!engine || !st || !engine.intervals.length) return null;

  const ivs = engine.intervals;
  const k = (st.intensity ?? 100) / 100;
  const cur = st.finished ? ivs.length : st.index;
  const { from, to } = intervalWindow(ivs.length, cur, st.finished ? 3 : 2, 5);

  const avgOf = (iv: Interval) => {
    const key = `${iv.start}:${iv.duration}`;
    if (!avgCache.current.has(key)) {
      // The workout clock runs in lock-step with the ride's moving clock, so
      // recorded samples line up with the interval's timeline position.
      avgCache.current.set(key, avgPowerBetween(session.samples, iv.start, iv.start + iv.duration));
    }
    return avgCache.current.get(key);
  };

  const rows = [];
  for (let i = from; i < to; i++) {
    const iv = ivs[i];
    const color = ivColor(iv, ftp);
    const tgt = targetText(iv, ftp, k);
    const state = i < cur ? 'done' : i === cur ? 'now' : 'next';
    // only the nearest upcoming rows survive on short screens
    const far = state === 'next' && i > cur + 3;
    if (state === 'done') {
      const avg = avgOf(iv);
      rows.push(
        <li key={i} className="ivl-row ivl-done" title={ivName(iv, ftp)}>
          <span className="ivl-mark">✓</span>
          <span className="ivl-name">{ivName(iv, ftp)}</span>
          <span className="ivl-dur">{formatDuration(iv.duration)}</span>
          <span className="ivl-w">
            {avg != null ? (
              <>
                {r0(avg)}w{tgt && <small> / {tgt}</small>}
              </>
            ) : (
              tgt ?? 'free'
            )}
          </span>
        </li>,
      );
    } else if (state === 'now') {
      const frac = Math.min(1, Math.max(0, st.timeInInterval / iv.duration));
      rows.push(
        <li key={i} className="ivl-row ivl-now" style={{ borderColor: color }} title={ivName(iv, ftp)}>
          <div className="ivl-prog" style={{ width: `${frac * 100}%`, background: color }} />
          <span className="ivl-mark" style={{ color }}>▶</span>
          <span className="ivl-name">{ivName(iv, ftp)}</span>
          <span className="ivl-dur">{formatDuration(Math.ceil(st.remaining))}</span>
          <span className="ivl-w">{tgt ?? 'free'}</span>
        </li>,
      );
    } else {
      rows.push(
        <li key={i} className={`ivl-row ivl-next ${far ? 'ivl-far' : ''}`} title={ivName(iv, ftp)}>
          <span className="ivl-mark">
            <span className="ivl-swatch" style={{ background: color }} />
          </span>
          <span className="ivl-name">{ivName(iv, ftp)}</span>
          <span className="ivl-dur">{formatDuration(iv.duration)}</span>
          <span className="ivl-w" style={{ color }}>{tgt ?? 'free'}</span>
        </li>,
      );
    }
  }

  const doneHidden = from;
  const moreHidden = ivs.length - to;
  return (
    <div className="ivl">
      <div className="ivl-head">
        <span>Intervals</span>
        <span>
          {Math.min(cur + (st.finished ? 0 : 1), ivs.length)} / {ivs.length}
        </span>
      </div>
      {doneHidden > 0 && <div className="ivl-more">{doneHidden} done</div>}
      <ol className="ivl-list">{rows}</ol>
      {moreHidden > 0 && <div className="ivl-more">+{moreHidden} more</div>}
    </div>
  );
}

/**
 * Repeated intervals (same length and target power) that have been ridden at least
 * once: their average power and heart rate for each rep side by side, so fading or
 * drifting across a set is easy to see at a glance.
 */
export function RepeatSummary({ session, snap, ftp }: { session: RideSession; snap: Snapshot; ftp: number }) {
  const engine = session.engine;
  const st = snap.workout;
  const cache = useRef(new Map<number, { p?: number; hr?: number }>());
  if (!engine || !st) return null;
  const ivs = engine.intervals;
  const cur = st.finished ? ivs.length : st.index;
  const k = (st.intensity ?? 100) / 100;

  const groups = new Map<string, Interval[]>();
  for (const iv of ivs) {
    if (iv.free) continue;
    const sig = `${iv.duration}|${iv.powerStart}|${iv.powerEnd}|${iv.unit}`;
    groups.set(sig, [...(groups.get(sig) ?? []), iv]);
  }
  const rep = [...groups.values()].filter((g) => g.length >= 2 && g[0].index < cur);
  if (!rep.length) return null;

  const statsOf = (iv: Interval) => {
    let v = cache.current.get(iv.index);
    if (!v) {
      v = {
        p: avgPowerBetween(session.samples, iv.start, iv.start + iv.duration),
        hr: avgHrBetween(session.samples, iv.start, iv.start + iv.duration),
      };
      cache.current.set(iv.index, v);
    }
    return v;
  };

  return (
    <div className="rep">
      <div className="ivl-head">
        <span>Repeats</span>
      </div>
      {rep.map((g) => {
        const done = g.filter((iv) => iv.index < cur);
        const rows = done.map((iv) => statsOf(iv));
        const tgt = targetText(g[0], ftp, k);
        return (
          <div key={g[0].index} className="rep-group">
            <div className="rep-title">
              {ivName(g[0], ftp)} <small>{formatDuration(g[0].duration)}{tgt ? ` @ ${tgt}` : ''} · {done.length}/{g.length}</small>
            </div>
            <div className="rep-line">
              <span className="rep-k">W</span>
              <span className="rep-vals">
                {rows.map((r, i) => (
                  <b key={i}>{r.p != null ? r0(r.p) : '–'}</b>
                ))}
              </span>
            </div>
            <div className="rep-line">
              <span className="rep-k">HR</span>
              <span className="rep-vals rep-hr">
                {rows.map((r, i) => (
                  <b key={i}>{r.hr != null ? r0(r.hr) : '–'}</b>
                ))}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
