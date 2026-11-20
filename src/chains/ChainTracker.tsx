// Chain tracker: chain rotation, quick links and lubes per bike, counted from
// Strava rides. Ported from the standalone chain-tracker app; its API lives in
// the RideBox Worker under /api/chain-tracker and it shares RideBox's Strava sign-in.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { toModel, type Model } from "./data";
import { Chains } from "./pages/Chains";
import { History } from "./pages/History";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { Ctx } from "./ui";
import "./chains.css";

const PAGES = [
  { id: "bikes", title: "Bikes", Page: Home },
  { id: "chains", title: "Chains", Page: Chains },
  { id: "history", title: "History", Page: History },
  { id: "settings", title: "Setup", Page: Settings },
] as const;
type PageId = (typeof PAGES)[number]["id"];

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const PAGE_KEY = "ridebox.chains.page";

function readPage(): PageId {
  try {
    const v = localStorage.getItem(PAGE_KEY);
    if (PAGES.some((p) => p.id === v)) return v as PageId;
  } catch {
    /* storage blocked */
  }
  return "bikes";
}

/** `phone`: rendered inside the phone layout (bigger heading, gutters). */
export function ChainTracker({ phone = false }: { phone?: boolean }) {
  const [page, setPageState] = useState<PageId>(readPage);
  const [model, setModel] = useState<Model | null>(null);
  const [loadError, setLoadError] = useState("");
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: "ok" | "error" }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const toastId = useRef(0);

  const setPage = (p: PageId) => {
    setPageState(p);
    try {
      localStorage.setItem(PAGE_KEY, p);
    } catch {
      /* storage blocked */
    }
  };

  const toast = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3000);
  }, []);

  const reload = useCallback(async () => {
    setModel(toModel(await api.data()));
    setLoadError("");
  }, []);

  // Load, then sync in the background if the last sync is stale. The cron keeps it fresh
  // too; this covers the gap when the page is opened between cron runs.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const m = toModel(await api.data());
        if (!live) return;
        setModel(m);
        const last = m.sync.last_sync ? Date.parse(m.sync.last_sync) : 0;
        if (m.sync.connected && !m.sync.backoff_until && (m.sync.pulling || Date.now() - last >= SYNC_INTERVAL_MS)) {
          setSyncing(true);
          try {
            for (let i = 0; i < 20; i++) {
              const r = await api.sync();
              if (!r.ok) {
                toast(r.message, "error");
                break;
              }
              if (!r.more) break;
            }
            if (live) await reload();
          } finally {
            if (live) setSyncing(false);
          }
        }
      } catch (e) {
        if (live) setLoadError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [reload, toast]);

  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  const syncPill = syncing && (
    <span className="ct-sync-pill" role="status">
      Syncing…
    </span>
  );
  const subnav = (
    <div className="ct-segmented ct-subnav" role="tablist" aria-label="Chain tracker pages">
      {PAGES.map((p) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={p === current}
          className={p === current ? "ct-seg ct-active" : "ct-seg"}
          onClick={() => {
            setPage(p.id);
            if (phone) window.scrollTo({ top: 0 });
          }}
        >
          {p.title}
        </button>
      ))}
    </div>
  );

  return (
    <div className={phone ? "ct ct-phone" : "page narrow ct"}>
      {phone ? (
        // the phone layout's sticky header (clears the status bar / notch)
        <header className="m-head">
          <div className="m-head-row">
            <h1 className="m-h1">Chains</h1>
            {syncPill}
          </div>
          {subnav}
        </header>
      ) : (
        <>
          <div className="ct-top">
            <h2>Chain tracker</h2>
            {syncPill}
          </div>
          {subnav}
        </>
      )}
      <div className={phone ? "ct-body" : undefined}>
      {loadError ? (
        <div className="ct-msg ct-error" role="alert">
          <p>{loadError}</p>
          <button className="ct-btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      ) : !model ? (
        <p className="ct-muted ct-loading">Loading…</p>
      ) : (
        <Ctx.Provider value={{ model, reload, toast }}>
          <current.Page />
        </Ctx.Provider>
      )}
      </div>
      <div className="ct-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ct-toast ct-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
