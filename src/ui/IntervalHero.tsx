import type { RideSession, Snapshot } from '../app/session';
import type { Settings } from '../storage/db';
import { formatDuration, toWatts, type Interval } from '../workout/model';
import { distUnit, elevUnit, fmtDist, fmtElev } from './format';
import { ivColor } from './MiniMap';

/**
 * Top-centre hero: countdown to the next interval (or the end of the workout),
 * the current interval's progress in its zone colour, distance to go, and a
 * preview of what's next. In free ride it shows the route and lap instead.
 */
export function IntervalHero({ session, settings, snap }: { session: RideSession; settings: Settings; snap: Snapshot }) {
  const ftp = settings.ftp;
  const st = snap.workout;
  const cur = st?.interval;
  const route = session.route;

  if (!st || st.finished || !cur) {
    const lapFrac = (snap.distance % route.length) / route.length;
    return (
      <div className="hero">
        <div className="hero-head">
          <span className="hero-label">{st?.finished ? 'Workout complete' : 'Free ride'}</span>
          <span className="hero-index">lap {Math.floor(snap.distance / route.length) + 1}</span>
        </div>
        <div className="hero-route">{route.preset.name}</div>
        <div className="hero-bar">
          <div style={{ width: `${lapFrac * 100}%`, background: 'var(--accent)' }} />
        </div>
        <div className="hero-foot">
          <span>
            {fmtDist(snap.distance % route.length, settings)} / {fmtDist(route.length, settings)} {distUnit(settings)}
          </span>
          <span className="muted">
            {fmtElev(route.totalClimb, settings)} {elevUnit(settings)} climbing / lap
          </span>
        </div>
      </div>
    );
  }

  const nextIv = st.next;
  const k = st.intensity / 100;
  const frac = Math.min(1, Math.max(0, st.timeInInterval / cur.duration));
  const up = snap.upcoming[0];
  const toGo = up ? Math.max(0, up.distance - snap.distance) : 0;
  const color = ivColor(cur, ftp);
  const watts = (iv: Interval) =>
    iv.free
      ? 'free ride'
      : iv.powerStart === iv.powerEnd
        ? `${Math.round(toWatts(iv.powerStart, iv.unit, ftp) * k)} W`
        : `${Math.round(toWatts(iv.powerStart, iv.unit, ftp) * k)}→${Math.round(toWatts(iv.powerEnd, iv.unit, ftp) * k)} W`;

  return (
    <div className="hero" style={{ ['--iv' as string]: color }}>
      <div className="hero-head">
        <span className="hero-label">{nextIv ? 'Next interval in' : 'Workout ends in'}</span>
        <span className="hero-index">
          {st.index + 1} / {session.engine!.intervals.length}
        </span>
      </div>
      <div className="hero-main">
        <span className="hero-time" style={{ color }}>
          {formatDuration(Math.ceil(st.remaining))}
        </span>
        <span className="hero-dist">
          {fmtDist(toGo, settings)} <small>{distUnit(settings)}</small>
        </span>
      </div>
      <div className="hero-bar">
        <div style={{ width: `${frac * 100}%`, background: color }} />
      </div>
      <div className="hero-foot">
        {nextIv ? (
          <span className="hero-next">
            <span className="hero-next-label">Next</span>
            <span className="dotc" style={{ background: ivColor(nextIv, ftp) }} />
            <b>{formatDuration(nextIv.duration)}</b> {nextIv.free ? 'free ride' : `@ ${watts(nextIv)}`}
          </span>
        ) : (
          <span className="hero-next">
            <span className="hero-next-label">Then</span> cool down / keep riding
          </span>
        )}
      </div>
    </div>
  );
}
