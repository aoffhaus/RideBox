import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { seriesFromRide } from '../training/actual';
import { MetricsChart } from './ActualDetail';
import { ActivityPowerCurve } from './PowerCurve';
import { rideEfforts } from '../app/efforts';
import { CADENCE_COLOR } from './WorkoutChart';
import type { RideRecord } from '../app/recorder';
import { lapStats } from '../app/recorder';
import { getRidePhotos, type Settings } from '../storage/db';
import { downloadBlob, rideFileName, rideToFit, sendToGarmin } from '../export/fit';
import { formatDuration } from '../workout/model';
import { distUnit, elevUnit, fmtDist, fmtElev, r0 } from './format';
import { activityUrl } from '../strava/strava';
import { renderStatCard } from './statCard';

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

/**
 * The ride's stat card (final stats over the highlight photo) and the other ride
 * photo. Strava's API doesn't let apps attach photos, so these are offered to share
 * (phone/tablet: straight into the Strava app) or save, then add on Strava.
 */
function RidePhotos({ ride, settings }: { ride: RideRecord; settings: Settings }) {
  const [photos, setPhotos] = useState<{ url: string; file: File }[]>([]);
  useEffect(() => {
    let urls: string[] = [];
    let live = true;
    void (async () => {
      const [first, ...rest] = await getRidePhotos(ride.id);
      const card = await renderStatCard(ride, settings, first);
      if (!live) return;
      const base = rideFileName(ride).replace(/\.fit$/, '');
      const items = [
        { url: URL.createObjectURL(card), file: new File([card], `${base}-stats.jpg`, { type: 'image/jpeg' }) },
        ...rest.map((b, i) => ({ url: URL.createObjectURL(b), file: new File([b], `${base}-${i + 1}.jpg`, { type: 'image/jpeg' }) })),
      ];
      urls = items.map((p) => p.url);
      setPhotos(items);
    })().catch(() => {});
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // the card shows the name, focus and units, so redraw when those change
  }, [ride.id, ride.name, ride.focus, settings.units]);
  if (!photos.length) return null;
  const files = photos.map((p) => p.file);
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files });
  const share = () => void navigator.share({ files, title: ride.name }).catch(() => {});
  const save = () => photos.forEach((p) => downloadBlob(p.file, p.file.name));
  const st = ride.strava;
  return (
    <div className="card ride-photos">
      <div className="row space">
        <div className="card-title">Stat card{photos.length > 1 ? ' & ride photo' : ''}</div>
        <div className="row">
          {canShare && <button className="primary" onClick={share}>Share…</button>}
          <button onClick={save}>Save {photos.length > 1 ? 'images' : 'image'}</button>
        </div>
      </div>
      <div className="row ride-photos-strip">
        {photos.map((p, i) => (
          <a key={p.url} href={p.url} target="_blank" rel="noreferrer">
            <img
              src={p.url}
              alt={i === 0 ? 'Stat card: ride photo with the final stats' : 'Screenshot from the ride'}
              style={{ width: i === 0 ? 420 : 240, maxWidth: i === 0 ? '62%' : '34%', borderRadius: 6, display: 'block' }}
            />
          </a>
        ))}
      </div>
      <div className="muted small">
        Strava doesn&apos;t let apps add photos, so add these yourself:{' '}
        {st?.status === 'done' && st.activityId ? (
          <a href={activityUrl(st.activityId)} target="_blank" rel="noreferrer">open the activity on Strava ↗</a>
        ) : (
          'once the ride is on Strava, open it'
        )}{' '}
        and choose Edit → Add photos (or share them straight to the Strava app on your phone).
      </div>
    </div>
  );
}

const FEELS = ['Easy', 'Moderate', 'Hard', 'Very hard', 'All out'];

/** "How did it feel?": feeds progression levels and the coach's adaptations. */
function FeelPicker({ ride, onFeel }: { ride: RideRecord; onFeel: (r: RideRecord, feel: number) => void }) {
  return (
    <div className="card feel">
      <div className="card-title">How did it feel?</div>
      <div className="row">
        {FEELS.map((f, i) => (
          <button key={f} className={ride.feel === i + 1 ? 'primary' : ''} onClick={() => onFeel(ride, i + 1)}>
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Summary({ ride, settings, stravaConnected, onStravaUpload, onRename, onDelete, onClose, onFeel, children }: {
  ride: RideRecord;
  onFeel: (r: RideRecord, feel: number) => void;
  /** level change and coach suggestions for this ride */
  children?: ReactNode;
  settings: Settings;
  stravaConnected: boolean;
  onStravaUpload: (r: RideRecord, opts: { hidden: boolean }) => void;
  onRename: (r: RideRecord, name: string) => Promise<string | undefined>;
  onDelete: (r: RideRecord) => void;
  onClose: () => void;
}) {
  const s = ride.summary;
  const series = useMemo(() => seriesFromRide(ride), [ride]);
  const curve = useMemo(() => rideEfforts(ride).power, [ride]);
  const [hl, setHl] = useState<[number, number] | null>(null);
  const [name, setName] = useState(ride.name);
  const [renameMsg, setRenameMsg] = useState('');
  const [garminHint, setGarminHint] = useState(false);
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
          <button
            className="garmin"
            title="Downloads the .fit and opens Garmin Connect's Import Data page: drop the file there"
            onClick={() => {
              sendToGarmin(ride);
              setGarminHint(true);
            }}
          >
            Garmin Connect ↗
          </button>
          <button className="danger" onClick={del}>Delete ride</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
      {garminHint && (
        <div className="banner" onClick={() => setGarminHint(false)}>
          Garmin Connect opened in a new tab. Drag <b>{rideFileName(ride)}</b> from your Downloads onto its Import Data page, then click <b>Import Data</b>.
          (Sign in to Garmin first if asked, then go to <a href="https://connect.garmin.com/modern/import-data" target="_blank" rel="noreferrer">Import Data</a> again.)
        </div>
      )}
      <FeelPicker ride={ride} onFeel={onFeel} />
      {children}
      <StravaPanel ride={ride} connected={stravaConnected} onUpload={(r, opts) => onStravaUpload({ ...r, name: name.trim() || r.name }, opts)} />
      <RidePhotos ride={ride} settings={settings} />
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
      {ride.samples.length > 1 && <MetricsChart series={series} ftp={ride.ftp} highlight={hl} />}
      <div className="muted small legend">
        <span style={{ color: '#fff' }}>■ power</span> <span style={{ color: '#f2c94c' }}>■ target</span> <span style={{ color: '#ff6b81' }}>■ heart rate</span>{' '}
        <span style={{ color: CADENCE_COLOR }}>■ cadence</span>
      </div>
      {curve && <ActivityPowerCurve id={ride.id} start={ride.startTime} curve={curve} settings={settings} onHighlight={setHl} />}
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
