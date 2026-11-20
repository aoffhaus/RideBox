import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowed, freshToken, strava, type AuthStore, type StravaAuth } from '../strava';

const env = { DB: {} as D1Database, STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'shh' };
const memStore = (init: StravaAuth | null = null): AuthStore & { v: StravaAuth | null } => {
  const s = {
    v: init,
    get: async () => s.v,
    put: async (a: StravaAuth) => void (s.v = a),
    clear: async () => void (s.v = null),
  };
  return s;
};
const auth = (over: Partial<StravaAuth> = {}): StravaAuth => ({ access_token: 'A', refresh_token: 'R', expires_at: 2e9, athlete_name: 'Pat', scope: 'read,activity:write,activity:read_all', ...over });
const call = (path: string, init: RequestInit = {}, store = memStore(), e: typeof env | Record<string, unknown> = env) => {
  const url = new URL(`https://ride.example/api/strava/${path}`);
  return strava(e as typeof env, new Request(url, init), url, url.pathname.slice('/api/strava/'.length), store);
};

afterEach(() => vi.unstubAllGlobals());

describe('worker strava', () => {
  it('reports status without ever returning tokens', async () => {
    const res = await call('status', {}, memStore(auth()));
    const body = await res.json();
    expect(body).toEqual({ configured: true, connected: true, athleteName: 'Pat', scope: 'read,activity:write,activity:read_all' });
    expect(JSON.stringify(body)).not.toMatch(/"A"|"R"|shh/);
    expect(await (await call('status', {}, memStore(), { DB: env.DB })).json()).toMatchObject({ configured: false, connected: false });
  });

  it('starts the sign-in with a state cookie and the Worker callback', async () => {
    const res = await call('connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('redirect_uri')).toBe('https://ride.example/api/strava/callback');
    expect(loc.searchParams.get('scope')).toBe('activity:write,activity:read_all');
    expect(loc.searchParams.get('client_id')).toBe('123');
    expect(res.headers.get('Set-Cookie')).toContain(`ridebox_strava_state=${loc.searchParams.get('state')}`);
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
  });

  it('rejects a callback whose state does not match', async () => {
    const res = await call('callback?state=x&code=c&scope=activity:write', { headers: { Cookie: 'ridebox_strava_state=y' } });
    expect(res.headers.get('Location')).toContain('strava=error');
  });

  it('exchanges the code server-side and stores the tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'A2', refresh_token: 'R2', expires_at: 2e9, athlete: { firstname: 'Pat', lastname: 'Q' } })));
    vi.stubGlobal('fetch', fetchMock);
    const store = memStore();
    const res = await call('callback?state=s&code=c&scope=read,activity:write', { headers: { Cookie: 'ridebox_strava_state=s' } }, store);
    expect(res.headers.get('Location')).toBe('/?strava=connected');
    expect(store.v).toMatchObject({ access_token: 'A2', refresh_token: 'R2', athlete_name: 'Pat Q' });
    const body = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get('client_secret')).toBe('shh');
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('refuses a grant without upload permission', async () => {
    const res = await call('callback?state=s&code=c&scope=read', { headers: { Cookie: 'ridebox_strava_state=s' } });
    expect(decodeURIComponent(res.headers.get('Location')!)).toContain('permission');
  });

  it('refreshes an expiring token and keeps the new one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'R3', expires_at: 3e9 }))));
    const store = memStore(auth({ expires_at: 1000 }));
    expect(await freshToken(env, store, 1000 * 1000)).toBe('NEW');
    expect(store.v).toMatchObject({ access_token: 'NEW', refresh_token: 'R3', expires_at: 3e9 });
    expect(await freshToken(env, memStore(auth()), 0)).toBe('A');
  });

  it('only proxies the Strava endpoints RideBox uses, adding the token', async () => {
    expect(allowed('GET', 'athlete/activities')).toBe(true);
    expect(allowed('POST', 'uploads')).toBe(true);
    expect(allowed('GET', 'uploads/55')).toBe(true);
    expect(allowed('PUT', 'activities/9')).toBe(true);
    expect(allowed('DELETE', 'activities/9')).toBe(false);
    expect(allowed('GET', 'activities/9/streams')).toBe(true);
    expect(allowed('GET', 'activities/9/kudos')).toBe(false);
    expect(allowed('GET', 'athlete')).toBe(false);
    expect(allowed('GET', '../oauth/token')).toBe(false);
    expect((await call('proxy/athlete', {}, memStore(auth()))).status).toBe(403);

    const fetchMock = vi.fn(async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call('proxy/athlete/activities?after=1&page=2', {}, memStore(auth()));
    expect(res.status).toBe(200);
    const [u, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(u).toBe('https://www.strava.com/api/v3/athlete/activities?after=1&page=2');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer A');
  });

  it('says so when not connected or not configured', async () => {
    expect((await call('proxy/athlete/activities')).status).toBe(401);
    expect((await call('connect', {}, memStore(), { DB: env.DB })).status).toBe(503);
  });

  it('disconnects: revokes on Strava and forgets the tokens', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const store = memStore(auth());
    await call('disconnect', { method: 'POST' }, store);
    expect(store.v).toBeNull();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('deauthorize');
  });
});
