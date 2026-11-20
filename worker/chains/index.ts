// Chain tracker API, served by the RideBox Worker under /api/chain-tracker/*.
//
// Ported from the standalone chain-tracker Worker. RideBox's index.ts has
// already checked Cloudflare Access before anything here runs, and Strava
// goes through RideBox's own sign-in (the strava_auth table), so this file
// holds only the chain tracker's records, the ride cache and its sync.

import type { NewInstall } from "../../src/chains/types";
import { d1Store, type AuthStore, type StravaEnv } from "../strava";
import { Db } from "./db";
import { StravaClient, type TokenStore } from "./strava";
import { syncStep } from "./sync";

export type ChainEnv = StravaEnv;

export const CHAIN_API = "/api/chain-tracker";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// ---- input validation ----------------------------------------------------

type Body = Record<string, unknown>;

function str(b: Body, key: string, opts: { max?: number; required?: boolean } = {}): string {
  const v = b[key];
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, `${key} is required`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${key} must be text`);
  const s = v.trim();
  if (opts.required && !s) throw new HttpError(400, `${key} can't be empty`);
  if (s.length > (opts.max ?? 500)) throw new HttpError(400, `${key} is too long`);
  return s;
}

function iso(b: Body, key: string): string {
  const s = str(b, key, { required: true, max: 40 });
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new HttpError(400, `${key} must be a date/time`);
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function num(b: Body, key: string, opts: { int?: boolean; min?: number } = {}): number {
  const v = b[key] ?? 0;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${key} must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new HttpError(400, `${key} must be a whole number`);
  if (v < (opts.min ?? 0)) throw new HttpError(400, `${key} can't be below ${opts.min ?? 0}`);
  return v;
}

async function readBody(req: Request): Promise<Body> {
  // Requiring JSON forces a CORS preflight for cross-site requests, which this API never approves.
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    throw new HttpError(415, "Expected JSON");
  }
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "Expected a JSON object");
  return b as Body;
}

// ---- strava --------------------------------------------------------------

const stravaConfigured = (env: ChainEnv) => Boolean(env.STRAVA_CLIENT_ID?.trim() && env.STRAVA_CLIENT_SECRET?.trim());

/** RideBox's Strava sign-in, seen through the chain tracker's TokenStore. */
export function sharedTokens(auth: AuthStore): TokenStore {
  return {
    load: async () => {
      const a = await auth.get();
      return a ? { refresh_token: a.refresh_token, access_token: a.access_token, expires_at: a.expires_at } : null;
    },
    save: async (t) => {
      const a = await auth.get();
      if (a) await auth.put({ ...a, ...t });
    },
  };
}

function stravaClient(env: ChainEnv): StravaClient {
  if (!stravaConfigured(env)) throw new HttpError(500, "Strava isn't set up: add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET as Worker secrets.");
  return new StravaClient(env.STRAVA_CLIENT_ID!.trim(), env.STRAVA_CLIENT_SECRET!.trim(), sharedTokens(d1Store(env.DB)));
}

/** RideBox's Strava connection (null when not set up or not connected). */
async function stravaAuth(env: ChainEnv): Promise<{ scope: string } | null> {
  if (!stravaConfigured(env)) return null;
  const a = await d1Store(env.DB).get();
  return a ? { scope: a.scope } : null;
}

// ---- routes --------------------------------------------------------------

