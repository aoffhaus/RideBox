import type { ReactNode } from "react";
import { useState } from "react";
import type { Install, Lube } from "../calc";
import { api } from "../api";
import { fromLocalInput, toIso, toLocalInput, when } from "../fmt";
import { DeleteControls, ErrorText, Field, Modal, useApp, useSubmit } from "../ui";

function EditSwap({ inst, onClose }: { inst: Install; onClose: () => void }) {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const [bikeId, setBikeId] = useState(inst.bike_id);
  const [chainId, setChainId] = useState(inst.chain_id);
  const [at, setAt] = useState(toLocalInput(inst.installed_at));
  const [linkId, setLinkId] = useState(inst.link_id);
  const [note, setNote] = useState(inst.note);

  const bikeIds = model.bikes.has(inst.bike_id) ? [...model.bikes.keys()] : [inst.bike_id, ...model.bikes.keys()];
  const links = model.links.filter((l) => l.chain_id === chainId).sort((a, b) => b.added_at - a.added_at);
  const atMs = fromLocalInput(at);

  const save = () =>
    submit(
      () =>
        api.saveInstall(inst.install_id, {
          bike_id: bikeId,
          chain_id: chainId,
          installed_at: toIso(atMs),
          note: note.trim(),
          link_id: links.some((l) => l.link_id === linkId) ? linkId : "",
        }),
      "Swap updated",
      onClose,
    );

  return (
    <Modal title="Edit swap" onClose={onClose}>
      <Field label="Bike">
        <select value={bikeId} onChange={(e) => setBikeId(e.currentTarget.value)}>
          {bikeIds.map((b) => (
            <option key={b} value={b}>
              {model.bikeName(b)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Chain">
        <select value={chainId} onChange={(e) => setChainId(e.currentTarget.value)}>
          {model.chains.map((c) => (
            <option key={c.chain_id} value={c.chain_id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Swap time">
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.currentTarget.value)} required />
      </Field>
      <Field label="Quick link used">
        <select value={links.some((l) => l.link_id === linkId) ? linkId : ""} onChange={(e) => setLinkId(e.currentTarget.value)}>
          <option value="">None recorded</option>
          {links.map((l) => (
            <option key={l.link_id} value={l.link_id}>
              Quick link from {when(l.added_at)}
              {l.note && ` (${l.note})`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <ErrorText error={error} />
      <button type="button" className="ct-btn ct-primary ct-wide" disabled={busy || Number.isNaN(atMs)} onClick={save}>
        Save
      </button>
      <DeleteControls
        label="swap"
        busy={busy}
        onDelete={() => submit(() => api.deleteInstall(inst.install_id), "Swap deleted", onClose)}
      />
    </Modal>
  );
}

function EditLube({ lube, onClose }: { lube: Lube; onClose: () => void }) {
  const { model } = useApp();
  const { busy, error, submit } = useSubmit();
  const [at, setAt] = useState(toLocalInput(lube.lubed_at));
  const [chainId, setChainId] = useState(lube.chain_id);
  const [note, setNote] = useState(lube.note);
  const atMs = fromLocalInput(at);

  const save = () =>
    submit(
      () => api.saveLube(lube.lube_id, { bike_id: lube.bike_id, chain_id: chainId, lubed_at: toIso(atMs), note: note.trim() }),
      "Lube updated",
      onClose,
    );

  return (
    <Modal title="Edit lube" onClose={onClose}>
      <Field label="Lube time">
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.currentTarget.value)} required />
      </Field>
      <Field label="Chain" hint="Set on bikes with rotated chains, so the lube follows the chain.">
        <select value={chainId} onChange={(e) => setChainId(e.currentTarget.value)}>
          <option value="">None (bike's chain)</option>
          {model.chains.map((c) => (
            <option key={c.chain_id} value={c.chain_id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <ErrorText error={error} />
      <button type="button" className="ct-btn ct-primary ct-wide" disabled={busy || Number.isNaN(atMs)} onClick={save}>
        Save
      </button>
      <DeleteControls
        label="lube"
        busy={busy}
        onDelete={() => submit(() => api.deleteLube(lube.lube_id), "Lube deleted", onClose)}
      />
    </Modal>
  );
}

function Entry(props: { title: ReactNode; at: number; note: string; onEdit: () => void }) {
  return (
    <div className="ct-entry">
      <div className="ct-entry-text">
        <div>{props.title}</div>
        <div className="ct-caption">
          {when(props.at)}
          {props.note && ` · ${props.note}`}
        </div>
      </div>
      <button className="ct-btn ct-small" onClick={props.onEdit}>
        Edit
      </button>
    </div>
  );
}

export function History() {
  const { model } = useApp();
  const [view, setView] = useState<"swaps" | "lubes">("swaps");
  const [editing, setEditing] = useState<{ kind: "swap"; inst: Install } | { kind: "lube"; lube: Lube } | null>(null);
  const close = () => setEditing(null);

  const installs = [...model.installs].sort(
    (a, b) => b.installed_at - a.installed_at || (b.install_id > a.install_id ? 1 : -1),
  );
  const lubes = [...model.lubes].sort((a, b) => b.lubed_at - a.lubed_at || (b.lube_id > a.lube_id ? 1 : -1));

  return (
    <>
      <div className="ct-segmented ct-tabs-inline" role="tablist">
        {(["swaps", "lubes"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={view === v ? "ct-seg ct-active" : "ct-seg"}
            onClick={() => setView(v)}
          >
            {v === "swaps" ? "Swaps" : "Lubes"}
          </button>
        ))}
      </div>

      {view === "swaps" ? (
        <div className="ct-list">
          {!installs.length && <p className="ct-msg ct-info">No swaps logged yet.</p>}
          {installs.map((i) => (
            <Entry
              key={i.install_id}
              title={
                <>
                  <strong>{model.chainName(i.chain_id)}</strong> → {model.bikeName(i.bike_id)}
                </>
              }
              at={i.installed_at}
              note={i.note}
              onEdit={() => setEditing({ kind: "swap", inst: i })}
            />
          ))}
        </div>
      ) : (
        <div className="ct-list">
          {!lubes.length && <p className="ct-msg ct-info">No lubes logged yet.</p>}
          {lubes.map((l) => (
            <Entry
              key={l.lube_id}
              title={
                l.chain_id ? (
                  <>
                    <strong>{model.chainName(l.chain_id)}</strong> on {model.bikeName(l.bike_id)}
                  </>
                ) : (
                  <strong>{model.bikeName(l.bike_id)}</strong>
                )
              }
              at={l.lubed_at}
              note={l.note}
              onEdit={() => setEditing({ kind: "lube", lube: l })}
            />
          ))}
        </div>
      )}

      {editing?.kind === "swap" && <EditSwap inst={editing.inst} onClose={close} />}
      {editing?.kind === "lube" && <EditLube lube={editing.lube} onClose={close} />}
    </>
  );
}
