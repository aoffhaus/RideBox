import { useState } from 'react';
import type { Settings } from '../storage/types';
import { isBeginning, logFtp, logWeight, removeFtp, removeWeight } from '../training/ftp';
import { dayStart } from '../training/load';
import { FtpChart, type FtpMetric } from './FtpChart';

const LB = 2.20462;
const RANGES = [
  { id: '6w', label: '6w', days: 42 },
  { id: '3m', label: '3m', days: 91 },
  { id: '6m', label: '6m', days: 182 },
  { id: '1y', label: '1y', days: 365 },
] as const;
const fmtDay = (k: string) => (isBeginning(k) ? 'Earlier' : dayStart(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));

/** FTP history chart, plus forms to log a new FTP or weight (dated, today by default) and the lists of what's logged. */
export function RiderLog({ settings, today, onChange }: { settings: Settings; today: string; onChange: (s: Settings) => void }) {
  const imperial = settings.units === 'imperial';
  const showKg = (kg: number) => (imperial ? `${Math.round(kg * LB)} lb` : `${kg.toFixed(1)} kg`);
  const [ftp, setFtp] = useState('');
  const [ftpDate, setFtpDate] = useState(today);
  const [weight, setWeight] = useState('');
  const [weightDate, setWeightDate] = useState(today);
  const [showLists, setShowLists] = useState(false);
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('3m');
  const [metric, setMetric] = useState<FtpMetric>('ftp');
  const ftpVal = Number(ftp);
  const weightVal = Number(weight);
  const ftpOk = ftp !== '' && ftpVal >= 50 && ftpVal <= 600 && !!ftpDate && ftpDate <= today;
  const weightKg = imperial ? weightVal / LB : weightVal;
  const weightOk = weight !== '' && weightKg >= 30 && weightKg <= 200 && !!weightDate && weightDate <= today;
  const ftpHist = [...(settings.ftpHistory ?? [])].sort((a, b) => (a.from < b.from ? 1 : -1));
  const weightHist = [...(settings.weightHistory ?? [])].sort((a, b) => (a.from < b.from ? 1 : -1));

  return (
    <div className="card">
      <div className="row space">
        <div className="card-title">{metric === 'ftp' ? 'FTP' : 'W/kg'} history</div>
        <div className="row">
          <div className="seg" role="group" aria-label="Show FTP or W/kg">
            <button className={metric === 'ftp' ? 'active' : ''} onClick={() => setMetric('ftp')}>FTP</button>
            <button className={metric === 'wkg' ? 'active' : ''} onClick={() => setMetric('wkg')}>W/kg</button>
          </div>
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.id} className={range === r.id ? 'active' : ''} onClick={() => setRange(r.id)}>{r.label}</button>
            ))}
          </div>
        </div>
      </div>
      <FtpChart settings={settings} today={today} days={RANGES.find((r) => r.id === range)!.days} metric={metric} />
      <div className="row">
        <button className="link small" onClick={() => setShowLists(!showLists)}>{showLists ? 'Hide entries' : 'Show entries'}</button>
      </div>

      <div className="rider-log">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ftpOk) return;
            onChange(logFtp(settings, ftpDate, ftpVal));
            setFtp('');
            setFtpDate(today);
          }}
        >
          <b className="rider-log-label">Log FTP</b>
          <input type="number" inputMode="numeric" min={50} max={600} placeholder={String(settings.ftp)} value={ftp} onChange={(e) => setFtp(e.target.value)} aria-label="New FTP in watts" />
          <span className="muted">W on</span>
          <input type="date" max={today} value={ftpDate} onChange={(e) => setFtpDate(e.target.value)} aria-label="Date the FTP took effect" />
          <button className="primary" type="submit" disabled={!ftpOk}>Log FTP</button>
        </form>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!weightOk) return;
            onChange(logWeight(settings, weightDate, weightKg));
            setWeight('');
            setWeightDate(today);
          }}
        >
          <b className="rider-log-label">Log weight</b>
          <input
            type="number"
            inputMode="decimal"
            step={imperial ? 1 : 0.1}
            placeholder={imperial ? String(Math.round(settings.riderKg * LB)) : settings.riderKg.toFixed(1)}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            aria-label={`New weight in ${imperial ? 'pounds' : 'kilograms'}`}
          />
          <span className="muted">{imperial ? 'lb' : 'kg'} on</span>
          <input type="date" max={today} value={weightDate} onChange={(e) => setWeightDate(e.target.value)} aria-label="Date of the weight" />
          <button className="primary" type="submit" disabled={!weightOk}>Log weight</button>
        </form>
        <p className="muted small">Your newest entry is your current FTP or weight. Log an earlier date to fill in the history.</p>
      </div>

      {showLists && (
        <div className="rider-lists">
          <table className="laps">
            <thead><tr><th>FTP from</th><th>FTP</th><th /></tr></thead>
            <tbody>
              {ftpHist.map((c) => (
                <tr key={c.from}>
                  <td>{fmtDay(c.from)}</td>
                  <td>{c.ftp} W</td>
                  <td><button className="link danger-text" onClick={() => onChange(removeFtp(settings, c.from))}>Remove</button></td>
                </tr>
              ))}
              {!ftpHist.length && <tr><td colSpan={3} className="muted">Nothing logged yet. Current FTP {settings.ftp} W.</td></tr>}
            </tbody>
          </table>
          <table className="laps">
            <thead><tr><th>Weight on</th><th>Weight</th><th /></tr></thead>
            <tbody>
              {weightHist.map((c) => (
                <tr key={c.from}>
                  <td>{fmtDay(c.from)}</td>
                  <td>{showKg(c.kg)}</td>
                  <td><button className="link danger-text" onClick={() => onChange(removeWeight(settings, c.from))}>Remove</button></td>
                </tr>
              ))}
              {!weightHist.length && <tr><td colSpan={3} className="muted">Nothing logged yet. Current weight {showKg(settings.riderKg)}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
