// RideBox Worker: serves the app and its private API.
//
// Every request (pages and /api/*) runs through here first, so nothing is
// served unless Cloudflare Access has signed the visitor in as the owner.

import { verifyAccess, type AuthEnv } from './auth';
import { blob, pull, push, type SyncEnv } from './sync';
import { coach, type CoachEnv } from './coach';

export interface Env extends AuthEnv, SyncEnv, CoachEnv {
  ASSETS: Fetcher;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function denied(status: number, reason: string, api: boolean) {
  if (api) return json({ error: reason }, status);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RideBox</title>
<body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:90vh;margin:0 16px">
<div><h1>🚴 RideBox is private</h1><p>${reason}</p></div></body>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function api(req: Request, env: Env, url: URL, email: string, ctx: ExecutionContext): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/me':
      return json({ email });
    case 'GET /api/sync':
      return pull(env, url);
    case 'POST /api/sync':
      return push(env, req);
    case 'GET /api/blob':
      return blob(env, url);
  }
  const m = /^POST \/api\/coach\/(plan|adapt|today)$/.exec(route);
  if (m) return coach(env, req, m[1], ctx);
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith('/api/');
    const auth = await verifyAccess(req, env);
    if (!auth.ok) return denied(auth.status, auth.reason, isApi);
    if (isApi) {
      try {
        return await api(req, env, url, auth.email, ctx);
      } catch (e) {
        console.error(`${req.method} ${url.pathname}`, e);
        return json({ error: 'Server error' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