async function handleApi(req: Request, env: ChainEnv, url: URL, user: string): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "").slice(CHAIN_API.length);
  const method = req.method;
  const db = new Db(env.DB);

  if (method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Cross-site request refused");
  }

  if (method === "GET" && path === "/data") {
    return json(await db.all(await stravaAuth(env), user));
  }
  if (method === "GET" && path === "/export") {
    const data = await db.exportAll();
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="chain-tracker-${data.exported_at.slice(0, 10)}.json"`,
      },
    });
  }

  const m = path.match(/^\/(chains|installs|lubes|quicklinks|settings|sync)(?:\/([\w-]{1,40}))?$/);
  if (!m) throw new HttpError(404, "Not found");
  const [, resource, id] = m;

  if (resource === "sync" && method === "POST" && !id) {
    const b = await readBody(req);
    const client = stravaClient(env);
    if (b.rebuild === true) await db.clearRideCache();
    return json(await syncStep(db, client, { force: b.force === true || b.rebuild === true }));
  }

  if (resource === "chains") {
    if (method === "POST" && !id) {
      const b = await readBody(req);
      const name = str(b, "name", { required: true, max: 80 });
      if (await db.chainNameTaken(name)) throw new HttpError(409, "A chain with that name already exists.");
      const chain_id = await db.addChain({
        name,
        notes: str(b, "notes"),
        start_miles: num(b, "start_miles"),
        retired: false,
      });
      return json({ chain_id }, 201);
    }
    if (method === "PUT" && id) {
      const b = await readBody(req);
      if (!(await db.exists("chains", "chain_id", id))) throw new HttpError(404, "Chain not found");
      const name = str(b, "name", { required: true, max: 80 });
      if (await db.chainNameTaken(name, id)) throw new HttpError(409, "A chain with that name already exists.");
      await db.saveChain({
        chain_id: id,
        name,
        notes: str(b, "notes"),
        start_miles: num(b, "start_miles"),
        retired: b.retired === true,
      });
      return json({ ok: true });
    }
  }

  if (resource === "installs") {
    if (method === "POST" && !id) {
      const b = await readBody(req);
      const link = b.link as NewInstall["link"] | undefined;
      const install = {
        bike_id: str(b, "bike_id", { required: true, max: 40 }),
        chain_id: str(b, "chain_id", { required: true, max: 40 }),
        installed_at: iso(b, "installed_at"),
        note: str(b, "note"),
      };
      if (!(await db.exists("chains", "chain_id", install.chain_id))) throw new HttpError(400, "Unknown chain");
      if (await db.installClash(install.bike_id, install.installed_at)) {
        throw new HttpError(409, "Another swap on this bike already has this exact time.");
      }
      let linkArg: NewInstall["link"];
      if (link && typeof link === "object" && "reuse" in link) {
        const reuse = str(link as Body, "reuse", { required: true, max: 40 });
        if (!(await db.exists("quicklinks", "link_id", reuse))) throw new HttpError(400, "Unknown quick link");
        linkArg = { reuse };
      } else {
        linkArg = { new_note: link && typeof link === "object" ? str(link as Body, "new_note") : "" };
      }
      return json({ install_id: await db.addInstall(install, linkArg) }, 201);
    }
    if (method === "PUT" && id) {
      const b = await readBody(req);
      if (!(await db.exists("installs", "install_id", id))) throw new HttpError(404, "Swap not found");
      const row = {
        install_id: id,
        bike_id: str(b, "bike_id", { required: true, max: 40 }),
        chain_id: str(b, "chain_id", { required: true, max: 40 }),
        installed_at: iso(b, "installed_at"),
        note: str(b, "note"),
        link_id: str(b, "link_id", { max: 40 }),
      };
      if (await db.installClash(row.bike_id, row.installed_at, id)) {
        throw new HttpError(409, "Another swap on this bike already has this exact time.");
      }
      await db.saveInstall(row);
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      await db.deleteInstall(id);
      return json({ ok: true });
    }
  }

  if (resource === "lubes") {
    if (method === "POST" && !id) {
      const b = await readBody(req);
      const lube_id = await db.addLube({
        bike_id: str(b, "bike_id", { required: true, max: 40 }),
        chain_id: str(b, "chain_id", { max: 40 }),
        lubed_at: iso(b, "lubed_at"),
        note: str(b, "note"),
      });
      return json({ lube_id }, 201);
    }
    if (method === "PUT" && id) {
      const b = await readBody(req);
      if (!(await db.exists("lubes", "lube_id", id))) throw new HttpError(404, "Lube not found");
      await db.saveLube({
        lube_id: id,
        bike_id: str(b, "bike_id", { required: true, max: 40 }),
        chain_id: str(b, "chain_id", { max: 40 }),
        lubed_at: iso(b, "lubed_at"),
        note: str(b, "note"),
      });
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      await db.deleteLube(id);
      return json({ ok: true });
    }
  }

  if (resource === "quicklinks" && method === "POST" && !id) {
    const b = await readBody(req);
    const chain_id = str(b, "chain_id", { required: true, max: 40 });
    if (!(await db.exists("chains", "chain_id", chain_id))) throw new HttpError(400, "Unknown chain");
    const link_id = await db.addQuickLink({
      chain_id,
      added_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      start_uses: num(b, "start_uses", { int: true }),
      note: str(b, "note"),
    });
    return json({ link_id }, 201);
  }

  if (resource === "settings" && method === "PUT" && !id) {
    const b = await readBody(req);
    if ("chain_bikes" in b) {
      const list = b.chain_bikes;
      if (!Array.isArray(list) || !list.every((x) => typeof x === "string" && x.length <= 40)) {
        throw new HttpError(400, "chain_bikes must be a list of bike ids");
      }
      await db.setSetting("chain_bikes", [...new Set(list as string[])].sort().join(","));
    }
    if ("default_bike_virtual_ride" in b) {
      await db.setSetting("default_bike_virtual_ride", str(b, "default_bike_virtual_ride", { max: 40 }));
    }
    return json({ ok: true });
  }

  throw new HttpError(405, "Method not allowed");
}

/** Handles /api/chain-tracker/*. `user` is the email Cloudflare Access signed in. */
export async function chainTracker(req: Request, env: ChainEnv, url: URL, user: string): Promise<Response> {
  try {
    return await handleApi(req, env, url, user);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(`${req.method} ${url.pathname}`, e);
    return json({ error: `Server error: ${(e as Error).message}` }, 500);
  }
}

/** Cron: one sync step, if Strava is connected and a sync is due. */
export async function scheduledChainSync(env: ChainEnv): Promise<void> {
  if (!(await stravaAuth(env))) return;
  const r = await syncStep(new Db(env.DB), stravaClient(env));
  if (!r.ok) console.warn(`Scheduled chain sync: ${r.message}`);
}
