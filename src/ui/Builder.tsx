import { useEffect, useMemo, useState } from 'react';
import type { StoredWorkout } from '../storage/db';
import { saveWorkout, uid } from '../storage/db';
import { flatten, formatDuration, parseDuration, plannedStats, type Step, type Workout } from '../workout/model';
import { parseText } from '../workout/parsers';
import { WorkoutChart } from './WorkoutChart';

interface Props {
  initial: StoredWorkout | null;
  ftp: number;
  onDone: () => void;
}

type Row = Exclude<Step, { type: 'repeat' }>;
type Item = Row | { type: 'repeat'; count: number; steps: Row[] };

/** Convert any workout into the builder's shape (one level of repeats). */
function toItems(steps: Step[]): Item[] {
  const flatRows = (ss: Step[]): Row[] => ss.flatMap((s) => (s.type === 'repeat' ? Array.from({ length: s.count }, () => flatRows(s.steps)).flat() : [s]));
  return steps.map((s) => (s.type === 'repeat' ? { type: 'repeat', count: s.count, steps: flatRows(s.steps) } : s));
}

const newRow = (): Row => ({ type: 'steady', duration: 300, power: 0.75 });

function durStr(sec: number) {
  return sec % 60 === 0 ? `${sec / 60}m` : sec > 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}

function RowEditor({ row, ftp, onChange, onDelete, onMove }: { row: Row; ftp: number; onChange: (r: Row) => void; onDelete: () => void; onMove: (d: -1 | 1) => void }) {
  const [dur, setDur] = useState(durStr(row.duration));
  useEffect(() => {
    // keep the text box in sync when the row changes from outside (move, apply text)
    let same = false;
    try {
      same = parseDuration(dur) === row.duration;
    } catch {
      /* ignore */
    }
    if (!same) setDur(durStr(row.duration));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.duration]);
  const pct = (v: number, unit?: string) => (unit === 'watts' ? v : Math.round(v * 100));
  const fromPct = (n: number, unit?: string) => (unit === 'watts' ? n : n / 100);
  const unit = row.type === 'free' ? 'ftp' : row.unit ?? 'ftp';
  return (
    <div className="b-row">
      <select
        value={row.type}
        onChange={(e) => {
          const t = e.target.value as Row['type'];
          if (t === 'steady') onChange({ type: 'steady', duration: row.duration, power: row.type === 'ramp' ? row.to : row.type === 'steady' ? row.power : 0.6, unit, label: row.label });
          if (t === 'ramp') onChange({ type: 'ramp', duration: row.duration, from: row.type === 'steady' ? row.power : 0.5, to: row.type === 'steady' ? row.power + 0.2 : 0.75, unit, label: row.label });
          if (t === 'free') onChange({ type: 'free', duration: row.duration, label: row.label });
        }}
      >
        <option value="steady">Steady</option>
        <option value="ramp">Ramp</option>
        <option value="free">Free ride</option>
      </select>
      <input
        className="w-dur"
        value={dur}
        title="Duration (e.g. 5m, 30s, 1m30s, 8:00)"
        onChange={(e) => {
          setDur(e.target.value);
          try {
            const d = parseDuration(e.target.value);
            if (d > 0) onChange({ ...row, duration: d });
          } catch {
            /* keep typing */
          }
        }}
      />
      {row.type === 'steady' && (
        <input className="w-num" type="number" value={pct(row.power, unit)} onChange={(e) => onChange({ ...row, power: fromPct(Number(e.target.value), unit) })} />
      )}
      {row.type === 'ramp' && (
        <>
          <input className="w-num" type="number" value={pct(row.from, unit)} onChange={(e) => onChange({ ...row, from: fromPct(Number(e.target.value), unit) })} />
          <span>→</span>
          <input className="w-num" type="number" value={pct(row.to, unit)} onChange={(e) => onChange({ ...row, to: fromPct(Number(e.target.value), unit) })} />
        </>
      )}
      {row.type !== 'free' && (
        <select
          value={unit}
          onChange={(e) => {
            const u = e.target.value as 'ftp' | 'watts';
            const conv = (v: number) => (u === 'watts' ? Math.round(v * ftp) : Math.round((v / ftp) * 100) / 100);
            if (row.type === 'steady') onChange({ ...row, unit: u, power: conv(row.power) });
            else onChange({ ...row, unit: u, from: conv(row.from), to: conv(row.to) });
          }}
        >
          <option value="ftp">% FTP</option>
          <option value="watts">W</option>
        </select>
      )}
      {row.type !== 'free' && (
        <input className="w-num" type="number" placeholder="rpm" value={row.cadence ?? ''} onChange={(e) => onChange({ ...row, cadence: e.target.value ? Number(e.target.value) : undefined })} />
      )}
      <input className="w-label" placeholder="label / cue" value={row.label ?? ''} onChange={(e) => onChange({ ...row, label: e.target.value || undefined })} />
      <button className="icon" onClick={() => onMove(-1)} title="Move up">↑</button>
      <button className="icon" onClick={() => onMove(1)} title="Move down">↓</button>
      <button className="icon danger-text" onClick={onDelete} title="Delete">✕</button>
    </div>
  );
}

