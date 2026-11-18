// Core workout model.
//
// Power values are stored as a FRACTION of FTP (0.95 = 95%) when unit is 'ftp'
// (the default), or as absolute watts when unit is 'watts'.

export type PowerUnit = 'ftp' | 'watts';

export interface TextCue {
  offset: number; // seconds from the start of the step
  message: string;
  duration?: number;
}

export interface SteadyStep {
  type: 'steady';
  duration: number; // seconds
  power: number;
  unit?: PowerUnit;
  cadence?: number;
  label?: string;
  cues?: TextCue[];
}

export interface RampStep {
  type: 'ramp';
  duration: number;
  from: number;
  to: number;
  unit?: PowerUnit;
  cadence?: number;
  label?: string;
  cues?: TextCue[];
}

/** Free-ride segment: no ERG target (the trainer runs in SIM mode). */
export interface FreeStep {
  type: 'free';
  duration: number;
  label?: string;
  cues?: TextCue[];
}

export interface RepeatStep {
  type: 'repeat';
  count: number;
  steps: Step[];
}

export type Step = SteadyStep | RampStep | FreeStep | RepeatStep;

export interface Workout {
  name: string;
  description?: string;
  author?: string;
  steps: Step[];
}

/** A flattened, timeline-positioned interval. Each one gets an arch. */
export interface Interval {
  index: number;
  start: number; // seconds from workout start
  duration: number;
  powerStart: number; // fraction of FTP or watts per `unit`
  powerEnd: number;
  unit: PowerUnit;
  free: boolean;
  cadence?: number;
  label?: string;
  cues: TextCue[];
}

export function flatten(workout: Workout): Interval[] {
  const out: Interval[] = [];
  let t = 0;
  const walk = (steps: Step[]) => {
    for (const s of steps) {
      if (s.type === 'repeat') {
        for (let i = 0; i < s.count; i++) walk(s.steps);
        continue;
      }
      if (!(s.duration > 0)) continue;
      const base = {
        index: out.length,
        start: t,
        duration: s.duration,
        label: s.label,
        cues: s.cues ?? [],
      };
      if (s.type === 'steady') {
        out.push({ ...base, powerStart: s.power, powerEnd: s.power, unit: s.unit ?? 'ftp', free: false, cadence: s.cadence });
      } else if (s.type === 'ramp') {
        out.push({ ...base, powerStart: s.from, powerEnd: s.to, unit: s.unit ?? 'ftp', free: false, cadence: s.cadence });
      } else {
        out.push({ ...base, powerStart: 0, powerEnd: 0, unit: 'ftp', free: true });
      }
      t += s.duration;
    }
  };
  walk(workout.steps);
  return out;
}

export function totalDuration(intervals: Interval[]): number {
  const last = intervals[intervals.length - 1];
  return last ? last.start + last.duration : 0;
}

/** Target power (fraction or watts per unit) at `t` seconds into an interval. */
export function intervalPowerAt(iv: Interval, t: number): number {
  if (iv.duration <= 0) return iv.powerStart;
  const f = Math.min(1, Math.max(0, t / iv.duration));
  return iv.powerStart + (iv.powerEnd - iv.powerStart) * f;
}

export function toWatts(value: number, unit: PowerUnit, ftp: number): number {
  return unit === 'watts' ? value : value * ftp;
}

/** Average target as a fraction of FTP (for zone coloring). */
export function intervalFtpFraction(iv: Interval, ftp: number): number {
  const avg = (iv.powerStart + iv.powerEnd) / 2;
  return iv.unit === 'watts' ? avg / ftp : avg;
}

// Coggan power zones
export interface Zone {
  name: string;
  max: number; // upper bound (fraction of FTP)
  color: string;
}

export const ZONES: Zone[] = [
  { name: 'Z1 Recovery', max: 0.55, color: '#8a8f98' },
  { name: 'Z2 Endurance', max: 0.75, color: '#2f80ed' },
  { name: 'Z3 Tempo', max: 0.9, color: '#27ae60' },
  { name: 'Z4 Threshold', max: 1.05, color: '#f2c94c' },
  { name: 'Z5 VO2max', max: 1.2, color: '#f2994a' },
  { name: 'Z6 Anaerobic', max: Infinity, color: '#eb5757' },
];

export function zoneFor(fraction: number): Zone {
  return ZONES.find((z) => fraction < z.max) ?? ZONES[ZONES.length - 1];
}

/** Estimated TSS / IF for a workout at a given FTP (planned, not actual). */
export function plannedStats(intervals: Interval[], ftp: number) {
  let sum4 = 0;
  let total = 0;
  for (const iv of intervals) {
    if (iv.free) continue;
    const n = Math.max(1, Math.round(iv.duration));
    for (let i = 0; i < n; i++) {
      const w = toWatts(intervalPowerAt(iv, (i + 0.5) * (iv.duration / n)), iv.unit, ftp);
      sum4 += Math.pow(w, 4) * (iv.duration / n);
    }
    total += iv.duration;
  }
  if (total === 0) return { duration: totalDuration(intervals), np: 0, if: 0, tss: 0 };
  const np = Math.pow(sum4 / total, 0.25);
  const IF = np / ftp;
  return { duration: totalDuration(intervals), np, if: IF, tss: (total * IF * IF * 100) / 3600 };
}

// ---------- durations ----------

/** Parse "10m", "30s", "1h", "1h5m", "8:00", "1:02:30", "90" (seconds) → seconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input;
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    return s.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = parseFloat(m[1]);
    const u = m[2][0];
    total += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
  }
  if (!matched) throw new Error(`Can't read duration "${input}"`);
  return total;
}

export function formatDuration(sec: number, alwaysHours = false): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 || alwaysHours ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
