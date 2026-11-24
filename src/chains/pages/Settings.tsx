import { useState, type FormEvent } from "react";
import { currentLink, linkUses, mToMi } from "../calc";
import { api } from "../api";
import { when } from "../fmt";
import { ErrorText, Field, useApp, useSubmit } from "../ui";

function AddChain() {
  const { model } = useApp();
  const { busy, error, submit, setError } = useSubmit();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [start, setStart] = useState("0");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError("Give the chain a name.");
    if (model.chains.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
      return setError("A chain with that name already exists.");
    }
    submit(() => api.addChain({ name: n, notes: notes.trim(), start_miles: Number(start) || 0 }), `Added ${n}`, () => {
      setName("");
      setNotes("");
      setStart("0");
    });
  };

  return (
    <form className="ct-card" onSubmit={onSubmit}>
      <h3>Add a chain</h3>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Chain C" />
      </Field>
      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.currentTarget.value)} placeholder="Optional: brand, model, wax/lube" />
      </Field>
      <Field label="Starting miles" hint="Miles already on the chain. Hours are estimated at 16 mph.">
        <input type="number" min="0" step="any" inputMode="decimal" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
      </Field>
      <ErrorText error={error} />
      <button className="ct-btn ct-wide" disabled={busy}>
        Add chain
      </button>
    </form>
  );
}

function EditChain() {
  const { model } = useApp();
  const { busy, error, submit, setError } = useSubmit();
  const [chainId, setChainId] = useState(model.chains[0]?.chain_id ?? "");
  const chain = model.chains.find((c) => c.chain_id === chainId) ?? model.chains[0];
  if (!chain) return null;
  return (
    <div className="ct-card">
      <h3>Edit a chain</h3>
      <Field label="Chain">
        <select value={chain.chain_id} onChange={(e) => setChainId(e.currentTarget.value)}>
          {model.chains.map((c) => (
            <option key={c.chain_id} value={c.chain_id}>
              {c.name}
              {c.retired ? " (retired)" : ""}
            </option>
          ))}
        </select>
      </Field>
      {/* Keyed so the form resets when another chain is picked. */}
      <ChainForm
        key={chain.chain_id}
        chain={chain}
        busy={busy}
        error={error}
        onSave={(b) => {
          if (!b.name) return setError("Name can't be empty.");
          submit(() => api.saveChain(chain.chain_id, b), "Chain saved");
        }}
      />
    </div>
  );
}

function ChainForm(props: {
  chain: { name: string; notes: string; start_distance_m: number; retired: boolean };
  busy: boolean;
  error: string;
  onSave: (b: { name: string; notes: string; start_miles: number; retired: boolean }) => void;
}) {
  const c = props.chain;
  const [name, setName] = useState(c.name);
  const [notes, setNotes] = useState(c.notes);
  const [start, setStart] = useState(String(Math.round(mToMi(c.start_distance_m) * 10) / 10));
  const [retired, setRetired] = useState(c.retired);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave({ name: name.trim(), notes: notes.trim(), start_miles: Number(start) || 0, retired });
      }}
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </Field>
      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
      </Field>
      <Field label="Starting miles">
        <input type="number" min="0" step="any" inputMode="decimal" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
      </Field>
      <label className="ct-check">
        <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.currentTarget.checked)} />
        Retired <span className="ct-hint">(hidden from the swap selector)</span>
      </label>
      <ErrorText error={props.error} />
      <button className="ct-btn ct-wide" disabled={props.busy}>
        Save chain
      </button>
    </form>
  );
}

