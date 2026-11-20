// Cloudflare Access verification.
//
// Cloudflare Access sits in front of the whole site and only lets the owner in.
// As a second line of defense the Worker checks the signed token Access attaches
// to every request (Cf-Access-Jwt-Assertion header / CF_Authorization cookie),
// so a request that somehow skips Access (a misconfigured route, a workers.dev
// URL left on) still can't read rides or spend Claude credits.

export interface AuthEnv {
  /** e.g. "yourteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string;
  /** the Access application's "Application Audience (AUD) Tag" */
  ACCESS_AUD?: string;
  /** comma-separated emails allowed in (a secret, so it never lands in the repo) */
  ALLOWED_EMAILS?: string;
  /** "1" in .dev.vars only: skip the check for `wrangler dev` on localhost */
  DEV_NO_AUTH?: string;
}

export type AuthResult = { ok: true; email: string } | { ok: false; status: number; reason: string };

interface Jwk extends JsonWebKey {
  kid: string;
}

type KeySource = (teamDomain: string, refresh: boolean) => Promise<Map<string, CryptoKey>>;

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

let cache: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;

/** Fetches (and caches for an hour) the team's public signing keys. */
export const fetchAccessKeys: KeySource = async (team, refresh) => {
  if (!refresh && cache && cache.team === team && Date.now() - cache.at < 3600_000) return cache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (k.kty !== 'RSA') continue;
    map.set(k.kid, await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cache = { team, at: Date.now(), keys: map };
  return map;
};

function tokenFrom(req: Request): string | null {
  const h = req.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('Cookie') ?? '');
  return m ? m[1] : null;
}

/** ALLOWED_EMAILS as a lower-cased list. */
export function allowedEmails(env: AuthEnv): string[] {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

const isLocal = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

export async function verifyAccess(req: Request, env: AuthEnv, keys: KeySource = fetchAccessKeys, now = Date.now()): Promise<AuthResult> {
  if (env.DEV_NO_AUTH === '1' && isLocal(new URL(req.url))) return { ok: true, email: 'dev@localhost' };

  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const allowed = allowedEmails(env);
  // fail closed: an unconfigured deployment serves nothing
  if (!team || !aud || !allowed.length) return { ok: false, status: 503, reason: 'Cloudflare Access is not configured for this site yet.' };

  const token = tokenFrom(req);
  if (!token) return { ok: false, status: 401, reason: 'Sign in through Cloudflare Access.' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, reason: 'Malformed token.' };

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return { ok: false, status: 401, reason: 'Malformed token.' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, status: 401, reason: 'Unexpected token algorithm.' };

  let keyMap = await keys(team, false);
  if (!keyMap.has(header.kid)) keyMap = await keys(team, true); // keys rotate
  const key = keyMap.get(header.kid);
  if (!key) return { ok: false, status: 401, reason: 'Unknown signing key.' };

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), signed);
  if (!valid) return { ok: false, status: 401, reason: 'Bad token signature.' };

  const sec = now / 1000;
  if (typeof payload.exp !== 'number' || payload.exp < sec) return { ok: false, status: 401, reason: 'Session expired. Reload to sign in again.' };
  if (typeof payload.nbf === 'number' && payload.nbf > sec + 60) return { ok: false, status: 401, reason: 'Token not valid yet.' };
  if (payload.iss !== `https://${team}`) return { ok: false, status: 401, reason: 'Wrong token issuer.' };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, status: 401, reason: 'Token is for a different application.' };
  const email = payload.email?.toLowerCase();
  if (!email || !allowed.includes(email)) return { ok: false, status: 403, reason: 'This account is not allowed.' };
  return { ok: true, email };
}
