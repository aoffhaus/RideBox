import type { Step, TextCue, Workout } from '../model';

/**
 * .erg (absolute watts) and .mrc (% of FTP) files — the classic format used by
 * TrainerRoad, Golden Cheetah, PerfPRO etc.
 *
 * [COURSE HEADER]
 * VERSION = 2
 * UNITS = ENGLISH
 * DESCRIPTION = ...
 * FILE NAME = ...
 * FTP = 250             (optional)
 * MINUTES PERCENT       (or MINUTES WATTS)
 * [END COURSE HEADER]
 * [COURSE DATA]
 * 0.00	50
 * 10.00	50
 * 10.00	95
 * ...
 * [END COURSE DATA]
 * [COURSE TEXT]          (optional: seconds <tab> text <tab> duration)
 */
export function parseErgMrc(src: string, fileName = ''): Workout {
  const text = src.replace(/\r/g, '');
  const section = (name: string) => {
    const re = new RegExp(`\\[${name}\\]([\\s\\S]*?)\\[END ${name}\\]`, 'i');
    return re.exec(text)?.[1] ?? '';
  };
  const header = section('COURSE HEADER');
  const data = section('COURSE DATA');
  if (!data.trim()) throw new Error('No [COURSE DATA] section found');

  const hv = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'im').exec(header)?.[1]?.trim();
  const isPercent = /MINUTES\s+PERCENT/i.test(header) || (!/MINUTES\s+WATTS/i.test(header) && /\.mrc$/i.test(fileName));
  const name = hv('FILE NAME') || hv('DESCRIPTION') || fileName.replace(/\.(erg|mrc)$/i, '') || 'Imported workout';
  const description = hv('DESCRIPTION');

  const pts = data
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([min, v]) => ({ t: min * 60, v }));

  // Course text cues (absolute seconds) — assigned to the step they fall in.
  const cueLines = section('COURSE TEXT')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && Number.isFinite(Number(p[0])))
    .map((p) => ({ at: Number(p[0]), message: p[1].trim(), duration: p[2] ? Number(p[2]) : undefined }));

  const steps: Step[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dur = b.t - a.t;
    if (dur <= 0.5) continue;
    const conv = (v: number) => (isPercent ? v / 100 : v);
    const unit = isPercent ? 'ftp' : 'watts';
    const cues: TextCue[] = cueLines
      .filter((c) => c.at >= a.t && c.at < b.t)
      .map((c) => ({ offset: c.at - a.t, message: c.message, duration: c.duration }));
    if (Math.abs(a.v - b.v) < 0.5) {
      steps.push({ type: 'steady', duration: dur, power: conv(a.v), unit, cues });
    } else {
      steps.push({ type: 'ramp', duration: dur, from: conv(a.v), to: conv(b.v), unit, cues });
    }
  }
  if (!steps.length) throw new Error('The workout file has no intervals');
  return { name, description, steps: mergeSteady(steps) };
}

/** Merge consecutive steady steps with identical power (common in second-by-second exports). */
export function mergeSteady(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === 'steady' &&
      s.type === 'steady' &&
      prev.unit === s.unit &&
      Math.abs(prev.power - s.power) < 1e-6 &&
      !(s.cues && s.cues.length)
    ) {
      prev.duration += s.duration;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function toMrc(w: Workout, ftp: number, flat: { start: number; duration: number; powerStart: number; powerEnd: number; unit: string }[]): string {
  const rows: string[] = [];
  for (const iv of flat) {
    const p = (v: number) => (iv.unit === 'watts' ? (v / ftp) * 100 : v * 100).toFixed(1);
    rows.push(`${(iv.start / 60).toFixed(2)}\t${p(iv.powerStart)}`);
    rows.push(`${((iv.start + iv.duration) / 60).toFixed(2)}\t${p(iv.powerEnd)}`);
  }
  return `[COURSE HEADER]
VERSION = 2
UNITS = ENGLISH
DESCRIPTION = ${w.description ?? ''}
FILE NAME = ${w.name}
MINUTES PERCENT
[END COURSE HEADER]
[COURSE DATA]
${rows.join('\n')}
[END COURSE DATA]
`;
}
