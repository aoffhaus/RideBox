import { Encoder, Profile } from '@garmin/fitsdk';
import type { RideRecord } from '../app/recorder';
import { lapStats } from '../app/recorder';

/**
 * Encodes a ride as a FIT activity (sport: cycling, sub-sport: virtual activity)
 * with one lap per workout interval. Upload to Strava / TrainingPeaks /
 * intervals.icu / TrainerRoad (Career → Upload ride).
 */
export function rideToFit(ride: RideRecord): Uint8Array {
  const encoder = new Encoder();
  // The SDK's TypeScript types are stricter than its runtime (which takes decoder-style objects).
  const enc = { onMesg: (num: number, mesg: Record<string, unknown>) => encoder.onMesg(num as any, mesg as any) };
  const M = Profile.MesgNum;
  const start = new Date(ride.startTime);
  const samples = ride.samples;
  const lastTs = samples.length ? new Date(samples[samples.length - 1].t) : start;
  const s = ride.summary;

  enc.onMesg(M.FILE_ID, {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    serialNumber: 1234,
    timeCreated: start,
  });
  enc.onMesg(M.DEVICE_INFO, {
    deviceIndex: 'creator',
    manufacturer: 'development',
    product: 1,
    productName: 'RideBox',
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
