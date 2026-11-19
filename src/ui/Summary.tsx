import type { RideRecord } from '../app/recorder';
import { lapStats } from '../app/recorder';
import type { Settings } from '../storage/db';
import { downloadBlob, rideFileName, rideToFit } from '../export/fit';
import { formatDuration } from '../workout/model';
import { distUnit, elevUnit, fmtDist, fmtElev, r0 } from './format';
import { StravaButton } from './StravaButton';

/** Power + HR trace for a finished ride. */
function RideTrace({ ride, maxHr }: { ride: RideRecord; maxHr: number }) {
  const s = ride.samples;
  if (s.length < 2) return null;
  const W = 1000;
  const H = 140;
  const maxP = Math.max(ride.ftp * 1.3, ...s.map((x) => x.power));
  const step = Math.max(1, Math.floor(s.length / 1200));
  let pd = '';
  let td = '';
  let hd = '';
  for (let i = 0; i < s.length; i += step) {
    const x = ((i / (s.length - 1)) * W).toFixed(1);
    const a = s.slice(Math.max(0, i - 4), i + 1);
    const p = a.reduce((q, v) => q + v.power, 0) / a.length;
    pd += `${pd ? 'L' : 'M'}${x},${(H - (p / maxP) * H).toFixed(1)}`;
    if (s[i].target != null) td += `${td ? 'L' : 'M'}${x},${(H - (s[i].target! / maxP) * H).toFixed(1)}`;
    if (s[i].hr) hd += `${hd ? 'L' : 'M'}${x},${(H - (s[i].hr! / maxHr) * H).toFixed(1)}`;
  }
  return (
    <svg className="workout-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
      {td && <path d={td} fill="none" stroke="#f2c94c" strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.8} />}
      {hd && <path d={hd} fill="none" stroke="#ff6b81" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      <path d={pd} fill="none" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Summary({ ride, settings, stravaConnected, onStravaUpload, onClose }: {
  ride: RideRecord;
  settings: Settings;
  stravaConnected: boolean;
  onStravaUpload: (r: RideRecord) => void;
  onClose: () => void;
}) {
  const s = ride.summary;
  return (
    <div className="page">
      <div className="row space">
        <div>
          <h2>{ride.name}</h2>
          <div className="muted">
            {new Date(ride.startTime).toLocaleString()} · {ride.routeName}
          </div>
          {ride.strava?.status === 'error' && <div className="small strava-status" style={{ color: '#ffb3b0' }}>Strava: {ride.strava.error}</div>}
        </div>
        <div className="row">
          <StravaButton ride={ride} connected={stravaConnected} onUpload={onStravaUpload} />
          <button className="primary" onClick={() => downloadBlob(rideToFit(ride), rideFileName(ride))}>Download .fit</button>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
      <div className="stats-grid">
        {[
          ['Time', formatDuration(s.duration)],
          ['Distance', `${fmtDist(s.distance, settings)} ${distUnit(settings)}`],
          ['Avg power', `${r0(s.avgPower)} W`],
          ['NP', `${r0(s.np)} W`],
          ['Max power', `${r0(s.maxPower)} W`],
          ['IF', s.if.toFixed(2)],
          ['TSS', r0(s.tss)],
          ['Work', `${r0(s.kj)} kJ`],
          ['Avg HR', `${r0(s.avgHr)} bpm`],
          ['Max HR', `${r0(s.maxHr)} bpm`],
          ['Avg cadence', `${r0(s.avgCadence)} rpm`],
          ['Climbing', `${fmtElev(s.climb, settings)} ${elevUnit(settings)}`],
        ].map(([k, v]) => (
          <div key={k} className="stat">
            <div className="muted small">{k}</div>
            <div className="stat-v">{v}</div>
          </div>
        ))}
      </div>
      <RideTrace ride={ride} maxHr={settings.maxHr} />
      <div className="muted small legend">
        <span style={{ color: '#fff' }}>■ power</span> <span style={{ color: '#f2c94c' }}>■ target</span> <span style={{ color: '#ff6b81' }}>■ heart rate</span>
      </div>
      {ride.laps.length > 1 && (
        <table className="laps">
          <thead>
            <tr>
              <th>#</th>
              <th>Interval</th>
              <th>Time</th>
              <th>Target</th>
              <th>Avg W</th>
              <th>Avg HR</th>
              <th>Max HR</th>
              <th>Cadence</th>
            </tr>
          </thead>
          <tbody>
            {ride.laps.map((lap, i) => {
              const ls = lapStats(ride.samples, lap);
              return (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{lap.label ?? ''}</td>
                  <td>{formatDuration(ls.duration)}</td>
                  <td>{lap.target != null ? `${r0(lap.target)} W` : '--'}</td>
                  <td>{r0(ls.avgPower)}</td>
                  <td>{r0(ls.avgHr)}</td>
                  <td>{r0(ls.maxHr)}</td>
                  <td>{r0(ls.avgCadence)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">
        {stravaConnected ? 'Rides upload to Strava automatically when auto-upload is on (Settings → Strava). You can also upload the .fit to' : 'Connect Strava in Settings to upload rides automatically, or upload the .fit to Strava (Upload activity → File),'} intervals.icu, TrainingPeaks, or TrainerRoad (Career → Upload ride). It records as a virtual ride with one lap per interval.
      </p>
    </div>
  );
}
