// RideBox Worker: serves the app, its private API, and the Claude connector.
//
// Every page and /api/* request runs through the Cloudflare Access check
// (verifyAccess), so nothing is served unless Access has signed the visitor in
// as the owner. The exceptions are the Claude connector's OAuth endpoints and
// /mcp itself: Claude's servers call those, not the rider's browser, so they
// carry OAuth tokens instead of an Access sign-in (see README → Claude connector).
// The OAuth provider routes those; everything else reaches `app` below.

import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { verifyAccess, type AuthEnv } from './auth';
import { blob, pull, push, type SyncEnv } from './sync';
import { coach, type CoachEnv } from './coach';
import { strava, type StravaEnv } from './strava';
import { CHAIN_API, chainTracker, scheduledChainSync } from './chains';
import { D1Kv, purgeExpiredKv } from './oauthKv';
import { authorize, SCOPE, SCOPES_SUPPORTED } from './mcp/authorize';
import { mcpApiHandler, type McpEnv } from './mcp';

export interface Env extends AuthEnv, SyncEnv, CoachEnv, StravaEnv, McpEnv {
  ASSETS: Fetcher;
  /** set per request: the OAuth library's storage (D1-backed) and helpers */
  OAUTH_KV?: D1Kv;
  OAUTH_PROVIDER?: OAuthHelpers;
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
  if (url.pathname.startsWith('/api/strava/')) return strava(env, req, url, url.pathname.slice('/api/strava/'.length));
  if (url.pathname === CHAIN_API || url.pathname.startsWith(`${CHAIN_API}/`)) return chainTracker(req, env, url, email);
  return json({ error: 'Not found' }, 404);
}

/** The app, its API and the connector's sign-in page: all behind Cloudflare Access. */
const app = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith('/api/');
    const auth = await verifyAccess(req, env);
    if (!auth.ok) return denied(auth.status, auth.reason, isApi);
    if (url.pathname === '/authorize') {
      if (!env.OAUTH_PROVIDER) return denied(500, 'The Claude connector is not set up.', false);
      return authorize(req, env.OAUTH_PROVIDER, auth.email);
    }
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
};

const DAY = 86_400;

// The connector's resource URL has to be absolute, so build one provider per
// origin the Worker is reached on (normally just ridebox.<account>.workers.dev).
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler,
      defaultHandler: app,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: SCOPES_SUPPORTED,
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'RideBox' },
      accessTokenTTL: 3600,
      // stays connected while used at least every 60 days
      refreshTokenTTL: 60 * DAY,
      refreshTokenIdleTTL: 60 * DAY,
      // Claude identifies itself with a Client ID Metadata Document or registers dynamically
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, p);
  }
  return p;
}

/** Someone opened /mcp in a browser (no token): not an MCP client. */
function isBrowserVisit(req: Request, url: URL) {
  return url.pathname === '/mcp' && req.method === 'GET' && !req.headers.has('Authorization') && (req.headers.get('Accept') ?? '').includes('text/html');
}

/** Explains the endpoint instead of a blank 401, keeping the status and the OAuth challenge header. */
function connectorInfoPage(url: URL, res: Response) {
  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RideBox connector</title>
<body style="font:16px/1.5 system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:90vh;margin:0 16px">
<div style="max-width:32rem"><h1>🚴 RideBox connector</h1>
<p>This address is for Claude, not for a browser, so there's nothing to see here. It's working.</p>
<p>To connect: in Claude go to <b>Settings → Connectors → Add custom connector</b> and use this URL:</p>
<p><code style="background:#222;padding:4px 8px;border-radius:6px;word-break:break-all">${url.origin}/mcp</code></p>
<p>Then click <b>Connect</b>, sign in, and click <b>Allow</b>.</p></div></body>`;
  return new Response(html, { status: 401, headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const res = await providerFor(url.origin).fetch(req, { ...env, OAUTH_KV: new D1Kv(env.DB) }, ctx);
    return res.status === 401 && isBrowserVisit(req, url) ? connectorInfoPage(url, res) : res;
  },

  // Cron (wrangler.jsonc): keeps the chain tracker's Strava ride cache fresh and sweeps expired OAuth records.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledChainSync(env).catch((e) => console.error('Scheduled chain sync', e)));
    ctx.waitUntil(purgeExpiredKv(env.DB).catch((e) => console.error('OAuth purge', e)));
  },
} satisfies ExportedHandler<Env>;
