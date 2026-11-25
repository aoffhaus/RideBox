import { useRef, useState } from 'react';
import type { StoredWorkout } from '../storage/db';
import { deleteWorkout, saveWorkout, uid } from '../storage/db';
import { flatten, formatDuration, plannedStats } from '../workout/model';
import { parseWorkout, toMrc, toRideBoxJson, toZwo } from '../workout/parsers';
import { WorkoutChart } from './WorkoutChart';
import { downloadBlob } from '../export/fit';
import { WorkoutView } from './WorkoutView';
import { LevelBadge } from './Levels';
import { LEVEL_ZONES, ZONE_NAMES, rateWorkout, type Levels } from '../training/levels';

/** [label, min, max) buckets for the library filters */
type Bucket = readonly [label: string, min: number, max: number];
const DURATIONS: Bucket[] = [['Under 30 min', 0, 30], ['30–45 min', 30, 45], ['45–75 min', 45, 75], ['75–120 min', 75, 120], ['2 h +', 120, Infinity]];
const TSS_BUCKETS: Bucket[] = [['Under 40', 0, 40], ['40–70', 40, 70], ['70–100', 70, 100], ['100–150', 100, 150], ['150 +', 150, Infinity]];
const IF_BUCKETS: Bucket[] = [['Under 0.65', 0, 0.65], ['0.65–0.80', 0.65, 0.8], ['0.80–0.90', 0.8, 0.9], ['0.90–1.00', 0.9, 1], ['1.00 +', 1, Infinity]];
const LEVEL_BUCKETS: Bucket[] = [['1–3', 1, 4], ['4–5', 4, 6], ['6–7', 6, 8], ['8–10', 8, 11]];
const NO_FILTERS = { zone: 'all', dur: '', tss: '', ifb: '', level: '' };

function BucketSelect({ label, value, onChange, buckets }: { label: string; value: string; onChange: (v: string) => void; buckets: Bucket[] }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {buckets.map((b, i) => <option key={b[0]} value={i}>{b[0]}</option>)}
      </select>
    </label>
  );
}

interface Props {
  workouts: StoredWorkout[];
  ftp: number;
  /** the rider's progression levels, to show each workout's level against them */
  levels: Levels;
  onChange: () => void;
  onRide: (w: StoredWorkout) => void;
  onEdit: (w: StoredWorkout | null) => void;
}

export function Library({ workouts, ftp, levels, onChange, onRide, onEdit }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [drag, setDrag] = useState(false);
  const [filter, setFilter] = useState('');
  const [f, setF] = useState(NO_FILTERS);
  const [viewing, setViewing] = useState<StoredWorkout | null>(null);

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

  const inBucket = (b: Bucket[], idx: string, v: number) => idx === '' || (v >= b[Number(idx)][1] && v < b[Number(idx)][2]);
  const filtering = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);
  const shown = workouts.filter((w) => {
    if (!w.workout.name.toLowerCase().includes(filter.toLowerCase())) return false;
    if (!filtering) return true;
    const st = plannedStats(flatten(w.workout), ftp);
    const r = rateWorkout(w.workout, ftp);
    if (f.zone !== 'all' && r.zone !== f.zone) return false;
    if (f.level !== '' && !(r.zone !== 'recovery' && r.zone !== 'test' && inBucket(LEVEL_BUCKETS, f.level, r.level))) return false;
    return inBucket(DURATIONS, f.dur, st.duration / 60) && inBucket(TSS_BUCKETS, f.tss, st.tss) && inBucket(IF_BUCKETS, f.ifb, st.if);
  });

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
        <h2>Library ({shown.length === workouts.length ? workouts.length : `${shown.length} of ${workouts.length}`})</h2>
        <input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="lib-filters">
        <label className="field">
          <span>Type / zone</span>
          <select value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>
            <option value="all">All</option>
            {LEVEL_ZONES.map((z) => <option key={z} value={z}>{ZONE_NAMES[z]}</option>)}
            <option value="recovery">{ZONE_NAMES.recovery}</option>
            <option value="test">{ZONE_NAMES.test}</option>
          </select>
        </label>
        <BucketSelect label="Duration" value={f.dur} onChange={(v) => setF({ ...f, dur: v })} buckets={DURATIONS} />
        <BucketSelect label="TSS" value={f.tss} onChange={(v) => setF({ ...f, tss: v })} buckets={TSS_BUCKETS} />
        <BucketSelect label="IF" value={f.ifb} onChange={(v) => setF({ ...f, ifb: v })} buckets={IF_BUCKETS} />
        <BucketSelect label="Level" value={f.level} onChange={(v) => setF({ ...f, level: v })} buckets={LEVEL_BUCKETS} />
        {filtering && <button className="ghost" onClick={() => setF(NO_FILTERS)}>Clear filters</button>}
      </div>
      {!shown.length && <p className="muted">No workouts match these filters.</p>}
      <div className="lib-grid">
        {shown.map((sw) => {
          const iv = flatten(sw.workout);
          const st = plannedStats(iv, ftp);
          return (
            <div
              key={sw.id}
              className="card clickable"
              title="Click to view workout"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('button')) setViewing(sw);
              }}
            >
              <div className="card-head">
                <div>
                  <div className="card-title">{sw.workout.name}</div>
                  <div className="lib-level small">
                    <LevelBadge rating={rateWorkout(sw.workout, ftp)} levels={levels} />
                  </div>
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

      {viewing && (
        <WorkoutView
          workout={viewing}
          ftp={ftp}
          onClose={() => setViewing(null)}
          onRide={(w) => {
            setViewing(null);
            onRide(w);
          }}
          onEdit={(w) => {
            setViewing(null);
            onEdit(w);
          }}
        />
      )}
    </div>
  );
}
