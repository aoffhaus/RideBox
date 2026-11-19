import { useEffect, useState } from 'react';
import type { RideRecord } from '../app/recorder';
import { lapStats } from '../app/recorder';
import type { Settings } from '../storage/db';
import { downloadBlob, rideFileName, rideToFit } from '../export/fit';
import { formatDuration } from '../workout/model';
import { distUnit, elevUnit, fmtDist, fmtElev, r0 } from './format';
import { activityUrl } from '../strava/strava';

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

/** Upload options / status for the ride. */
function StravaPanel({ ride, connected, onUpload }: { ride: RideRecord; connected: boolean; onUpload: (r: RideRecord, opts: { hidden: boolean }) => void }) {
  const [hidden, setHidden] = useState(false);
  const st = ride.strava;
  if (st?.status === 'done' && st.activityId) {
    return (
      <div className="card strava-card">
        <div className="row space">
          <div>
            <b>On Strava</b>
            {st.hidden && <span className="badge" style={{ marginLeft: 8 }}>hidden from feeds</span>}
          </div>
          <a className="strava-link" href={activityUrl(st.activityId)} target="_blank" rel="noreferrer">View on Strava ↗</a>
        </div>
        {st.error && <div className="small strava-error">{st.error}</div>}
        <div className="muted small strava-status">
          Renaming the ride here renames it on Strava too.
        </div>
      </div>
    );
  }
  if (!connected) {
    return <p className="muted small">Connect Strava in Settings to upload this ride.</p>;
  }
  const uploading = st?.status === 'uploading';
  return (
    <div className="card strava-card">
      <div className="row space">
        <label className="row">
          <input type="checkbox" checked={hidden} disabled={uploading} onChange={(e) => setHidden(e.target.checked)} />
          Hide from followers&apos; feeds
        </label>
        <button className="strava" disabled={uploading} onClick={() => onUpload(ride, { hidden })}>
          {uploading ? 'Uploading to Strava…' : st?.status === 'error' ? 'Retry Strava upload' : 'Upload to Strava'}
        </button>
      </div>
      {st?.status === 'error' && <div className="small strava-error">Strava: {st.error}</div>}
      <div className="muted small strava-status">
        Hiding mutes the activity: it&apos;s still on your profile, but doesn&apos;t appear in followers&apos; feeds or count toward their notifications.
        Strava doesn&apos;t let apps upload as Only You; to make every upload private, set{' '}
        <a href="https://www.strava.com/settings/privacy" target="_blank" rel="noreferrer">Privacy Controls → Activities</a> to Only You on Strava.
      </div>
    </div>
  );
}

export function Summary({ ride, settings, stravaConnected, onStravaUpload, onRename, onDelete, onClose }: {
  ride: RideRecord;
  settings: Settings;
  stravaConnected: boolean;
  onStravaUpload: (r: RideRecord, opts: { hidden: boolean }) => void;
  onRename: (r: RideRecord, name: string) => Promise<string | undefined>;
  onDelete: (r: RideRecord) => void;
  onClose: () => void;
}) {
  const s = ride.summary;
  const [name, setName] = useState(ride.name);
  const [renameMsg, setRenameMsg] = useState('');
  useEffect(() => setName(ride.name), [ride.id, ride.name]);
  const commitName = async () => {
    const n = name.trim();
    if (!n) return setName(ride.name);
    if (n === ride.name) return;
    const err = await onRename(ride, n);
    const onStrava = ride.strava?.status === 'done';
    setRenameMsg(err ? `Renamed here, but not on Strava: ${err}` : onStrava ? 'Renamed here and on Strava ✓' : 'Renamed ✓');
    setTimeout(() => setRenameMsg(''), err ? 8000 : 2500);
  };
  const del = () => {
    const onStrava = ride.strava?.status === 'done';
    if (confirm(onStrava ? 'Delete this ride from RideBox? (The Strava activity is not affected.)' : 'Delete this ride from RideBox?')) onDelete(ride);
  };
  return (
    <div className="page">
      <div className="row space">
        <div>
          <input
            className="ride-name"
            value={name}
            title="Click to rename"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setName(ride.name);
            }}
          />
          {renameMsg && <div className="small muted">{renameMsg}</div>}
          <div className="muted">
            {new Date(ride.startTime).toLocaleString()} · {ride.routeName}
          </div>
        </div>
        <div className="row">
          <button onClick={() => downloadBlob(rideToFit(ride), rideFileName(ride))}>Download .fit</button>
          <button className="danger" onClick={del}>Delete ride</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
      <StravaPanel ride={ride} connected={stravaConnected} onUpload={(r, opts) => onStravaUpload({ ...r, name: name.trim() || r.name }, opts)} />
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
        You can also upload the .fit to intervals.icu, TrainingPeaks, or TrainerRoad (Career → Upload ride). It records as a virtual ride with one lap per interval.
      </p>
    </div>
  );
}
