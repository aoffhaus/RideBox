import { useRef, useState } from 'react';
import type { StoredWorkout } from '../storage/db';
import { deleteWorkout, saveWorkout, uid } from '../storage/db';
import { flatten, formatDuration, plannedStats } from '../workout/model';
import { parseWorkout, toMrc, toRideBoxJson, toZwo } from '../workout/parsers';
import { WorkoutChart } from './WorkoutChart';
import { downloadBlob } from '../export/fit';

interface Props {
  workouts: StoredWorkout[];
  ftp: number;
  onChange: () => void;
  onRide: (w: StoredWorkout) => void;
  onEdit: (w: StoredWorkout | null) => void;
}

export function Library({ workouts, ftp, onChange, onRide, onEdit }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState('');

  async function importTexts(items: { name: string; text: string }[]) {
    const ok: string[] = [];
    const bad: string[] = [];
    for (const it of items) {
      try {
        const w = parseWorkout(it.text, it.name);
        const source = /trainerroad/i.test(w.author ?? '') ? 'trainerroad' : 'import';
        await saveWorkout({ id: uid(), workout: w, source, createdAt: Date.now() });
        ok.push(w.name);
      } catch (e) {
        bad.push(`${it.name || 'pasted text'}: ${(e as Error).message}`);
      }
    }
    onChange();
    setMsg({ ok: !bad.length, text: [ok.length ? `Imported: ${ok.join(', ')}` : '', ...bad].filter(Boolean).join(' · ') });
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const items = await Promise.all([...files].map(async (f) => ({ name: f.name, text: await f.text() })));
    await importTexts(items);
  }

  const shown = workouts.filter((w) => w.workout.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div
        className={`import-box ${drag ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void onFiles(e.dataTransfer.files);
        }}
      >
        <div className="import-head">
          <h2>Add workouts</h2>
          <div className="row">
            <button className="primary" onClick={() => fileRef.current?.click()}>Import files…</button>
            <button onClick={() => onEdit(null)}>+ Build a workout</button>
          </div>
        </div>
        <p className="muted">
          Drop <code>.zwo</code>, <code>.erg</code>, <code>.mrc</code>, RideBox <code>.json</code>, or a TrainerRoad <code>.json</code> (from the bookmarklet in Settings) here. Or paste a workout Claude wrote for you:
        </p>
        <input ref={fileRef} type="file" multiple accept=".zwo,.erg,.mrc,.json,.txt" hidden onChange={(e) => void onFiles(e.target.files)} />
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={'Paste TrainerRoad JSON (from the bookmarklet), RideBox JSON, .zwo XML, or shorthand like:\n# Threshold 2x20\n10m 45-70%\n2x(20m @95%, 5m @50%)\n10m 60-40%'}
          rows={5}
        />
        <div className="row">
          <button disabled={!paste.trim()} onClick={() => importTexts([{ name: '', text: paste }]).then(() => setPaste(''))}>
            Add pasted workout
          </button>
          {msg && <span className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}
        </div>
      </div>

      <div className="lib-head">
        <h2>Library ({workouts.length})</h2>
        <input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="lib-grid">
        {shown.map((sw) => {
          const iv = flatten(sw.workout);
          const st = plannedStats(iv, ftp);
          return (
            <div key={sw.id} className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">{sw.workout.name}</div>
                  <div className="muted small">
                    {formatDuration(st.duration)} · TSS {Math.round(st.tss)} · IF {st.if.toFixed(2)} · {sw.source}
                  </div>
                </div>
                <button className="primary" onClick={() => onRide(sw)}>Ride ▶</button>
              </div>
              <WorkoutChart intervals={iv} ftp={ftp} height={60} compact />
              {sw.workout.description && <div className="muted small desc">{sw.workout.description}</div>}
              <div className="row small-buttons">
                <button onClick={() => onEdit(sw)}>Edit</button>
                <button onClick={() => downloadBlob(toRideBoxJson(sw.workout), `${sw.workout.name}.json`, 'application/json')}>JSON</button>
                <button onClick={() => downloadBlob(toZwo(sw.workout, ftp), `${sw.workout.name}.zwo`, 'application/xml')}>.zwo</button>
                <button onClick={() => downloadBlob(toMrc(sw.workout, ftp, iv), `${sw.workout.name}.mrc`, 'text/plain')}>.mrc</button>
                <button
                  className="danger-text"
                  onClick={async () => {
                    if (confirm(`Delete "${sw.workout.name}"?`)) {
                      await deleteWorkout(sw.id);
                      onChange();
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
