import { parseDuration, type Step, type Workout } from '../model';

/**
 * Shorthand workout text, one step per line or comma separated:
 *
 *   Sweet spot 3x12          <- optional first line "# Name" or "name: ..."
 *   10m 45-70%               <- ramp
 *   3x(12m @90% 90rpm, 4m @50%)
 *   5m @150w                 <- absolute watts
 *   5m free                  <- free ride (no ERG)
 *   10m 60-40%
 *
 * Repeats can also span lines:
 *   4x
 *     5m @110%
 *     5m @50%
 *   end
 */
export function parseText(src: string, fallbackName = 'Custom workout'): Workout {
  let name = fallbackName;
  const lines = src.replace(/\r/g, '').split('\n');
  const body: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    const nm = /^(?:#\s*|name\s*:\s*)(.+)$/i.exec(l);
    if (nm && !body.length) {
      name = nm[1].trim();
      continue;
    }
    if (l) body.push(l);
  }
  const tokens = tokenize(body.join('\n'));
  let i = 0;

  const parseList = (closer?: string): Step[] => {
    const out: Step[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (closer && t.toLowerCase() === closer) {
        i++;
        return out;
      }
      if (t === ',' || t === '\n') {
        i++;
        continue;
      }
      const rep = /^(\d+)x$/i.exec(t);
      if (rep) {
        i++;
        const count = Number(rep[1]);
        if (tokens[i] === '(') {
          i++;
          out.push({ type: 'repeat', count, steps: parseList(')') });
        } else if (tokens[i] === '\n' || tokens[i] === undefined) {
          i++;
          out.push({ type: 'repeat', count, steps: parseList('end') });
        } else {
          out.push({ type: 'repeat', count, steps: [parseStepText(tokens[i])] });
          i++;
        }
        continue;
      }
      out.push(parseStepText(t));
      i++;
    }
    if (closer && closer !== 'end') throw new Error(`Missing "${closer}"`);
    return out;
  };

  const steps = parseList();
  if (!steps.length) throw new Error('No steps found');
  return { name, steps };
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    const c = cur.trim();
    if (c) {
      // split leading "3x" from "3x(...)" / "3x 10m @..."
      const m = /^(\d+)\s*x\s*(.*)$/i.exec(c);
      if (m) {
        out.push(`${m[1]}x`);
        if (m[2]) out.push(m[2]);
      } else out.push(c);
    }
    cur = '';
  };
  for (const ch of s) {
    if (ch === '(' || ch === ')' || ch === ',' || ch === '\n') {
      flush();
      out.push(ch);
    } else cur += ch;
  }
  flush();
  return out;
}

export function parseStepText(t: string): Step {
  const s = t.trim();
  // duration = first token(s) up to the power spec
  const m = /^([\d.:]+\s*(?:h|hr|m|min|s|sec)?(?:\s*\d+\s*(?:m|min|s|sec))?)\s*(.*)$/i.exec(s);
  if (!m) throw new Error(`Can't read step "${t}"`);
  const duration = parseDuration(m[1].replace(/\s+/g, ''));
  let rest = m[2].trim();
  let cadence: number | undefined;
  const cad = /(\d+)\s*rpm/i.exec(rest);
  if (cad) {
    cadence = Number(cad[1]);
    rest = rest.replace(cad[0], '').trim();
  }
  let label: string | undefined;
  const q = /"([^"]+)"/.exec(rest);
  if (q) {
    label = q[1];
    rest = rest.replace(q[0], '').trim();
  }
  if (/^free/i.test(rest)) return { type: 'free', duration, label };
  rest = rest.replace(/^@\s*/, '').replace(/ftp/i, '').trim();
  const ramp = /^(\d+(?:\.\d+)?)\s*(%|w)?\s*(?:-|to|→)\s*(\d+(?:\.\d+)?)\s*(%|w)?$/i.exec(rest);
  if (ramp) {
    const watts = (ramp[2] ?? ramp[4] ?? '%').toLowerCase() === 'w';
    const a = Number(ramp[1]);
    const b = Number(ramp[3]);
    return watts
      ? { type: 'ramp', duration, from: a, to: b, unit: 'watts', cadence, label }
      : { type: 'ramp', duration, from: a / 100, to: b / 100, cadence, label };
  }
  const steady = /^(\d+(?:\.\d+)?)\s*(%|w)?$/i.exec(rest);
  if (steady) {
    const v = Number(steady[1]);
    return (steady[2] ?? '%').toLowerCase() === 'w'
      ? { type: 'steady', duration, power: v, unit: 'watts', cadence, label }
      : { type: 'steady', duration, power: v / 100, cadence, label };
  }
  throw new Error(`Can't read power in "${t}" (use e.g. "@90%", "200w", "50-75%" or "free")`);
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
function durationText(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  // the parser reads at most two units ("1h15m", "2m30s"); use h:mm:ss for all three
  if (h && m && r) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return [h && `${h}h`, m && `${m}m`, r && `${r}s`].filter(Boolean).join('') || '0s';
}
function stepText(s: Step): string {
  if (s.type === 'repeat') return `${s.count}x(${s.steps.map(stepText).join(', ')})`;
  const parts = [durationText(s.duration)];
  if (s.type === 'free') parts.push('free');
  else {
    const fmt = (v: number) => (s.unit === 'watts' ? `${Math.round(v)}w` : pct(v));
    parts.push(s.type === 'steady' ? `@${fmt(s.power)}` : `${fmt(s.from)}-${fmt(s.to)}`);
    if (s.cadence) parts.push(`${s.cadence}rpm`);
  }
  // the tokenizer splits on commas and parentheses, even inside quotes
  const label = s.label?.replace(/[(),"\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (label) parts.push(`"${label}"`);
  return parts.join(' ');
}

/** The inverse of parseText: a workout as shorthand, one step per line (cues are dropped). */
export function toText(w: Workout): string {
  return w.steps.map(stepText).join('\n');
}
