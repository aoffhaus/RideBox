// Strava: OAuth (authorization-code flow, run entirely in the browser) + FIT upload.
//
// RideBox has no server, so each rider registers their own (free) Strava API
// application and pastes its Client ID and Client Secret into Settings. The
// secret and tokens are stored only in this browser's IndexedDB.

import { getFlag, setFlag } from '../storage/db';

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const DEAUTH_URL = 'https://www.strava.com/oauth/deauthorize';
const API = 'https://www.strava.com/api/v3';
const KV_KEY = 'strava';
/** marks our own OAuth redirect so we don't react to unrelated ?code= params */
export const OAUTH_STATE = 'ridebox-strava';

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  /** seconds since epoch */
  expiresAt?: number;
  athleteName?: string;
}

export interface StravaUploadState {
  status: 'uploading' | 'done' | 'error';
  activityId?: number;
  error?: string;
  /** muted: kept out of followers' feeds (Strava's hide_from_home) */
  hidden?: boolean;
}

export const DEFAULT_STRAVA: StravaConfig = { clientId: '', clientSecret: '' };

export async function loadStrava(): Promise<StravaConfig> {
  try {
    return { ...DEFAULT_STRAVA, ...((await getFlag(KV_KEY)) as Partial<StravaConfig> | undefined) };
  } catch {
    return DEFAULT_STRAVA;
  }
}
export async function saveStrava(c: StravaConfig) {
  await setFlag(KV_KEY, c);
}

export const isConnected = (c: StravaConfig) => !!(c.refreshToken && c.clientId && c.clientSecret);

/** The page URL without query/hash: Strava sends the rider back here. */
export function redirectUri(loc: { origin: string; pathname: string } = location) {
  return loc.origin + loc.pathname;
}

export function authorizeUrl(clientId: string, redirect = redirectUri()) {
  const q = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: redirect,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:write',
    state: OAUTH_STATE,
  });
  return `${AUTHORIZE_URL}?${q}`;
}

export type OAuthReturn = { code: string; scope: string } | { error: string } | null;

/** Reads Strava's redirect back to us (?state=ridebox-strava&code=…&scope=…). */
export function parseOAuthReturn(search: string): OAuthReturn {
  const q = new URLSearchParams(search);
  if (q.get('state') !== OAUTH_STATE) return null;
  const err = q.get('error');
  if (err) return { error: err === 'access_denied' ? 'You declined access on Strava.' : err };
  const code = q.get('code');
  if (!code) return null;
  return { code, scope: q.get('scope') ?? '' };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { firstname?: string; lastname?: string };
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Strava sign-in failed (${res.status}): ${describeError(json)}`);
  return json as TokenResponse;
}

/** Finishes the OAuth round trip: trades the one-time code for tokens and saves them. */
export async function completeOAuth(c: StravaConfig, ret: { code: string; scope: string }): Promise<StravaConfig> {
  if (!ret.scope.split(',').includes('activity:write')) {
    throw new Error('Strava didn’t grant permission to upload activities. Connect again and leave “Upload your activities” checked.');
  }
  const t = await tokenRequest({
    client_id: c.clientId.trim(),
    client_secret: c.clientSecret.trim(),
    code: ret.code,
    grant_type: 'authorization_code',
  });
  const next: StravaConfig = {
    ...c,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_at,
    athleteName: [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(' ') || undefined,
  };
  await saveStrava(next);
  return next;
}

/** Returns a valid access token, refreshing (and persisting) it when it is about to expire. */
async function accessToken(): Promise<string> {
  const c = await loadStrava();
  if (!isConnected(c)) throw new Error('Strava isn’t connected. Connect it in Settings.');
  if (c.accessToken && c.expiresAt && c.expiresAt - 120 > Date.now() / 1000) return c.accessToken;
  const t = await tokenRequest({
    client_id: c.clientId.trim(),
    client_secret: c.clientSecret.trim(),
    refresh_token: c.refreshToken!,
    grant_type: 'refresh_token',
  });
  await saveStrava({ ...c, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_at });
  return t.access_token;
}

export async function disconnect(): Promise<StravaConfig> {
  const c = await loadStrava();
  if (c.accessToken) {
    // best effort: revoke on Strava's side too
    await fetch(DEAUTH_URL, { method: 'POST', body: new URLSearchParams({ access_token: c.accessToken }) }).catch(() => {});
  }
  const next: StravaConfig = { clientId: c.clientId, clientSecret: c.clientSecret };
  await saveStrava(next);
  return next;
}

/** Strava error bodies look like {message, errors:[{resource, field, code}]}. */
function describeError(json: any): string {
  if (!json || typeof json !== 'object') return 'unknown error';
  const parts = [json.message, ...(Array.isArray(json.errors) ? json.errors.map((e: any) => [e.resource, e.field, e.code].filter(Boolean).join(' ')) : [])];
  return parts.filter(Boolean).join(': ') || 'unknown error';
}

interface UploadResponse {
  id: number;
  error: string | null;
  status: string;
  activity_id: number | null;
}

/**
 * Interprets an upload status. Strava processes uploads asynchronously:
 * pending → activity_id, or an error. A ride that's already on Strava comes back
 * as "… duplicate of activity 123", which we treat as success.
 */
export function interpretUpload(u: Pick<UploadResponse, 'error' | 'activity_id'>): StravaUploadState | null {
  if (u.activity_id) return { status: 'done', activityId: u.activity_id };
  if (u.error) {
    const dup = /duplicate of (?:<a[^>]*>)?\s*(?:activity\s*)?(\d+)/i.exec(u.error);
    if (dup) return { status: 'done', activityId: Number(dup[1]) };
    return { status: 'error', error: u.error.replace(/<[^>]+>/g, '') };
  }
  return null; // still processing
}

export const activityUrl = (id: number) => `https://www.strava.com/activities/${id}`;

/** Uploads a FIT file and waits (up to ~1 min) for Strava to turn it into an activity. */
export async function uploadFit(
  fit: Uint8Array,
  meta: { name: string; description?: string; externalId: string; fileName: string },
): Promise<StravaUploadState> {
  const token = await accessToken();
  const form = new FormData();
  form.append('file', new Blob([fit], { type: 'application/octet-stream' }), meta.fileName);
  form.append('data_type', 'fit');
  form.append('name', meta.name);
  if (meta.description) form.append('description', meta.description);
  form.append('trainer', '1');
  form.append('external_id', meta.externalId);
  const res = await fetch(`${API}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Strava rejected the sign-in. Disconnect and connect again in Settings.');
    throw new Error(`Strava upload failed (${res.status}): ${describeError(json)}`);
  }
  let u = json as UploadResponse;
  for (let i = 0; i < 30; i++) {
    const r = interpretUpload(u);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, i < 5 ? 1000 : 2000));
    const p = await fetch(`${API}/uploads/${u.id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!p.ok) throw new Error(`Strava upload status check failed (${p.status})`);
    u = (await p.json()) as UploadResponse;
  }
  return { status: 'error', error: 'Strava is still processing the upload. Check your Strava feed in a few minutes.' };
}

/**
 * Changes an uploaded activity. Strava's API can rename an activity and mute it
 * (hide_from_home: kept out of followers' feeds), but it can't set "Only You"
 * visibility or delete it; those are only possible on strava.com.
 */
export async function updateActivity(id: number, changes: { name?: string; hide_from_home?: boolean }): Promise<void> {
  const token = await accessToken();
  const res = await fetch(`${API}/activities/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('That activity is no longer on Strava.');
    throw new Error(`Strava update failed (${res.status}): ${describeError(json)}`);
  }
}
