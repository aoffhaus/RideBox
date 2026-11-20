/** Thin fetch wrapper for the chain tracker API in the RideBox Worker. */

/** Relative, like the rest of RideBox (vite base "./"). */
export const BASE = "api/chain-tracker";

import type { AppData, NewInstall, SyncResult } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      redirect: "manual",
    });
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection.");
  }
  // Cloudflare Access answers an expired session with a redirect to its login page.
  if (resp.redirected || resp.type === "opaqueredirect" || !(resp.headers.get("content-type") ?? "").includes("json")) {
    throw new ApiError(401, "Your sign-in expired. Reload the page to sign in again.");
  }
  const data = (await resp.json()) as T & { error?: string };
  if (!resp.ok) throw new ApiError(resp.status, data.error ?? `Request failed (${resp.status})`);
  return data;
}

export const api = {
  data: () => call<AppData>("GET", `${BASE}/data`),
  sync: (opts: { force?: boolean; rebuild?: boolean } = {}) => call<SyncResult>("POST", `${BASE}/sync`, opts),
  addChain: (b: { name: string; notes: string; start_miles: number }) => call("POST", `${BASE}/chains`, b),
  saveChain: (id: string, b: { name: string; notes: string; start_miles: number; retired: boolean }) =>
    call("PUT", `${BASE}/chains/${id}`, b),
  addInstall: (b: NewInstall) => call("POST", `${BASE}/installs`, b),
  saveInstall: (
    id: string,
    b: { bike_id: string; chain_id: string; installed_at: string; note: string; link_id: string },
  ) => call("PUT", `${BASE}/installs/${id}`, b),
  deleteInstall: (id: string) => call("DELETE", `${BASE}/installs/${id}`),
  addLube: (b: { bike_id: string; chain_id: string; lubed_at: string; note: string }) => call("POST", `${BASE}/lubes`, b),
  saveLube: (id: string, b: { bike_id: string; chain_id: string; lubed_at: string; note: string }) =>
    call("PUT", `${BASE}/lubes/${id}`, b),
  deleteLube: (id: string) => call("DELETE", `${BASE}/lubes/${id}`),
  addQuickLink: (b: { chain_id: string; start_uses: number; note: string }) => call("POST", `${BASE}/quicklinks`, b),
  saveSettings: (b: { chain_bikes?: string[]; default_bike_virtual_ride?: string }) => call("PUT", `${BASE}/settings`, b),
};