export function Builder({ initial, ftp, onDone }: Props) {
  const [name, setName] = useState(initial?.workout.name ?? 'My workout');
  const [description, setDescription] = useState(initial?.workout.description ?? '');
  const [items, setItems] = useState<Item[]>(() =>
    initial ? toItems(initial.workout.steps) : [{ type: 'ramp', duration: 600, from: 0.45, to: 0.7 }, { type: 'repeat', count: 3, steps: [{ type: 'steady', duration: 600, power: 0.9 }, { type: 'steady', duration: 300, power: 0.5 }] }, { type: 'ramp', duration: 600, from: 0.6, to: 0.4 }],
  );
  const [mode, setMode] = useState<'visual' | 'text'>('visual');
  const [text, setText] = useState('');
  const [textErr, setTextErr] = useState('');

  const workout: Workout = useMemo(() => ({ name, description: description || undefined, author: initial?.workout.author, steps: items as Step[] }), [name, description, items, initial]);
  const intervals = useMemo(() => flatten(workout), [workout]);
  const stats = plannedStats(intervals, ftp);

  const move = <T,>(arr: T[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return arr;
    const c = [...arr];
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  };

  async function save() {
    await saveWorkout({
      id: initial?.source === 'builtin' ? uid() : initial?.id ?? uid(),
      workout,
      source: initial && initial.source !== 'builtin' ? initial.source : 'builder',
      createdAt: initial?.createdAt ?? Date.now(),
    });
    onDone();
  }

  return (
    <div className="page">
      <div className="row space">
        <h2>{initial ? 'Edit workout' : 'Build a workout'}</h2>
        <div className="row">
          <button onClick={onDone}>Cancel</button>
          <button className="primary" onClick={save} disabled={!intervals.length}>Save</button>
        </div>
      </div>
      <div className="row">
        <input className="w-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <input className="grow" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" />
      </div>
      <div className="builder-preview">
        <WorkoutChart intervals={intervals} ftp={ftp} height={110} />
        <div className="muted small">
          {formatDuration(stats.duration)} · TSS {Math.round(stats.tss)} · IF {stats.if.toFixed(2)} · NP {Math.round(stats.np)} W at FTP {ftp}
        </div>
      </div>
      <div className="tabs">
        <button className={mode === 'visual' ? 'active' : ''} onClick={() => setMode('visual')}>Blocks</button>
        <button
          className={mode === 'text' ? 'active' : ''}
          onClick={() => {
            setMode('text');
            setText('');
          }}
        >
          Text shorthand
        </button>
      </div>

      {mode === 'visual' ? (
        <div className="builder">
          <div className="muted small">Power is % of FTP unless set to W. Durations: 5m, 30s, 1m30s.</div>
          {items.map((it, i) =>
            it.type === 'repeat' ? (
              <div key={i} className="b-repeat">
                <div className="row">
                  <b>Repeat</b>
                  <input className="w-num" type="number" min={1} value={it.count} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...it, count: Math.max(1, Number(e.target.value)) } : x)))} />
                  <span>times</span>
                  <button className="icon" onClick={() => setItems(move(items, i, -1))}>↑</button>
                  <button className="icon" onClick={() => setItems(move(items, i, 1))}>↓</button>
                  <button className="icon danger-text" onClick={() => setItems(items.filter((_, k) => k !== i))}>✕</button>
                </div>
                {it.steps.map((r, j) => (
                  <RowEditor
                    key={`${i}-${j}-${it.steps.length}`}
                    row={r}
                    ftp={ftp}
                    onChange={(nr) => setItems(items.map((x, k) => (k === i ? { ...it, steps: it.steps.map((y, m) => (m === j ? nr : y)) } : x)))}
                    onDelete={() => setItems(items.map((x, k) => (k === i ? { ...it, steps: it.steps.filter((_, m) => m !== j) } : x)))}
                    onMove={(d) => setItems(items.map((x, k) => (k === i ? { ...it, steps: move(it.steps, j, d) } : x)))}
                  />
                ))}
                <button className="small-btn" onClick={() => setItems(items.map((x, k) => (k === i ? { ...it, steps: [...it.steps, newRow()] } : x)))}>+ step in repeat</button>
              </div>
            ) : (
              <RowEditor
                key={`${i}-${items.length}`}
                row={it}
                ftp={ftp}
                onChange={(nr) => setItems(items.map((x, k) => (k === i ? nr : x)))}
                onDelete={() => setItems(items.filter((_, k) => k !== i))}
                onMove={(d) => setItems(move(items, i, d))}
              />
            ),
          )}
          <div className="row">
            <button onClick={() => setItems([...items, newRow()])}>+ Step</button>
            <button onClick={() => setItems([...items, { type: 'repeat', count: 4, steps: [{ type: 'steady', duration: 180, power: 1.1 }, { type: 'steady', duration: 180, power: 0.5 }] }])}>+ Repeat block</button>
          </div>
        </div>
      ) : (
        <div className="builder">
          <p className="muted small">
            One step per line. <code>10m 45-70%</code> ramp · <code>5m @90% 95rpm "Label"</code> · <code>5m @200w</code> · <code>5m free</code> · <code>3x(8m @105%, 4m @50%)</code>. Applying replaces the blocks above.
          </p>
          <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'10m 45-70%\n3x(12m @90%, 4m @50%)\n8m 60-40%'} />
          <div className="row">
            <button
              onClick={() => {
                try {
                  const w = parseText(text, name);
                  setItems(toItems(w.steps));
                  if (w.name !== name && text.trim().startsWith('#')) setName(w.name);
                  setTextErr('');
                  setMode('visual');
                } catch (e) {
                  setTextErr((e as Error).message);
                }
              }}
            >
              Apply
            </button>
            {textErr && <span className="err">{textErr}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
