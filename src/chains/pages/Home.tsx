import { useMemo, useState } from "react";
import {
  bikeLubeStatus,
  bikeStatus,
  chainLubeStatus,
  chainOnBikeAt,
  chainStats,
  currentLink,
  indoorOutdoor,
  linkUses,
  usage,
  type LubeStatus,
  type Ride,
} from "../calc";
import { api } from "../api";
import { fromLocalInput, hours, miles, nowMinute, toIso, toLocalInput, when } from "../fmt";
import { ErrorText, Field, Modal, Stat, useApp, useSubmit } from "../ui";

function UsageBlock({ since, rides }: { since: string; rides: Ride[] }) {
  const total = usage(rides);
  const { indoor, outdoor } = indoorOutdoor(rides);
  return (
    <>
      <div className="ct-stats">
        <Stat label={`Miles since ${since}`} value={miles(total.distance_m)} />
        <Stat label={`Hours since ${since}`} value={hours(total.moving_time_s)} />
      </div>
      <p className="ct-caption">
        Outdoor {miles(outdoor.distance_m)} · {hours(outdoor.moving_time_s)}
        <br />
        Indoor {miles(indoor.distance_m)} · {hours(indoor.moving_time_s)}
        <br />
        {total.rides} rides
      </p>
    </>
  );
}

function LubeLine({ s, what }: { s: LubeStatus; what: string }) {
  if (!s.lube) return <p className="ct-line">No lube logged for {what} yet</p>;
  const u = usage(s.rides);
  return (
    <p className="ct-line">
      Since lube: <strong>{miles(u.distance_m)}</strong> · {hours(u.moving_time_s)} · {u.rides} rides (lubed{" "}
      {when(s.lube.lubed_at)})
    </p>
  );
}

function SwapDialog({ bikeId, onClose }: { bikeId: string; onClose: () => void }) {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const stats = useMemo(() => chainStats(model.chains, model.installs, model.rides), [model]);
  const currentId = bikeStatus([bikeId], model.installs, model.rides).get(bikeId)?.current?.install.chain_id ?? null;
  const options = model.chains.filter((c) => !c.retired && c.chain_id !== currentId);

  const [chainId, setChainId] = useState(options[0]?.chain_id ?? "");
  const [at, setAt] = useState(toLocalInput(nowMinute()));
  const [choice, setChoice] = useState<"reuse" | "new">("reuse");
  const [linkNote, setLinkNote] = useState("");
  const [note, setNote] = useState("");

  if (!options.length) {
    return (
      <Modal title="Swap chain" onClose={onClose}>
        <p>No other active chains. Add one in Settings.</p>
      </Modal>
    );
  }

  const chain = model.chains.find((c) => c.chain_id === chainId)!;
  const link = currentLink(chainId, model.links);
  const uses = link ? linkUses(link, model.installs) : 0;
  const newLink = !link || choice === "new";
  const atMs = fromLocalInput(at);
  const valid = !Number.isNaN(atMs);
  const elsewhere = stats.get(chainId)?.current_bike_id;
  const clash = model.installs.some((i) => i.bike_id === bikeId && i.installed_at === atMs);

  const confirm = () =>
    submit(
      () =>
        api.addInstall({
          bike_id: bikeId,
          chain_id: chainId,
          installed_at: toIso(atMs),
          note: note.trim(),
          link: newLink ? { new_note: linkNote.trim() } : { reuse: link!.link_id },
        }),
      `${chain.name} installed`,
      onClose,
    );

  return (
    <Modal title="Swap chain" onClose={onClose}>
      <Field label="Chain to install">
        <select value={chainId} onChange={(e) => setChainId(e.currentTarget.value)}>
          {options.map((c) => (
            <option key={c.chain_id} value={c.chain_id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Swap time">
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.currentTarget.value)} required />
      </Field>
      {link ? (
        <fieldset className="ct-segmented">
          <legend className="ct-field-label">Quick link</legend>
          <label className={choice === "reuse" ? "ct-seg ct-active" : "ct-seg"}>
            <input type="radio" name="link" checked={choice === "reuse"} onChange={() => setChoice("reuse")} />
            Reuse (used {uses}×)
          </label>
          <label className={choice === "new" ? "ct-seg ct-active" : "ct-seg"}>
            <input type="radio" name="link" checked={choice === "new"} onChange={() => setChoice("new")} />
            New quick link
          </label>
        </fieldset>
      ) : (
        <p className="ct-caption">No quick link on record for this chain. A new one will be logged.</p>
      )}
      {newLink && (
        <Field label="Quick link note">
          <input
            value={linkNote}
            onChange={(e) => setLinkNote(e.currentTarget.value)}
            placeholder="Optional: brand, e.g. KMC 11sp"
          />
        </Field>
      )}
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder="Optional" />
      </Field>

      {elsewhere && elsewhere !== bikeId && (
        <p className="ct-msg ct-warn">
          {chain.name} is logged as installed on {model.bikeName(elsewhere)}. That bike will keep counting miles to it
          until you log a swap there too.
        </p>
      )}
      {clash && <p className="ct-msg ct-error">Another swap on this bike already has this exact time.</p>}
      {valid && atMs > Date.now() && <p className="ct-caption">This time is in the future.</p>}

      {valid && (
        <p>
          Install <strong>{chain.name}</strong> on <strong>{model.bikeName(bikeId)}</strong> at{" "}
          <strong>{when(atMs)}</strong>
          {currentId && `, replacing ${model.chainName(currentId)}`}, closed with{" "}
          {newLink ? (
            <>
              a <strong>new quick link</strong> (use 1)
            </>
          ) : (
            `its quick link (use ${uses + 1})`
          )}
          .
        </p>
      )}
      <ErrorText error={error} />
      <button type="button" className="ct-btn ct-primary ct-wide" disabled={busy || clash || !valid} onClick={confirm}>
        {busy ? "Saving…" : "Confirm swap"}
      </button>
    </Modal>
  );
}

function LubeDialog({ bikeId, onClose }: { bikeId: string; onClose: () => void }) {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const [at, setAt] = useState(toLocalInput(nowMinute()));
  const [note, setNote] = useState("");
  const atMs = fromLocalInput(at);
  const valid = !Number.isNaN(atMs);
  const chainId = valid && model.chainBikes.has(bikeId) ? chainOnBikeAt(model.installs, bikeId, atMs) : null;

  const confirm = () =>
    submit(
      () => api.addLube({ bike_id: bikeId, chain_id: chainId ?? "", lubed_at: toIso(atMs), note: note.trim() }),
      "Lube logged",
      onClose,
    );

  return (
    <Modal title="Log lube" onClose={onClose}>
      <Field label="Lube time">
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.currentTarget.value)} required />
      </Field>
      <Field label="Note">
        <input
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          placeholder="Optional: product, e.g. hot wax, drip wax"
        />
      </Field>
      {valid && atMs > Date.now() && <p className="ct-caption">This time is in the future.</p>}
      {valid && (
        <p>
          Log a lube of{" "}
          {chainId ? (
            <>
              <strong>{model.chainName(chainId)}</strong> on <strong>{model.bikeName(bikeId)}</strong>
            </>
          ) : (
            <>
              the chain on <strong>{model.bikeName(bikeId)}</strong>
            </>
          )}{" "}
          at <strong>{when(atMs)}</strong>.
        </p>
      )}
      <ErrorText error={error} />
      <button type="button" className="ct-btn ct-primary ct-wide" disabled={busy || !valid} onClick={confirm}>
        {busy ? "Saving…" : "Confirm lube"}
      </button>
    </Modal>
  );
}

