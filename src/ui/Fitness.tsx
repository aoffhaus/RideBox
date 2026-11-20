import { useMemo, useState } from 'react';
import type { RideRecord } from '../app/recorder';
import type { Settings } from '../storage/db';
import { importStravaActivities } from '../strava/activities';
import { canReadActivities, type StravaConfig } from '../strava/strava';
import { addDays, estimateFtp, fitnessSeries, formLabel, loadEntries, plannedLoad, today, weeklyTotals } from '../training/load';
import type { PlannedWorkout, StravaActivity } from '../training/model';
import { formatDuration } from '../workout/model';
import { FitnessChart, SERIES, WeeklyBars } from './FitnessChart';

const RANGES = [
  { id: '6w', label: '6 weeks', days: 42 },
  { id: '3m', label: '3 months', days: 91 },
  { id: '6m', label: '6 months', days: 182 },
  { id: '1y', label: '1 year', days: 365 },
] as const;

export function Fitness({ rides, acts, calendar, settings, strava, onSettingsChange, onImported, children }: {
  rides: RideRecord[];
  acts: StravaActivity[];
  calendar: PlannedWorkout[];
  settings: Settings;
  strava: StravaConfig;
  onSettingsChange: (s: Settings) => void;
  onImported: () => void;
  /** extra sections (progression levels) */
  children?: React.ReactNode;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('3m');
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState('');
  const [showTable, setShowTable] = useState(false);
  const days = RANGES.find((r) => r.id === range)!.days;
  const t = today();

  const entries = useMemo(() => loadEntries(rides, acts, settings.ftp, settings.maxHr), [rides, acts, settings.ftp, settings.maxHr]);
  const planned = useMemo(() => plannedLoad(calendar, settings.ftp), [calendar, settings.ftp]);
  const series = useMemo(() => {
    // warm the model up on a year of history before the visible window
    const all = fitnessSeries(entries, planned, addDays(t, -days - 365), addDays(t, 28), t);
    return all.slice(all.length - (days + 1 + 28));
  }, [entries, planned, days, t]);
  const weeks = useMemo(() => weeklyTotals(entries, addDays(t, -days), t), [entries, days, t]);
  const est = useMemo(() => estimateFtp(rides), [rides]);
  const now = series.find((d) => d.date === t) ?? series[series.length - 1];
  const recent = entries.filter((e) => e.date >= addDays(t, -13)).reverse();

  async function runImport() {
    setImporting(true);
    setMsg('');
    try {
      const n = await importStravaActivities();
      setMsg(n ? `Imported ${n} Strava ${n === 1 ? 'activity' : 'activities'}.` : 'No new Strava activities.');
      onImported();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="page">
      <div className="row space">
        <h2>Fitness</h2>
        <div className="row">
          {canReadActivities(strava) ? (
            <button onClick={runImport} disabled={importing}>
              {importing ? 'Importing…' : 'Import from Strava'}
            </button>
          ) : (
            <span className="muted small">Connect Strava (Settings) to count outdoor rides.</span>
          )}
        </div>
      </div>
      {msg && <div className="muted small">{msg}</div>}

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">
            <i className="swatch" style={{ background: SERIES.ctl }} /> Fitness (CTL)
          </div>
          <div className="tile-value">{Math.round(now?.ctl ?? 0)}</div>
          <div className="muted small">42-day training load</div>
        </div>
        <div className="tile">
          <div className="tile-label">
            <i className="swatch" style={{ background: SERIES.atl }} /> Fatigue (ATL)
          </div>
          <div className="tile-value">{Math.round(now?.atl ?? 0)}</div>
          <div className="muted small">7-day training load</div>
        </div>
        <div className="tile">
          <div className="tile-label">
            <i className="swatch" style={{ background: SERIES.tsb }} /> Form (TSB)
          </div>
          <div className="tile-value">{Math.round(now?.tsb ?? 0)}</div>
          <div className="muted small">{formLabel(now?.tsb ?? 0)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">FTP</div>
          <div className="tile-value">{settings.ftp} W</div>
          {est ? (
            <div className="muted small">
              Estimate {est.ftp} W (95% of {est.best20} W for 20 min, {est.date})
              {Math.abs(est.ftp - settings.ftp) >= 3 && (
                <>
                  {' '}
                  <button className="link" onClick={() => onSettingsChange({ ...settings, ftp: est.ftp })}>
                    Use {est.ftp} W
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="muted small">Ride 20+ minutes hard to get an estimate.</div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row space">
          <div className="card-title">Fitness, fatigue &amp; form</div>
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r.id} className={range === r.id ? 'active' : ''} onClick={() => setRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <FitnessChart days={series} />
        <div className="legend">
          <span><i className="swatch" style={{ background: SERIES.ctl }} /> Fitness (CTL)</span>
          <span><i className="swatch" style={{ background: SERIES.atl }} /> Fatigue (ATL)</span>
          <span><i className="swatch" style={{ background: SERIES.tsb }} /> Form (TSB)</span>
          <span className="muted">Dashed: projection from your calendar</span>
          <button className="link" onClick={() => setShowTable(!showTable)}>{showTable ? 'Hide table' : 'Show table'}</button>
        </div>
        {showTable && (
          <div className="table-scroll">
            <table className="laps">
              <thead>
                <tr><th>Date</th><th>TSS</th><th>Planned</th><th>CTL</th><th>ATL</th><th>TSB</th></tr>
              </thead>
              <tbody>
                {[...series].reverse().map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{d.future ? '' : Math.round(d.tss)}</td>
                    <td>{d.planned ? Math.round(d.planned) : ''}</td>
                    <td>{Math.round(d.ctl)}</td>
                    <td>{Math.round(d.atl)}</td>
                    <td>{Math.round(d.tsb)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Weekly TSS</div>
        <WeeklyBars weeks={weeks} />
      </div>

      {children}

      <div className="card">
        <div className="card-title">Last two weeks</div>
        {recent.length ? (
          <table className="laps">
            <thead>
              <tr><th>Date</th><th>Activity</th><th>Time</th><th>TSS</th><th>From</th></tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <td>{e.date}</td>
                  <td>{e.name}</td>
                  <td>{formatDuration(e.seconds)}</td>
                  <td>{Math.round(e.tss)}</td>
                  <td className="muted small">{e.kind === 'ridebox' ? 'RideBox' : `Strava (${e.source === 'power' ? 'power' : e.source === 'hr' ? 'heart rate' : 'estimated'})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No activities in the last two weeks.</p>
        )}
      </div>
    </div>
  );
}
