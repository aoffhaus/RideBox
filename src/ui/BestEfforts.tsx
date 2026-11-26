// Best efforts: the rider's power curve for any period (or two, compared), and
// the all-time top 3 for Strava's power durations and, from outdoor rides, its
// cycling distances.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { fmtSpeed, speedUnit } from './format';
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

interface RecordItem {
  key: string;
  label: string;
  /** the record, shown under the label */
  best?: string;
  rows: { src: EffortSource; value: ReactNode; extra: string; open: () => void }[];
}

/** A row of intervals; tapping one opens its top 3 (tap again to close). */
function RecordPicker({ items, empty }: { items: RecordItem[]; empty: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const item = items.find((i) => i.key === sel);
  return (
    <div className="record-picker">
      <div className="record-chips" role="tablist">
        {items.map((i) => (
          <button
            key={i.key}
            role="tab"
            aria-selected={i.key === sel}
            className={`record-chip${i.key === sel ? ' active' : ''}${i.best ? '' : ' none'}`}
            onClick={() => setSel(i.key === sel ? null : i.key)}
          >
            <span className="record-chip-label">{i.label}</span>
            <span className="record-chip-best">{i.best ?? '—'}</span>
          </button>
        ))}
      </div>
      {item && (
        <div className="record-card" role="tabpanel">
          <div className="record-name">{item.label}</div>
          {item.rows.length ? (
            item.rows.map((r, k) => (
              <button key={r.src.id} className="record-row" onClick={r.open}>
                <span className="record-medal" aria-label={`#${k + 1}`}>{MEDALS[k]}</span>
                <span className="record-val">
                  {r.value} <span className="muted">{r.extra}</span>
                </span>
                <span className="record-src muted">
                  {shortDate(r.src.start)} · {r.src.name}
                </span>
              </button>
            ))
          ) : (
            <div className="muted small">{empty}</div>
          )}
        </div>
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
      <RecordPicker
        items={power.map((r) => ({
          key: String(r.s),
          label: r.label,
          best: r.top[0] ? `${r.top[0].w} W` : undefined,
          rows: r.top.map((t) => {
            const kg = weightOn(settings, dayKey(t.src.start));
            return {
              src: t.src,
              value: <b>{t.w} W</b>,
              extra: `${(t.w / kg).toFixed(2)} W/kg`,
              open: () => setPick({ src: t.src, focus: [t.at, t.at + r.s], title: `${r.label} · ${t.w} W` }),
            };
          }),
        }))}
        empty="No effort yet"
      />

      <h3 className="be-h">All-time distance records</h3>
      <div className="muted small">Outdoor rides only. Fastest elapsed time over each distance, as Strava times it.</div>
      <RecordPicker
        items={dist.map((r) => ({
          key: r.label,
          label: r.label,
          best: r.top[0] ? formatDuration(r.top[0].t) : undefined,
          rows: r.top.map((t) => ({
            src: t.src,
            value: <b>{formatDuration(t.t)}</b>,
            extra: `${fmtSpeed(r.m / t.t, settings)} ${speedUnit(settings)}`,
            open: () => setPick({ src: t.src, focus: [t.at, t.at + t.t], title: `${r.label} · ${formatDuration(t.t)}` }),
          })),
        }))}
        empty="No outdoor ride this long yet"
      />

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
