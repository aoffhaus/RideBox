// Best efforts: the rider's power curve for any period (or two, compared), and
// the all-time top 3 for Strava's power durations and, from outdoor rides, its
// cycling distances.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RideRecord } from '../app/recorder';
import { useEffortSources } from '../app/efforts';
import { listAll, listRides, type Settings } from '../storage/db';
import { fullHistoryImported, importOlderStravaActivities } from '../strava/activities';
import { pendingEfforts, syncMissingStreams } from '../strava/streams';
import { bestCurve, DISTANCE_RECORDS, inRange, POWER_RECORDS, topDistance, topPower, type EffortSource } from '../training/efforts';
import { weightOn } from '../training/ftp';
import { dayKey } from '../training/load';
import type { StravaActivity } from '../training/model';
import { formatDuration } from '../workout/model';
import { ActualDetail } from './ActualDetail';
import { Modal } from './Calendar';
import { fmtSpeed } from './format';
import { CURVE_COLORS, PeriodSelect, PERIODS, periodRange, periodSeries, PowerCurveChart, shortDate, type CurveSeries, type PeriodId } from './PowerCurve';

const MEDALS = ['🥇', '🥈', '🥉'];
const todayKey = () => dayKey(Date.now());
const keyAgo = (days: number) => dayKey(Date.now() - days * 86_400_000);

interface Pick {
  src: EffortSource;
  /** the effort's window in the ride (s) */
  focus: [number, number];
  title: string;
}

