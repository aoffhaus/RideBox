import type { RideRecord } from '../app/recorder';
import { activityUrl } from '../strava/strava';

/** Upload / status / "View on Strava" control for one ride. */
export function StravaButton({ ride, connected, onUpload, compact }: { ride: RideRecord; connected: boolean; onUpload: (r: RideRecord) => void; compact?: boolean }) {
  const st = ride.strava;
  if (st?.status === 'done' && st.activityId) {
    return (
      <a className="strava-link" href={activityUrl(st.activityId)} target="_blank" rel="noreferrer">
        {compact ? 'Strava ↗' : 'View on Strava ↗'}
      </a>
    );
  }
  if (st?.status === 'uploading') return <button className="strava" disabled>{compact ? 'Uploading…' : 'Uploading to Strava…'}</button>;
  if (!connected) return null;
  if (st?.status === 'error') {
    return (
      <button className="strava" title={`${st.error} (click to retry)`} onClick={() => onUpload(ride)}>
        {compact ? 'Retry Strava' : 'Retry Strava upload'}
      </button>
    );
  }
  return <button className="strava" title="Choose upload options" onClick={() => onUpload(ride)}>{compact ? 'Strava…' : 'Upload to Strava…'}</button>;
}
