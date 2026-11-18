// 1 Hz ride recording + summary statistics.

export interface Sample {
  t: number; // ms since epoch
  elapsed: number; // ride seconds (moving clock)
  power: number;
  hr?: number;
  cadence?: number;
  speed: number; // m/s (virtual)
  distance: number; // m
  altitude: number; // m
  target?: number; // W
}

export interface Lap {
  startIndex: number; // sample index
  endIndex: number; // exclusive
  label?: string;
  target?: number; // avg target W
}

export interface RideSummary {
  duration: number;
  distance: number;
  avgPower: number;
  maxPower: number;
  np: number;
  if: number;
  tss: number;
  avgHr?: number;
  maxHr?: number;
  avgCadence?: number;
  climb: number;
  kj: number;
}

export interface RideRecord {
  id: string;
  name: string;
  workoutName?: string;
  routeName: string;
  startTime: number;
  ftp: number;
  samples: Sample[];
  laps: Lap[];
  summary: RideSummary;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function normalizedPower(power: number[]): number {
  if (power.length < 30) return mean(power);
  const rolled: number[] = [];
  let sum = 0;
  for (let i = 0; i < power.length; i++) {
    sum += power[i];
    if (i >= 30) sum -= power[i - 30];
    if (i >= 29) rolled.push(Math.pow(sum / 30, 4));
  }
  return Math.pow(mean(rolled), 0.25);
}

export function summarize(samples: Sample[], ftp: number): RideSummary {
  const p = samples.map((s) => s.power);
  const hr = samples.map((s) => s.hr).filter((x): x is number => !!x);
  const cad = samples.map((s) => s.cadence).filter((x): x is number => !!x && x > 0);
  const np = normalizedPower(p);
  const duration = samples.length;
  const IF = ftp ? np / ftp : 0;
  let climb = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].altitude - samples[i - 1].altitude;
    if (d > 0) climb += d;
  }
  return {
    duration,
    distance: samples.length ? samples[samples.length - 1].distance : 0,
    avgPower: mean(p),
    maxPower: p.length ? Math.max(...p) : 0,
    np,
    if: IF,
    tss: (duration * IF * IF * 100) / 3600,
    avgHr: hr.length ? mean(hr) : undefined,
    maxHr: hr.length ? Math.max(...hr) : undefined,
    avgCadence: cad.length ? mean(cad) : undefined,
    climb,
    kj: p.reduce((a, b) => a + b, 0) / 1000,
  };
}

export function lapStats(samples: Sample[], lap: Lap) {
  const s = samples.slice(lap.startIndex, lap.endIndex);
  const hr = s.map((x) => x.hr).filter((x): x is number => !!x);
  const cad = s.map((x) => x.cadence).filter((x): x is number => !!x && x > 0);
  return {
    duration: s.length,
    avgPower: mean(s.map((x) => x.power)),
    avgHr: hr.length ? mean(hr) : undefined,
    maxHr: hr.length ? Math.max(...hr) : undefined,
    avgCadence: cad.length ? mean(cad) : undefined,
  };
}
