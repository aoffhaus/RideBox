import { LEVEL_ZONES, ZONE_NAMES, difficultyLabel, type LevelEvent, type LevelZone, type Levels, type WorkoutRating } from '../training/levels';

/** Zone colors, matching the power-zone colors used on workout charts. */
export const LEVEL_COLORS: Record<LevelZone, string> = {
  endurance: '#2f80ed',
  tempo: '#27ae60',
  sweetspot: '#d4ac2b',
  threshold: '#f2c94c',
  vo2max: '#f2994a',
  anaerobic: '#eb5757',
};

/** "Threshold 5.8 · Challenging" */
export function LevelBadge({ rating, levels, compact }: { rating: WorkoutRating; levels: Levels; compact?: boolean }) {
  const d = difficultyLabel(rating, levels);
  if (rating.zone === 'recovery' || rating.zone === 'test') return <span className={`diff ${d.cls}`}>{d.label}</span>;
  return (
    <span className={`diff ${d.cls}`} title={`${ZONE_NAMES[rating.zone]} workout level ${rating.level} · your level ${levels[rating.zone] ?? 'not rated yet'}`}>
      {compact ? '' : `${ZONE_NAMES[rating.zone]} `}
      {rating.level.toFixed(1)} · {d.label}
    </span>
  );
}

export function LevelsCard({ levels, history }: { levels: Levels; history: LevelEvent[] }) {
  const recent = history.filter((h) => h.after !== h.before).slice(-6).reverse();
  const fmt = (v: number | null) => (v == null ? '–' : v.toFixed(1));
  return (
    <div className="card">
      <div className="card-title">Progression levels</div>
      <p className="muted small">
        How hard a workout you can handle in each zone (1–10). Your first workout in a zone sets its level; completing workouts at or above it raises
        it, and zones you skip for a month slowly slip. The coach uses these to pick workouts that are hard enough, but not too hard.
      </p>
      <div className="levels">
        {LEVEL_ZONES.map((z) => (
          <div className="level-row" key={z}>
            <span className="level-name">{ZONE_NAMES[z]}</span>
            <span className="level-track">
              <span className="level-fill" style={{ width: `${((levels[z] ?? 0) / 10) * 100}%`, background: LEVEL_COLORS[z] }} />
            </span>
            <span className="level-val">{fmt(levels[z])}</span>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="small" style={{ marginTop: 8 }}>
          {recent.map((h, i) => (
            <div key={i} className="muted">
              {h.date} · {h.name}: {ZONE_NAMES[h.zone]} {fmt(h.before)} → <b style={{ color: 'var(--text)' }}>{h.after.toFixed(1)}</b>
              {h.outcome === 'fail' ? ' (didn’t finish)' : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