function QuickLinks() {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const [chainId, setChainId] = useState(model.chains[0]?.chain_id ?? "");
  const [uses, setUses] = useState("1");
  const [note, setNote] = useState("");
  const chain = model.chains.find((c) => c.chain_id === chainId) ?? model.chains[0];
  if (!chain) return null;
  const link = currentLink(chain.chain_id, model.links);

  return (
    <form
      className="ct-card"
      onSubmit={(e) => {
        e.preventDefault();
        submit(
          () => api.addQuickLink({ chain_id: chain.chain_id, start_uses: Math.max(0, Math.trunc(Number(uses) || 0)), note: note.trim() }),
          "Quick link saved",
          () => setNote(""),
        );
      }}
    >
      <Field label="Chain">
        <select value={chain.chain_id} onChange={(e) => setChainId(e.currentTarget.value)}>
          {model.chains.map((c) => (
            <option key={c.chain_id} value={c.chain_id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <p className="ct-line">
        {link ? (
          <>
            Current quick link used <strong>{linkUses(link, model.installs)}×</strong> since {when(link.added_at)}
            {link.note && ` · ${link.note}`}
          </>
        ) : (
          "No quick link on record"
        )}
      </p>
      <h3>Record a quick link already on this chain</h3>
      <Field
        label="Times used so far"
        hint="Include the swap that closed it most recently. Future swaps that reuse it add to this count."
      >
        <input type="number" min="0" step="1" inputMode="numeric" value={uses} onChange={(e) => setUses(e.currentTarget.value)} />
      </Field>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder="Optional: brand, e.g. KMC 11sp" />
      </Field>
      <ErrorText error={error} />
      <button className="ct-btn ct-wide" disabled={busy}>
        Save quick link
      </button>
      <p className="ct-caption">New quick links fitted during a swap are added from the Swap chain dialog.</p>
    </form>
  );
}

function Bikes() {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const bikeIds = [...model.bikes.keys()];
  if (!bikeIds.length) return <p className="ct-caption">Bikes appear here after the first Strava sync.</p>;

  const toggle = (bikeId: string, on: boolean) => {
    const next = new Set(model.chainBikes);
    if (on) next.add(bikeId);
    else next.delete(bikeId);
    submit(() => api.saveSettings({ chain_bikes: [...next].filter((b) => model.bikes.has(b)) }), "Saved");
  };

  return (
    <div className="ct-card">
      <h3>Bikes with rotated chains</h3>
      <p className="ct-caption">
        These bikes get a Swap chain button, and lubes on them follow the installed chain. Other bikes only track miles
        since their last lube.
      </p>
      {bikeIds.map((b) => (
        <label className="ct-check" key={b}>
          <input type="checkbox" checked={model.chainBikes.has(b)} disabled={busy} onChange={(e) => toggle(b, e.currentTarget.checked)} />
          {model.bikeName(b)}
        </label>
      ))}
      <ErrorText error={error} />
    </div>
  );
}

export function UntaggedRides() {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const bikeIds = [...model.bikes.keys()];
  if (!bikeIds.length) return null;
  return (
    <div className="ct-card">
      <Field
        label="Virtual rides with no bike count toward"
        hint="Applies to Strava VirtualRide activities (Zwift etc.) with no bike tagged. Rides you tag with a bike on Strava keep that tag."
      >
        <select
          value={model.defaultVirtualBike}
          disabled={busy}
          onChange={(e) => submit(() => api.saveSettings({ default_bike_virtual_ride: e.currentTarget.value }), "Saved")}
        >
          <option value="">No bike (ignore them)</option>
          {bikeIds.map((b) => (
            <option key={b} value={b}>
              {model.bikeName(b)}
            </option>
          ))}
        </select>
      </Field>
      <ErrorText error={error} />
    </div>
  );
}

function StravaSync() {
  const { model, reload } = useApp();
  const s = model.sync;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [progress, setProgress] = useState("");

  async function run(rebuild: boolean) {
    setBusy(true);
    setResult(null);
    try {
      let r = await api.sync({ force: true, rebuild });
      // A long pull runs in steps; keep going until it's done.
      for (let i = 0; r.ok && r.more && i < 50; i++) {
        setProgress(r.message);
        r = await api.sync({ force: true });
      }
      setResult(r);
      await reload();
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="ct-card">
      <p className="ct-line">
        Strava: <strong>{s.connected ? "connected" : "not connected"}</strong>
        {!s.connected && " (uses RideBox's Strava connection)"}
      </p>
      {s.connected && !s.bikes_scope && (
        <p className="ct-msg ct-warn">
          RideBox's Strava connection can't read your bikes, so new bikes and renames won't show up. Click{" "}
          <strong>Reconnect Strava</strong> and leave every permission box checked.
        </p>
      )}
      <p className="ct-line">
        Last sync: <strong>{s.last_sync ? when(Date.parse(s.last_sync)) : "never"}</strong> · {s.ride_count} activities
        cached
      </p>
      {s.backoff_until && (
        <p className="ct-msg ct-warn">Rate limited. Sync paused until {when(Date.parse(s.backoff_until))}.</p>
      )}
      {s.pulling && !busy && <p className="ct-caption">A pull is partway done. Sync now finishes it.</p>}
      <div className="ct-row">
        {s.connected && (
          <>
            <button className="ct-btn ct-primary" disabled={busy} onClick={() => run(false)}>
              Sync now
            </button>
            <button className="ct-btn" disabled={busy} onClick={() => run(true)}>
              Rebuild ride cache
            </button>
          </>
        )}
        <a className={s.connected ? "ct-btn" : "ct-btn ct-primary"} href="api/strava/connect">
          {s.connected ? "Reconnect Strava" : "Connect Strava"}
        </a>
      </div>
      {busy && <p className="ct-caption">{progress || "Talking to Strava…"}</p>}
      {result && <p className={result.ok ? "ct-msg ct-ok" : "ct-msg ct-error"}>{result.message}</p>}
      <p className="ct-caption">Syncs automatically every 30 minutes, and when you open the app if the last sync is over 15 minutes old.</p>
    </div>
  );
}

export function Settings() {
  const { model } = useApp();
  return (
    <>
      <h2 className="ct-section">Chains</h2>
      <AddChain />
      <EditChain />

      <h2 className="ct-section">Quick links</h2>
      {model.chains.length ? <QuickLinks /> : <p className="ct-caption">Add a chain first.</p>}

      <h2 className="ct-section">Bikes</h2>
      <Bikes />

      <h2 className="ct-section">Untagged rides</h2>
      <UntaggedRides />

      <h2 className="ct-section">Strava sync</h2>
      <StravaSync />

      <h2 className="ct-section">Backup</h2>
      <div className="ct-card">
        <p className="ct-caption">Download every chain, swap, lube, quick link and setting as a JSON file.</p>
        <a className="ct-btn" href="api/chain-tracker/export" download>
          Download backup
        </a>
      </div>

    </>
  );
}
