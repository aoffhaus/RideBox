import { parseDuration, type Step, type TextCue, type Workout } from '../model';

/**
 * RideBox JSON workout format (friendly for hand-writing and for Claude):
 *
 * {
 *   "name": "Sweet Spot 3x12",
 *   "description": "optional",
 *   "steps": [
 *     { "type": "ramp",   "duration": "10m", "from": 45, "to": 70 },        // % of FTP
 *     { "type": "repeat", "count": 3, "steps": [
 *         { "type": "steady", "duration": "12m", "power": 90, "cadence": 90,
 *           "cues": [{ "at": "0s", "text": "Settle in" }] },
 *         { "type": "steady", "duration": "4m",  "power": 50 }
 *     ]},
 *     { "type": "steady", "duration": 300, "watts": 150 },                   // absolute watts
 *     { "type": "free",   "duration": "5m" }                                 // no ERG target
 *   ]
 * }
 *
 * Durations: seconds (number) or strings like "10m", "30s", "1h15m", "8:00".
 * Power: "power" (% FTP) or "watts". Ramps: "from"/"to" (% FTP) or "fromWatts"/"toWatts".
 */

type Json = any;

function parseCues(c: Json): TextCue[] | undefined {
  if (!Array.isArray(c)) return undefined;
  return c
    .map((x: Json) => ({
      offset: parseDuration(x.at ?? x.offset ?? 0),
      message: String(x.text ?? x.message ?? ''),
      duration: x.duration !== undefined ? parseDuration(x.duration) : undefined,
    }))
    .filter((x) => x.message);
}

function parseStep(s: Json, path: string): Step {
  const type = String(s.type ?? (s.steps ? 'repeat' : s.from !== undefined || s.fromWatts !== undefined ? 'ramp' : 'steady')).toLowerCase();
  const label = s.label ?? s.name;
  if (type === 'repeat' || type === 'repeats' || type === 'intervals') {
    if (!Array.isArray(s.steps)) throw new Error(`${path}: repeat needs "steps"`);
    return {
      type: 'repeat',
      count: Math.max(1, Math.round(Number(s.count ?? s.repeat ?? s.times ?? 1))),
      steps: s.steps.map((x: Json, i: number) => parseStep(x, `${path}.steps[${i}]`)),
    };
  }
  if (s.duration === undefined) throw new Error(`${path}: missing "duration"`);
  const duration = parseDuration(s.duration);
  const cadence = s.cadence !== undefined ? Number(s.cadence) : undefined;
  const cues = parseCues(s.cues);
  if (type === 'free' || type === 'freeride') return { type: 'free', duration, label, cues };
  if (type === 'ramp' || type === 'warmup' || type === 'cooldown') {
    if (s.fromWatts !== undefined) {
      return { type: 'ramp', duration, from: Number(s.fromWatts), to: Number(s.toWatts ?? s.fromWatts), unit: 'watts', cadence, label, cues };
    }
    if (s.from === undefined) throw new Error(`${path}: ramp needs "from" and "to"`);
    return { type: 'ramp', duration, from: Number(s.from) / 100, to: Number(s.to ?? s.from) / 100, cadence, label, cues };
  }
  if (s.watts !== undefined) return { type: 'steady', duration, power: Number(s.watts), unit: 'watts', cadence, label, cues };
  if (s.power === undefined) throw new Error(`${path}: steady step needs "power" (% FTP) or "watts"`);
  return { type: 'steady', duration, power: Number(s.power) / 100, cadence, label, cues };
}

export function parseRideBoxJson(src: string | Json): Workout {
  const j = typeof src === 'string' ? JSON.parse(src) : src;
  const obj = Array.isArray(j) ? { name: 'Imported workout', steps: j } : j;
  if (!Array.isArray(obj.steps)) throw new Error('JSON workout needs a "steps" array');
  return {
    name: String(obj.name ?? 'Imported workout'),
    description: obj.description ? String(obj.description) : undefined,
    author: obj.author ? String(obj.author) : undefined,
    steps: obj.steps.map((s: Json, i: number) => parseStep(s, `steps[${i}]`)),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function toRideBoxJson(w: Workout): string {
  const conv = (s: Step): Json => {
    switch (s.type) {
      case 'repeat':
        return { type: 'repeat', count: s.count, steps: s.steps.map(conv) };
      case 'free':
        return { type: 'free', duration: s.duration, ...(s.label ? { label: s.label } : {}) };
      case 'steady':
        return {
          type: 'steady',
          duration: s.duration,
          ...(s.unit === 'watts' ? { watts: s.power } : { power: r1(s.power * 100) }),
          ...(s.cadence ? { cadence: s.cadence } : {}),
          ...(s.label ? { label: s.label } : {}),
          ...(s.cues?.length ? { cues: s.cues.map((c) => ({ at: c.offset, text: c.message })) } : {}),
        };
      case 'ramp':
        return {
          type: 'ramp',
          duration: s.duration,
          ...(s.unit === 'watts' ? { fromWatts: s.from, toWatts: s.to } : { from: r1(s.from * 100), to: r1(s.to * 100) }),
          ...(s.cadence ? { cadence: s.cadence } : {}),
          ...(s.label ? { label: s.label } : {}),
        };
    }
  };
  return JSON.stringify({ name: w.name, description: w.description, steps: w.steps.map(conv) }, null, 2);
}
