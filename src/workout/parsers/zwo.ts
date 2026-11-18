import type { Step, TextCue, Workout } from '../model';

// Minimal XML reader (no DOM needed, so it also runs in tests / workers).
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const src = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      top.text += decodeEntities(m[5]);
      continue;
    }
    const [, closing, tag, attrStr, selfClose] = m;
    if (closing) {
      // pop to matching tag (tolerant of sloppy nesting)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag.toLowerCase() === tag.toLowerCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(attrStr))) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? '');
    const node: XmlNode = { tag, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function find(node: XmlNode, tag: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.tag.toLowerCase() === tag) return c;
    const f = find(c, tag);
    if (f) return f;
  }
  return undefined;
}

const num = (v: string | undefined, d = 0) => {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

function cues(node: XmlNode): TextCue[] {
  return node.children
    .filter((c) => c.tag.toLowerCase() === 'textevent')
    .map((c) => ({
      offset: num(c.attrs.timeoffset),
      message: c.attrs.message ?? c.text.trim(),
      duration: c.attrs.duration ? num(c.attrs.duration) : undefined,
    }))
    .filter((c) => c.message);
}

/** Zwift workout (.zwo). Powers in ZWO are already fractions of FTP. */
export function parseZwo(xml: string): Workout {
  const doc = parseXml(xml);
  const file = find(doc, 'workout_file') ?? doc;
  const name = find(file, 'name')?.text.trim() || 'Imported workout';
  const description = find(file, 'description')?.text.trim() || undefined;
  const author = find(file, 'author')?.text.trim() || undefined;
  const w = find(file, 'workout');
  if (!w) throw new Error('No <workout> element found in .zwo file');

  const steps: Step[] = [];
  for (const el of w.children) {
    const t = el.tag.toLowerCase();
    const A = el.attrs;
    const duration = num(A.duration);
    const cadence = A.cadence ? num(A.cadence) : undefined;
    const c = cues(el);
    switch (t) {
      case 'warmup':
      case 'cooldown':
      case 'ramp': {
        const lo = num(A.powerlow, num(A.power, 0.5));
        const hi = num(A.powerhigh, lo);
        steps.push({
          type: 'ramp',
          duration,
          from: lo,
          to: hi,
          cadence,
          cues: c,
          label: t === 'warmup' ? 'Warm up' : t === 'cooldown' ? 'Cool down' : undefined,
        });
        break;
      }
      case 'steadystate':
        steps.push({ type: 'steady', duration, power: num(A.power, num(A.powerlow, 0.5)), cadence, cues: c });
        break;
      case 'intervalst': {
        const repeat = Math.max(1, Math.round(num(A.repeat, 1)));
        const onD = num(A.onduration);
        const offD = num(A.offduration);
        const onP = num(A.onpower, num(A.powerhigh, 1));
        const offP = num(A.offpower, num(A.powerlow, 0.5));
        steps.push({
          type: 'repeat',
          count: repeat,
          steps: [
            { type: 'steady', duration: onD, power: onP, cadence, label: 'On' },
            {
              type: 'steady',
              duration: offD,
              power: offP,
              cadence: A.cadenceresting ? num(A.cadenceresting) : undefined,
              label: 'Off',
            },
          ],
        });
        break;
      }
      case 'freeride':
        steps.push({ type: 'free', duration, cues: c, label: 'Free ride' });
        break;
      case 'maxeffort':
        steps.push({ type: 'steady', duration, power: 1.5, label: 'Max effort', cues: c });
        break;
      default:
        // unknown element: ignore
        break;
    }
  }
  if (!steps.length) throw new Error('The .zwo workout has no intervals');
  return { name, description, author, steps };
}

// ---------- export ----------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Export a workout as .zwo (watts steps are converted with the given FTP). */
export function toZwo(w: Workout, ftp: number): string {
  const f = (v: number, unit?: string) => (unit === 'watts' ? v / ftp : v).toFixed(3);
  const lines: string[] = [];
  const cueXml = (cs?: TextCue[]) =>
    (cs ?? []).map((c) => `\n      <textevent timeoffset="${c.offset}" message="${esc(c.message)}"/>`).join('');
  const walk = (steps: Step[], indent: string) => {
    for (const s of steps) {
      if (s.type === 'repeat') {
        for (let i = 0; i < s.count; i++) walk(s.steps, indent);
      } else if (s.type === 'steady') {
        const cad = s.cadence ? ` Cadence="${s.cadence}"` : '';
        const c = cueXml(s.cues);
        lines.push(`${indent}<SteadyState Duration="${Math.round(s.duration)}" Power="${f(s.power, s.unit)}"${cad}${c ? `>${c}\n${indent}</SteadyState>` : '/>'}`);
      } else if (s.type === 'ramp') {
        const c = cueXml(s.cues);
        lines.push(`${indent}<Ramp Duration="${Math.round(s.duration)}" PowerLow="${f(s.from, s.unit)}" PowerHigh="${f(s.to, s.unit)}"${c ? `>${c}\n${indent}</Ramp>` : '/>'}`);
      } else {
        lines.push(`${indent}<FreeRide Duration="${Math.round(s.duration)}"/>`);
      }
    }
  };
  walk(w.steps, '    ');
  return `<workout_file>
  <author>${esc(w.author ?? 'RideBox')}</author>
  <name>${esc(w.name)}</name>
  <description>${esc(w.description ?? '')}</description>
  <sportType>bike</sportType>
  <workout>
${lines.join('\n')}
  </workout>
</workout_file>
`;
}
