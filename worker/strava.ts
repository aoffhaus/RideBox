// Strava, held by the Worker.
//
// The Strava API app's Client ID and Secret are Worker secrets
// (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET). The Worker runs the sign-in,
// keeps the tokens in D1 and refreshes them, and the app reaches Strava only
// through /api/strava/proxy/*. Neither the secret nor the tokens are ever
// sent to the browser.

export interface StravaEnv {
  DB: D1Database;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
}

export interface StravaAuth {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete_name: string | null;
  scope: string;
}

/** Token storage (D1 in production, a stub in tests). */
export interface AuthStore {
  get(): Promise<StravaAuth | null>;
  put(a: StravaAuth): Promise<void>;
  clear(): Promise<void>;
}

export const d1Store = (db: D1Database): AuthStore => ({
  get: () => db.prepare('SELECT access_token, refresh_token, expires_at, athlete_name, scope FROM strava_auth WHERE id = 1').first<StravaAuth>(),
  put: async (a) => {
    await db
      .prepare(
        `INSERT INTO strava_auth (id, access_token, refresh_token, expires_at, athlete_name, scope) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, athlete_name = excluded.athlete_name, scope = excluded.scope`,
      )
      .bind(a.access_token, a.refresh_token, a.expires_at, a.athlete_name, a.scope)
      .run();
  },
  clear: async () => {
    await db.prepare('DELETE FROM strava_auth').run();
  },
});

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const DEAUTH_URL = 'https://www.strava.com/oauth/deauthorize';
const API = 'https://www.strava.com/api/v3';
export const SCOPE = 'activity:write,activity:read_all';
const STATE_COOKIE = 'ridebox_strava_state';

/** Only the Strava endpoints RideBox uses can be reached through the proxy. */
const ALLOWED: [string, RegExp][] = [
  ['GET', /^athlete\/activities$/],
  ['POST', /^uploads$/],
  ['GET', /^uploads\/\d+$/],
  ['PUT', /^activities\/\d+$/],
];
export const allowed = (method: string, path: string) => ALLOWED.some(([m, re]) => m === method && re.test(path));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const configured = (env: StravaEnv) => !!(env.STRAVA_CLIENT_ID?.trim() && env.STRAVA_CLIENT_SECRET?.trim());

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { firstname?: string; lastname?: string };
  message?: string;
}

async function tokenRequest(env: StravaEnv, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID!.trim(), client_secret: env.STRAVA_CLIENT_SECRET!.trim(), ...body }),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new Error(`Strava sign-in failed (${res.status}): ${j.message ?? 'unknown error'}`);
  return j;
}

/** A valid access token, refreshed (and stored) when it's about to expire. */
export async function freshToken(env: StravaEnv, store: AuthStore, now = Date.now()): Promise<string | null> {
  const a = await store.get();
  if (!a) return null;
  if (a.expires_at - 120 > now / 1000) return a.access_token;
  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
  await store.put({ ...a, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at });
  return t.access_token;
}

function cookie(req: Request, name: string) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get('Cookie') ?? '');
  return m ? m[1] : null;
}

/** Handles /api/strava/*. `sub` is the part after /api/strava/. */
export async function strava(env: StravaEnv, req: Request, url: URL, sub: string, store: AuthStore = d1Store(env.DB)): Promise<Response> {
  if (sub === 'status' && req.method === 'GET') {
    const a = configured(env) ? await store.get() : null;
    return json({ configured: configured(env), connected: !!a, athleteName: a?.athlete_name ?? undefined, scope: a?.scope ?? '' });
  }
  if (!configured(env)) return json({ error: 'Strava isn’t set up: add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET as Worker secrets.' }, 503);

  if (sub === 'connect' && req.method === 'GET') {
    const state = crypto.randomUUID();
    const q = new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID!.trim(),
      redirect_uri: `${url.origin}/api/strava/callback`,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: SCOPE,
      state,
    });
    return new Response(null, {
      status: 302,
      headers: { Location: `${AUTHORIZE_URL}?${q}`, 'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/api/strava; HttpOnly; Secure; SameSite=Lax; Max-Age=600` },
    });
  }

  if (sub === 'callback' && req.method === 'GET') {
    const back = (q: Record<string, string>) =>
      new Response(null, { status: 302, headers: { Location: `/?${new URLSearchParams(q)}`, 'Set-Cookie': `${STATE_COOKIE}=; Path=/api/strava; Max-Age=0` } });
    const state = url.searchParams.get('state');
    if (!state || state !== cookie(req, STATE_COOKIE)) return back({ strava: 'error', message: 'The Strava sign-in expired or didn’t start here. Try connecting again.' });
    const err = url.searchParams.get('error');
    if (err) return back({ strava: 'error', message: err === 'access_denied' ? 'You declined access on Strava.' : err });
    const scope = url.searchParams.get('scope') ?? '';
    if (!scope.split(',').includes('activity:write')) {
      return back({ strava: 'error', message: 'Strava didn’t grant permission to upload activities. Connect again and leave “Upload your activities” checked.' });
    }
    try {
      const t = await tokenRequest(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '' });
      const athlete = [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(' ') || null;
      await store.put({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at, athlete_name: athlete, scope });
      return back({ strava: 'connected' });
    } catch (e) {
      return back({ strava: 'error', message: (e as Error).message });
    }
  }

  if (sub === 'disconnect' && req.method === 'POST') {
    const a = await store.get();
    if (a) await fetch(DEAUTH_URL, { method: 'POST', body: new URLSearchParams({ access_token: a.access_token }) }).catch(() => {});
    await store.clear();
    return json({ ok: true });
  }

  if (sub.startsWith('proxy/')) {
    const path = sub.slice('proxy/'.length);
    if (!allowed(req.method, path)) return json({ error: 'Not allowed.' }, 403);
    let token: string | null;
    try {
      token = await freshToken(env, store);
    } catch (e) {
      return json({ message: (e as Error).message }, 401);
    }
    if (!token) return json({ message: 'Strava isn’t connected. Connect it in Settings.' }, 401);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const ct = req.headers.get('Content-Type');
    if (ct) headers.set('Content-Type', ct);
    const res = await fetch(`${API}/${path}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' ? undefined : await req.arrayBuffer(),
    });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } });
  }

  return json({ error: 'Not found' }, 404);
}
