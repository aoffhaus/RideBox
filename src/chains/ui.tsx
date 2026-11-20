import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Model } from "./data";

export interface AppCtx {
  model: Model;
  reload: () => Promise<void>;
  toast: (msg: string, kind?: "ok" | "error") => void;
}

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

/** Modal built on <dialog>; closes on Escape or backdrop click. */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="ct-modal"
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose();
      }}
    >
      <div className="ct-modal-body">
        <header className="ct-modal-head">
          <h2>{props.title}</h2>
          <button type="button" className="ct-icon-btn" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}

/** Runs an async save, tracking busy state and an error message for the form. */
export function useSubmit() {
  const { reload, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(action: () => Promise<unknown>, success: string, after?: () => void) {
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
      toast(success);
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, submit, setError };
}

export const ErrorText = ({ error }: { error: string }) =>
  error ? (
    <p className="ct-msg ct-error" role="alert">
      {error}
    </p>
  ) : null;

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ct-field">
      <span className="ct-field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="ct-hint">{props.hint}</span>}
    </label>
  );
}

export function Stat(props: { label: string; value: string }) {
  return (
    <div className="ct-stat">
      <div className="ct-stat-label">{props.label}</div>
      <div className="ct-stat-value">{props.value}</div>
    </div>
  );
}

/** Delete button guarded by a confirmation checkbox. */
export function DeleteControls(props: { label: string; busy: boolean; onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="ct-danger-zone">
      <label className="ct-check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.currentTarget.checked)} />I want to delete
        this {props.label}
      </label>
      <button type="button" className="ct-btn ct-danger" disabled={!sure || props.busy} onClick={props.onDelete}>
        Delete
      </button>
    </div>
  );
}
