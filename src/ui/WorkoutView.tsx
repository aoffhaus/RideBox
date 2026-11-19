import { useEffect, useMemo, useState } from 'react';
import type { StoredWorkout } from '../storage/db';
import { flatten, formatDuration, intervalFtpFraction, plannedStats, zoneFor } from '../workout/model';
import { WorkoutChart, intervalPowerText } from './WorkoutChart';

interface Props {
  workout: StoredWorkout;
  ftp: number;
  onClose: () => void;
  onRide: (w: StoredWorkout) => void;
  onEdit: (w: StoredWorkout) => void;
}

/** Full-size view of one workout: large hoverable chart plus the interval list. */
export function WorkoutView({ workout, ftp, onClose, onRide, onEdit }: Props) {
  const intervals = useMemo(() => flatten(workout.workout), [workout]);
  const stats = useMemo(() => plannedStats(intervals, ftp), [intervals, ftp]);
  const [rowHover, setRowHover] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal workout-view" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={workout.workout.name}>
        <div className="card-head">
          <div>
            <h2 className="workout-view-title">{workout.workout.name}</h2>
            <div className="muted small">
              {formatDuration(stats.duration)} · TSS {Math.round(stats.tss)} · IF {stats.if.toFixed(2)} · FTP {ftp} W
              {workout.workout.author && ` · ${workout.workout.author}`}
            </div>
          </div>
          <div className="row">
            <button onClick={() => onEdit(workout)}>Edit</button>
            <button className="primary" onClick={() => onRide(workout)}>Ride ▶</button>
            <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="workout-view-chart">
          <WorkoutChart intervals={intervals} ftp={ftp} height={220} highlight={rowHover} />
        </div>

        {workout.workout.description && <p className="muted small desc">{workout.workout.description}</p>}

        <table className="interval-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Start</th>
              <th>Duration</th>
              <th>Target</th>
              <th>Cadence</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {intervals.map((iv, i) => (
              <tr
                key={i}
                className={rowHover === i ? 'hovered' : ''}
                onMouseEnter={() => setRowHover(i)}
                onMouseLeave={() => setRowHover(null)}
              >
                <td>
                  <span className="zone-dot" style={{ background: iv.free ? '#5b6573' : zoneFor(intervalFtpFraction(iv, ftp)).color }} />
                  {i + 1}
                </td>
                <td>{formatDuration(iv.start)}</td>
                <td>{formatDuration(iv.duration)}</td>
                <td>{intervalPowerText(iv, ftp)}</td>
                <td>{iv.cadence ? `${iv.cadence} rpm` : ''}</td>
                <td className="muted">{iv.label ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