export function Home() {
  const { model } = useApp();
  const [dialog, setDialog] = useState<{ kind: "swap" | "lube"; bikeId: string } | null>(null);
  const bikeIds = [...model.bikes.keys()];
  const status = useMemo(() => bikeStatus(bikeIds, model.installs, model.rides), [model]);

  if (!bikeIds.length) {
    return <p className="ct-msg ct-info">No bikes yet. Connect Strava and run a sync from Settings.</p>;
  }

  return (
    <>
      {bikeIds.map((bikeId) => {
        const s = status.get(bikeId)!;
        const rotates = model.chainBikes.has(bikeId);
        const link = s.current ? currentLink(s.current.install.chain_id, model.links) : null;
        const unassigned = usage(s.unassigned);
        const bikeLube = rotates ? null : bikeLubeStatus(bikeId, model.lubes, model.rides);
        return (
          <section className="ct-card" key={bikeId}>
            <h2>{model.bikeName(bikeId)}</h2>
            {rotates ? (
              <>
                {s.current ? (
                  <>
                    <p className="ct-line">
                      <strong>{model.chainName(s.current.install.chain_id)}</strong> since {when(s.current.start)}
                    </p>
                    <p className="ct-line">
                      {link ? (
                        <>
                          Quick link used <strong>{linkUses(link, model.installs)}×</strong>
                          {link.note && ` · ${link.note}`}
                        </>
                      ) : (
                        "No quick link on record (add one in Settings)"
                      )}
                    </p>
                    <UsageBlock since="swap" rides={s.current.rides} />
                    <LubeLine
                      s={chainLubeStatus(s.current.install.chain_id, model.lubes, model.installs, model.rides)}
                      what={model.chainName(s.current.install.chain_id)}
                    />
                  </>
                ) : (
                  <p className="ct-line">No chain logged yet</p>
                )}
                {unassigned.rides > 0 && (
                  <p className="ct-caption">
                    Unassigned (before first install): {miles(unassigned.distance_m)}, {unassigned.rides} rides
                  </p>
                )}
              </>
            ) : bikeLube?.lube ? (
              <>
                <p className="ct-line">Lubed {when(bikeLube.lube.lubed_at)}</p>
                <UsageBlock since="lube" rides={bikeLube.rides} />
              </>
            ) : (
              <p className="ct-line">No lube logged yet</p>
            )}
            <div className="ct-row">
              {rotates && (
                <button className="ct-btn ct-primary ct-grow" onClick={() => setDialog({ kind: "swap", bikeId })}>
                  Swap chain
                </button>
              )}
              <button
                className={rotates ? "ct-btn ct-grow" : "ct-btn ct-primary ct-grow"}
                onClick={() => setDialog({ kind: "lube", bikeId })}
              >
                Log lube
              </button>
            </div>
          </section>
        );
      })}
      {dialog?.kind === "swap" && <SwapDialog bikeId={dialog.bikeId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "lube" && <LubeDialog bikeId={dialog.bikeId} onClose={() => setDialog(null)} />}
    </>
  );
}
