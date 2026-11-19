import type { RideRecord } from '../app/recorder';
import { rideFileName, rideToFit } from '../export/fit';
import { formatDuration } from '../workout/model';
import { saveRide } from '../storage/db';
import { updateActivity, uploadFit } from './strava';

function description(ride: RideRecord) {
  const s = ride.summary;
  const parts = [
    ride.workoutName ? `Workout: ${ride.workoutName}` : 'Free ride',
    `Route: ${ride.routeName}`,
    `${formatDuration(s.duration)} · NP ${Math.round(s.np)} W · IF ${s.if.toFixed(2)} · TSS ${Math.round(s.tss)}`,
    'Ridden on RideBox',
  ];
  return parts.join('\n');
}

/**
 * Sends a ride to Strava, saving its progress on the ride record so the
 * History and Summary views can show it. `onUpdate` fires on every change.
 */
export async function uploadRide(ride: RideRecord, opts: { hidden: boolean }, onUpdate?: (r: RideRecord) => void): Promise<RideRecord> {
  const set = async (strava: RideRecord['strava']) => {
    ride = { ...ride, strava };
    await saveRide(ride);
    onUpdate?.(ride);
  };
  await set({ status: 'uploading' });
  try {
    const result = await uploadFit(rideToFit(ride), {
      name: ride.name,
      description: description(ride),
      externalId: `ridebox-${ride.id}`,
      fileName: rideFileName(ride),
    });
    if (result.status === 'done' && result.activityId && opts.hidden) {
      try {
        await updateActivity(result.activityId, { hide_from_home: true });
        result.hidden = true;
      } catch (e) {
        result.error = `Uploaded, but couldn\u2019t hide it from feeds: ${(e as Error).message}`;
      }
    }
    await set(result);
  } catch (e) {
    await set({ status: 'error', error: (e as Error).message });
  }
  return ride;
}

/** Renames a ride locally and, if it's on Strava, there too. */
export async function renameRide(ride: RideRecord, name: string): Promise<{ ride: RideRecord; stravaError?: string }> {
  const next = { ...ride, name };
  await saveRide(next);
  if (ride.strava?.status === 'done' && ride.strava.activityId) {
    try {
      await updateActivity(ride.strava.activityId, { name });
    } catch (e) {
      return { ride: next, stravaError: (e as Error).message };
    }
  }
  return { ride: next };
}
