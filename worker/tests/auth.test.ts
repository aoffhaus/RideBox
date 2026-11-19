import { describe, expect, it } from 'vitest';
import { verifyAccess } from '../auth';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: 'Rider@Example.com, other@example.com' };

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function keypair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

async function token(priv: CryptoKey, payload: Record<string, unknown>, kid = 'k1') {
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const now = 1_800_000_000_000;
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: now / 1000 + 600, email: 'rider@example.com' };
const req = (headers: Record<string, string> = {}, url = 'https://ride.example.com/api/me') => new Request(url, { headers });

describe('verifyAccess', async () => {
  const kp = await keypair();
  const keys = async () => new Map([['k1', kp.publicKey]]);

  it('accepts a valid Access token for an allowed email', async () => {
    const t = await token(kp.privateKey, good);
    expect(await verifyAccess(req({ 'Cf-Access-Jwt-Assertion': t }), env, keys, now)).toEqual({ ok: true, email: 'rider@example.com' });
  });

  it('reads the CF_Authorization cookie too', async () => {
    const t = await token(kp.privateKey, good);
    const r = await verifyAccess(req({ Cookie: `a=b; CF_Authorization=${t}` }), env, keys, now);
    expect(r.ok).toBe(true);
  });

  it('fails closed when Access is not configured', async () => {
    const r = await verifyAccess(req(), {}, keys, now);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it('rejects missing, expired, wrong-audience, wrong-issuer and disallowed tokens', async () => {
    expect(await verifyAccess(req(), env, keys, now)).toMatchObject({ ok: false, status: 401 });
    const cases = [
      { ...good, exp: now / 1000 - 1 },
      { ...good, aud: ['other'] },
      { ...good, iss: 'https://evil.cloudflareaccess.com' },
    ];
    for (const p of cases) {
      const t = await token(kp.privateKey, p);
      expect((await verifyAccess(req({ 'Cf-Access-Jwt-Assertion': t }), env, keys, now)).ok).toBe(false);
    }
    const stranger = await token(kp.privateKey, { ...good, email: 'stranger@example.com' });
    expect(await verifyAccess(req({ 'Cf-Access-Jwt-Assertion': stranger }), env, keys, now)).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a token signed by another key', async () => {
    const other = await keypair();
    const t = await token(other.privateKey, good);
    expect(await verifyAccess(req({ 'Cf-Access-Jwt-Assertion': t }), env, keys, now)).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a tampered payload', async () => {
    const t = await token(kp.privateKey, good);
    const [h, , s] = t.split('.');
    const forged = `${h}.${enc({ ...good, email: 'other@example.com' })}.${s}`;
    expect((await verifyAccess(req({ 'Cf-Access-Jwt-Assertion': forged }), env, keys, now)).ok).toBe(false);
  });

  it('only skips the check for localhost in dev mode', async () => {
    const dev = { DEV_NO_AUTH: '1' };
    expect((await verifyAccess(req({}, 'http://localhost:8787/api/me'), dev, keys, now)).ok).toBe(true);
    expect((await verifyAccess(req({}, 'https://ride.example.com/api/me'), dev, keys, now)).ok).toBe(false);
  });
});
