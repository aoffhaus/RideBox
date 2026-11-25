import { Encoder, Profile } from '@garmin/fitsdk';
import type { RideRecord } from '../app/recorder';
import { lapStats } from '../app/recorder';

/**
 * Encodes a ride as a FIT activity (sport: cycling, sub-sport: virtual activity)
 * with one lap per workout interval. Upload to Strava / TrainingPeaks /
 * intervals.icu / TrainerRoad (Career → Upload ride).
 */
export interface FitOptions {
  /**
   * Label the file as recorded on a Garmin Edge. Garmin Connect only computes
   * Training Effect / Exercise Load (from heart rate) for activities it
   * attributes to one of its own devices; files from other manufacturers are
   * stored without it. Used for the Garmin export only, so Strava and plain
   * downloads still show RideBox as the device.
   */
  garminDevice?: boolean;
}

/** Garmin Edge 830 — a common bike computer Garmin Connect runs its load model for. */
const GARMIN_EDGE_830 = 3122;

/**
 * Calories burned from mechanical work. Human gross efficiency on a bike is
 * ~20-25%, and 1 kcal = 4.184 kJ, so kcal ≈ kJ — the standard cycling estimate.
 */
export const kjToKcal = (kj: number) => Math.round(kj);

export function rideToFit(ride: RideRecord, opts: FitOptions = {}): Uint8Array {
  const encoder = new Encoder();
  // The SDK's TypeScript types are stricter than its runtime (which takes decoder-style objects).
  const enc = { onMesg: (num: number, mesg: Record<string, unknown>) => encoder.onMesg(num as any, mesg as any) };
  const M = Profile.MesgNum;
  const start = new Date(ride.startTime);
  const samples = ride.samples;
  const lastTs = samples.length ? new Date(samples[samples.length - 1].t) : start;
  const s = ride.summary;
  const device = opts.garminDevice
    ? { manufacturer: 'garmin', product: GARMIN_EDGE_830 }
    : { manufacturer: 'development', product: 1 };

  enc.onMesg(M.FILE_ID, {
    type: 'activity',
    ...device,
    serialNumber: 1234,
    timeCreated: start,
  });
  enc.onMesg(M.DEVICE_INFO, {
    deviceIndex: 'creator',
    ...device,
    ...(opts.garminDevice ? {} : { productName: 'RideBox' }),
    softwareVersion: 1.0,
    timestamp: start,
  });
  enc.onMesg(M.EVENT, { timestamp: start, event: 'timer', eventType: 'start' });

  for (const r of samples) {
    enc.onMesg(M.RECORD, {
      timestamp: new Date(r.t),
      power: Math.max(0, Math.round(r.power)),
      ...(r.hr ? { heartRate: Math.round(r.hr) } : {}),
      ...(r.cadence != null ? { cadence: Math.round(r.cadence) } : {}),
      speed: r.speed,
      enhancedSpeed: r.speed,
      distance: r.distance,
      altitude: r.altitude,
      enhancedAltitude: r.altitude,
    });
  }

  enc.onMesg(M.EVENT, { timestamp: lastTs, event: 'timer', eventType: 'stopAll' });

  ride.laps.forEach((lap, i) => {
    const ls = lapStats(samples, lap);
    const first = samples[lap.startIndex];
    const last = samples[Math.max(lap.startIndex, lap.endIndex - 1)];
    if (!first || !last) return;
    const prevDist = lap.startIndex > 0 ? samples[lap.startIndex - 1].distance : 0;
    const powers = samples.slice(lap.startIndex, lap.endIndex).map((x) => x.power);
    enc.onMesg(M.LAP, {
      messageIndex: i,
      timestamp: new Date(last.t),
      startTime: new Date(first.t),
      totalElapsedTime: ls.duration,
      totalTimerTime: ls.duration,
      totalDistance: Math.max(0, last.distance - prevDist),
      avgPower: Math.round(ls.avgPower),
      maxPower: powers.length ? Math.max(...powers) : 0,
      totalCalories: kjToKcal(powers.reduce((a, b) => a + Math.max(0, b), 0) / 1000),
      ...(ls.avgHr ? { avgHeartRate: Math.round(ls.avgHr), maxHeartRate: Math.round(ls.maxHr!) } : {}),
      ...(ls.avgCadence ? { avgCadence: Math.round(ls.avgCadence) } : {}),
      event: 'lap',
      eventType: 'stop',
      lapTrigger: 'time',
      sport: 'cycling',
      subSport: 'virtualActivity',
    });
  });

  enc.onMesg(M.SESSION, {
    messageIndex: 0,
    timestamp: lastTs,
    startTime: start,
    totalElapsedTime: s.duration,
    totalTimerTime: s.duration,
    totalDistance: s.distance,
    sport: 'cycling',
    subSport: 'virtualActivity',
    firstLapIndex: 0,
    numLaps: ride.laps.length,
    avgPower: Math.round(s.avgPower),
    maxPower: Math.round(s.maxPower),
    normalizedPower: Math.round(s.np),
    thresholdPower: ride.ftp,
    trainingStressScore: Math.round(s.tss * 10) / 10,
    intensityFactor: Math.round(s.if * 1000) / 1000,
    totalWork: Math.round(s.kj * 1000),
    totalCalories: kjToKcal(s.kj),
    totalAscent: Math.round(s.climb),
    ...(s.avgHr ? { avgHeartRate: Math.round(s.avgHr), maxHeartRate: Math.round(s.maxHr!) } : {}),
    ...(s.avgCadence ? { avgCadence: Math.round(s.avgCadence) } : {}),
    event: 'session',
    eventType: 'stop',
    trigger: 'activityEnd',
  });

  enc.onMesg(M.ACTIVITY, {
    timestamp: lastTs,
    numSessions: 1,
    totalTimerTime: s.duration,
    localTimestamp: Math.round((lastTs.getTime() - lastTs.getTimezoneOffset() * 60000) / 1000) - 631065600,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });

  return encoder.close();
}

export function downloadBlob(data: BlobPart, fileName: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function rideFileName(ride: RideRecord) {
  const d = new Date(ride.startTime);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `RideBox_${stamp}_${ride.name.replace(/[^\w-]+/g, '_')}.fit`;
}

export const GARMIN_IMPORT_URL = 'https://connect.garmin.com/modern/import-data';

/**
 * Garmin has no upload API for personal apps, so: download the .fit and open
 * Garmin Connect's Import Data page, where the file can be dropped in.
 * The tab opens first, synchronously inside the click, so it isn't popup-blocked.
 */
export function sendToGarmin(ride: RideRecord) {
  window.open(GARMIN_IMPORT_URL, '_blank', 'noopener');
  downloadBlob(rideToFit(ride, { garminDevice: true }), rideFileName(ride));
}
