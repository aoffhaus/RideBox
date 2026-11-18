import type { RideRecord } from '../app/recorder';
import type { Settings } from '../storage/db';
import { deleteRide } from '../storage/db';
import { downloadBlob, rideFileName, rideToFit } from '../export/fit';
import { formatDuration } from '../workout/model';
import { distUnit, fmtDist, r0 } from './format';

export function History({ rides, settings, onOpen, onChange }: { rides: RideRecord[]; settings: Settings; onOpen: (r: RideRecord) => void; onChange: () => void }) {
  if (!rides.length) return <div className="page"><h2>History</h2><p className="muted">No rides yet.</p></div>;
  return (
    <div className="page">
      <h2>History</h2>
      <table className="laps history">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ride</th>
            <th>Time</th>
            <th>Dist</th>
            <th>Avg W</th>
            <th>NP</th>
            <th>TSS</th>
            <th>Avg HR</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rides.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.startTime).toLocaleDateString()}</td>
              <td>
                <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r); }}>{r.name}</a>
              </td>
              <td>{formatDuration(r.summary.duration)}</td>
              <td>{fmtDist(r.summary.distance, settings)} {distUnit(settings)}</td>
              <td>{r0(r.summary.avgPower)}</td>
              <td>{r0(r.summary.np)}</td>
              <td>{r0(r.summary.tss)}</td>
              <td>{r0(r.summary.avgHr)}</td>
              <td className="row">
                <button onClick={() => downloadBlob(rideToFit(r), rideFileName(r))}>.fit</button>
                <button
                  className="danger-text"
                  onClick={async () => {
                    if (confirm('Delete this ride?')) {
                      await deleteRide(r.id);
                      onChange();
                    }
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