function PeriodControl({ value, onChange, custom, onCustom, allowNone }: {
  value: PeriodId | 'none';
  onChange: (p: PeriodId | 'none') => void;
  custom: { from: string; to: string };
  onCustom: (c: { from: string; to: string }) => void;
  allowNone?: boolean;
}) {
  return (
    <div className="row">
      {allowNone && (
        <div className="seg">
          <button className={value === 'none' ? 'active' : ''} aria-pressed={value === 'none'} onClick={() => onChange('none')}>Off</button>
        </div>
      )}
      <PeriodSelect value={value === 'none' ? ('' as PeriodId) : value} onChange={onChange} />
      {value === 'custom' && (
        <span className="row small">
          <input type="date" aria-label="From" value={custom.from} max={custom.to || undefined} onChange={(e) => onCustom({ ...custom, from: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" aria-label="To" value={custom.to} min={custom.from || undefined} onChange={(e) => onCustom({ ...custom, to: e.target.value })} />
        </span>
      )}
    </div>
  );
}

const periodLabel = (p: PeriodId, c: { from: string; to: string }) =>
  p === 'custom' && c.from && c.to ? `${shortDate(new Date(c.from + 'T12:00').getTime())} – ${shortDate(new Date(c.to + 'T12:00').getTime())}` : PERIODS.find((x) => x.id === p)!.long;

/** Downloads the whole Strava history and every ride's streams, paced to Strava's limits, while the page is open. */
function HistoryLoader({ rides, acts, onImported }: { rides: RideRecord[]; acts: StravaActivity[]; onImported: () => void }) {
  const [pending, setPending] = useState<number | null>(null);
  const [full, setFull] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  useEffect(() => {
    pendingEfforts(acts, rides).then(setPending).catch(() => setPending(null));
    fullHistoryImported().then(setFull);
  }, [acts, rides]);
  useEffect(() => () => void (stop.current = true), []);

  const run = async () => {
    setRunning(true);
    stop.current = false;
    try {
      if (!(await fullHistoryImported())) {
        setStatus('Importing your Strava history…');
        const n = await importOlderStravaActivities((k) => setStatus(`Importing your Strava history… ${k} older activities`));
        setFull(true);
        if (n) onImported();
      }
      for (;;) {
        const allActs = await listAll<StravaActivity>('strava_acts');
        const allRides = await listRides();
        let left = await pendingEfforts(allActs, allRides);
        setPending(left);
        if (!left || stop.current) break;
        setStatus(`Downloading ride data from Strava… ${left} rides to go`);
        // Strava allows 100 requests per 15 minutes
        await syncMissingStreams(allActs, allRides, 90);
        left = await pendingEfforts(allActs, allRides);
        setPending(left);
        if (!left || stop.current) break;
        const resume = Date.now() + 15 * 60_000;
        while (Date.now() < resume && !stop.current) {
          setStatus(`${left} rides to go. Waiting for Strava’s request limit; resuming at ${new Date(resume).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} (keep this page open).`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      setStatus(stop.current ? '' : 'All rides analyzed ✓');
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (full && pending === 0 && !status) return null;
  return (
    <div className="banner small history-loader">
      <div>
        {full === false && <>Best efforts cover the Strava activities imported so far (the last 180 days at first). </>}
        {pending ? <>{pending} ride{pending === 1 ? '' : 's'} still need their data downloaded from Strava. </> : null}
        {status && <div className="muted">{status}</div>}
      </div>
      {!running ? (
        (full === false || !!pending) && <button onClick={run}>{full === false ? 'Load full Strava history' : 'Download now'}</button>
      ) : (
        <button onClick={() => (stop.current = true)}>Stop</button>
      )}
    </div>
  );
}

export function BestEfforts({ rides, acts, settings, stravaReady, onImported, phone }: {
  rides: RideRecord[];
  acts: StravaActivity[];
  settings: Settings;
  /** Strava is connected with permission to read activities */
  stravaReady: boolean;
  onImported: () => void;
  phone?: boolean;
}) {
  const sources = useEffortSources();
  const [period, setPeriod] = useState<PeriodId>('6w');
  const [custom, setCustom] = useState({ from: keyAgo(90), to: todayKey() });
  const [cmp, setCmp] = useState<PeriodId | 'none'>('none');
  const [cmpCustom, setCmpCustom] = useState({ from: keyAgo(455), to: keyAgo(365) });
  const [pick, setPick] = useState<Pick | null>(null);

  const now = Date.now();
  const range = periodRange(period, now, custom);
  const cRange = cmp === 'none' ? null : periodRange(cmp, now, cmpCustom);
  const main = useMemo(() => (sources ? bestCurve(inRange(sources, range[0], range[1])) : []), [sources, range[0], range[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const other = useMemo(() => (sources && cRange ? bestCurve(inRange(sources, cRange[0], cRange[1])) : []), [sources, cRange?.[0], cRange?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const series: CurveSeries[] = [periodSeries(main, 'main', periodLabel(period, custom), CURVE_COLORS.main, settings, { fill: true })];
  if (cmp !== 'none') series.push(periodSeries(other, 'cmp', periodLabel(cmp, cmpCustom), CURVE_COLORS.compare, settings));

  const power = useMemo(() => (sources ? POWER_RECORDS.map((r) => ({ ...r, top: topPower(sources, r.s) })) : []), [sources]);
  const dist = useMemo(() => (sources ? DISTANCE_RECORDS.map((r, i) => ({ ...r, top: topDistance(sources, i) })) : []), [sources]);
  const ride = pick?.src.kind === 'ridebox' ? rides.find((r) => r.id === pick.src.id) : undefined;
  const act = pick?.src.kind === 'strava' ? acts.find((a) => a.id === pick.src.id) : undefined;

  return (
    <div className={phone ? 'best-efforts phone' : 'page best-efforts'}>
      {!phone && <h2>Best efforts</h2>}
      {stravaReady && <HistoryLoader rides={rides} acts={acts} onImported={onImported} />}

      <div className="card">
        <div className="row space">
          <div className="card-title">Power curve</div>
        </div>
        <PeriodControl value={period} onChange={(p) => p !== 'none' && setPeriod(p)} custom={custom} onCustom={setCustom} />
        <div className="row small compare-row">
          <span className="muted">Compare with</span>
          <PeriodControl value={cmp} onChange={setCmp} custom={cmpCustom} onCustom={setCmpCustom} allowNone />
        </div>
        {sources == null ? (
          <div className="muted small row">
            <span className="spinner" aria-hidden /> Working out best efforts…
          </div>
        ) : (
          <PowerCurveChart series={series} height={phone ? 200 : 260} empty="No rides with power in this period." />
        )}
      </div>

      <h3 className="be-h">All-time power records</h3>
      <div className="records">
        {power.map((r) => (
          <div key={r.s} className="record-card">
            <div className="record-name">{r.label}</div>
            {r.top.length ? (
              r.top.map((t, i) => {
                const kg = weightOn(settings, dayKey(t.src.start));
                return (
                  <button key={t.src.id} className="record-row" onClick={() => setPick({ src: t.src, focus: [t.at, t.at + r.s], title: `${r.label} · ${t.w} W` })}>
                    <span className="record-medal" aria-label={`#${i + 1}`}>{MEDALS[i]}</span>
                    <span className="record-val">
                      <b>{t.w} W</b> <span className="muted">{(t.w / kg).toFixed(2)} W/kg</span>
                    </span>
                    <span className="record-src muted">
                      {shortDate(t.src.start)} · {t.src.name}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="muted small">No effort yet</div>
            )}
          </div>
        ))}
      </div>

      <h3 className="be-h">All-time distance records</h3>
      <div className="muted small">Outdoor rides only. Fastest elapsed time over each distance, as Strava times it.</div>
      <div className="records">
        {dist.map((r) => (
          <div key={r.label} className="record-card">
            <div className="record-name">{r.label}</div>
            {r.top.length ? (
              r.top.map((t, i) => (
                <button key={t.src.id} className="record-row" onClick={() => setPick({ src: t.src, focus: [t.at, t.at + t.t], title: `${r.label} · ${formatDuration(t.t)}` })}>
                  <span className="record-medal" aria-label={`#${i + 1}`}>{MEDALS[i]}</span>
                  <span className="record-val">
                    <b>{formatDuration(t.t)}</b> <span className="muted">{fmtSpeed(r.m / t.t, settings)} {settings.units === 'metric' ? 'km/h' : 'mph'}</span>
                  </span>
                  <span className="record-src muted">
                    {shortDate(t.src.start)} · {t.src.name}
                  </span>
                </button>
              ))
            ) : (
              <div className="muted small">No outdoor ride this long yet</div>
            )}
          </div>
        ))}
      </div>

      {pick && (
        <Modal title={pick.src.name} onClose={() => setPick(null)}>
          <div className="muted small">
            {new Date(pick.src.start).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · <b>{pick.title}</b> (highlighted)
          </div>
          {ride || act ? <ActualDetail ride={ride} act={act} settings={settings} focus={pick.focus} compact={phone} /> : <div className="muted">This ride is no longer in RideBox.</div>}
          {pick.src.stravaId && (
            <a className="strava-link" href={`https://www.strava.com/activities/${pick.src.stravaId}`} target="_blank" rel="noreferrer">View on Strava ↗</a>
          )}
        </Modal>
      )}
    </div>
  );
}
