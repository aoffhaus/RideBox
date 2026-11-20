import { useMemo, useState } from "react";
import {
  chainLubeStatus,
  chainStats,
  currentLink,
  indoorOutdoor,
  linkUses,
  mToMi,
  periodUsage,
  sToH,
  type ChainStats,
} from "../calc";
import { fixed1, hours, miles, when } from "../fmt";
import { Stat, useApp } from "../ui";

export function Chains() {
  const { model } = useApp();
  const [showRetired, setShowRetired] = useState(false);
  const stats = useMemo(() => chainStats(model.chains, model.installs, model.rides), [model]);

  const rows = [...stats.values()]
    .filter((s) => showRetired || !s.chain.retired)
    .sort(
      (a, b) =>
        Number(a.current_bike_id === null) - Number(b.current_bike_id === null) ||
        a.chain.name.toLowerCase().localeCompare(b.chain.name.toLowerCase()),
    );

  const statusText = (s: ChainStats) =>
    s.current_bike_id ? `On ${model.bikeName(s.current_bike_id)}` : s.chain.retired ? "Retired" : "Off";

  return (
    <>
      <label className="ct-check ct-toggle-row">
        <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.currentTarget.checked)} />
        Show retired chains
      </label>

      {!rows.length && <p className="ct-msg ct-info">No chains yet. Add one in Settings.</p>}

      {rows.map((s) => {
        const id = s.chain.chain_id;
        const lube = chainLubeStatus(id, model.lubes, model.installs, model.rides);
        const link = currentLink(id, model.links);
        const chainLinks = model.links.filter((l) => l.chain_id === id).sort((a, b) => b.added_at - a.added_at);
        const { indoor, outdoor } = indoorOutdoor(s.periods.flatMap((p) => p.rides));
        return (
          <section className="ct-card" key={id}>
            <div className="ct-card-head">
              <h2>{s.chain.name}</h2>
              <span className={s.current_bike_id ? "ct-badge ct-on" : "ct-badge"}>{statusText(s)}</span>
            </div>
            <div className="ct-stats">
              <Stat label="Lifetime" value={`${miles(s.lifetime_distance_m)} · ${hours(s.lifetime_time_s)}`} />
              <Stat
                label="Since install"
                value={s.since_install ? `${miles(s.since_install.distance_m)} · ${hours(s.since_install.moving_time_s)}` : "—"}
              />
              <Stat label="Installs" value={String(s.periods.length)} />
              <Stat
                label="Since lube"
                value={lube.lube ? miles(lube.rides.reduce((t, r) => t + r.distance_m, 0)) : "—"}
              />
              <Stat label="Quick link uses" value={link ? `${linkUses(link, model.installs)}×` : "—"} />
            </div>
            {lube.lube && <p className="ct-caption">Last lube {when(lube.lube.lubed_at)}</p>}

            <details>
              <summary>Install periods</summary>
              {s.chain.start_distance_m > 0 && (
                <p className="ct-caption">
                  Starting value: {miles(s.chain.start_distance_m)} (~{hours(s.start_time_estimated_s)} est. at 16
                  mph)
                </p>
              )}
              {chainLinks.length > 0 && (
                <p className="ct-caption">
                  Quick links:{" "}
                  {chainLinks
                    .map(
                      (l, i) =>
                        `${i === 0 ? "current" : "old"} ${linkUses(l, model.installs)}× since ${when(l.added_at)}` +
                        (l.note ? ` (${l.note})` : ""),
                    )
                    .join("; ")}
                </p>
              )}
              {s.chain.notes && <p className="ct-caption">{s.chain.notes}</p>}
              {!s.periods.length ? (
                <p>Never installed.</p>
              ) : (
                <>
                  <p className="ct-caption">
                    Tracked rides: outdoor {miles(outdoor.distance_m)} · {hours(outdoor.moving_time_s)}, indoor{" "}
                    {miles(indoor.distance_m)} · {hours(indoor.moving_time_s)}
                  </p>
                  <div className="ct-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Bike</th>
                          <th>Start</th>
                          <th>End</th>
                          <th className="ct-num">Rides</th>
                          <th className="ct-num">Miles</th>
                          <th className="ct-num">Hours</th>
                          <th className="ct-num">Outdoor mi</th>
                          <th className="ct-num">Indoor mi</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...s.periods].reverse().map((p) => {
                          const u = periodUsage(p);
                          const io = indoorOutdoor(p.rides);
                          return (
                            <tr key={p.install.install_id}>
                              <td>{model.bikeName(p.install.bike_id)}</td>
                              <td>{when(p.start)}</td>
                              <td>{p.end === null ? "current" : when(p.end)}</td>
                              <td className="ct-num">{u.rides}</td>
                              <td className="ct-num">{fixed1(mToMi(u.distance_m))}</td>
                              <td className="ct-num">{fixed1(sToH(u.moving_time_s))}</td>
                              <td className="ct-num">{fixed1(mToMi(io.outdoor.distance_m))}</td>
                              <td className="ct-num">{fixed1(mToMi(io.indoor.distance_m))}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </details>
          </section>
        );
      })}
      {rows.some((s) => s.chain.start_distance_m > 0) && (
        <p className="ct-caption">
          Lifetime totals include each chain's starting miles. Hours for starting miles are estimated at 16 mph.
        </p>
      )}
    </>
  );
}
