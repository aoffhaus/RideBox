import { afterEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('../src/storage/db', () => ({
  getFlag: async (k: string) => kv.get(k),
  setFlag: async (k: string, v: unknown) => void kv.set(k, v),
}));

import { updateActivity, authorizeUrl, completeOAuth, interpretUpload, loadStrava, parseOAuthReturn, redirectUri, uploadFit, DEFAULT_STRAVA } from '../src/strava/strava';

afterEach(() => {
  kv.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('strava oauth', () => {
  it('builds the authorize URL', () => {
    const u = new URL(authorizeUrl(' 12345 ', 'https://me.github.io/RideBox/'));
    expect(u.origin + u.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('12345');
    expect(u.searchParams.get('redirect_uri')).toBe('https://me.github.io/RideBox/');
    expect(u.searchParams.get('scope')).toBe('activity:write');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('ridebox-strava');
  });

  it('strips query and hash from the redirect URI', () => {
    expect(redirectUri({ origin: 'http://localhost:5173', pathname: '/' })).toBe('http://localhost:5173/');
  });

  it('parses the redirect back', () => {
    expect(parseOAuthReturn('?state=ridebox-strava&code=abc&scope=read,activity:write')).toEqual({ code: 'abc', scope: 'read,activity:write' });
    expect(parseOAuthReturn('?state=ridebox-strava&error=access_denied')).toEqual({ error: 'You declined access on Strava.' });
    expect(parseOAuthReturn('?code=abc')).toBeNull(); // not ours
    expect(parseOAuthReturn('')).toBeNull();
  });

  it('refuses a grant without upload permission', async () => {
    await expect(completeOAuth({ ...DEFAULT_STRAVA, clientId: '1', clientSecret: 's' }, { code: 'c', scope: 'read' })).rejects.toThrow(/permission/);
  });

  it('exchanges the code and stores tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_at: 2e9, athlete: { firstname: 'Pat', lastname: 'Q' } })));
    vi.stubGlobal('fetch', fetchMock);
    const c = await completeOAuth({ ...DEFAULT_STRAVA, clientId: '1', clientSecret: 's' }, { code: 'c', scope: 'read,activity:write' });
    expect(c).toMatchObject({ accessToken: 'A', refreshToken: 'R', athleteName: 'Pat Q' });
    expect((await loadStrava()).refreshToken).toBe('R');
    const body = (fetchMock.mock.calls[0] as any)[1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c');
  });
});

describe('strava upload', () => {
  it('interprets upload statuses', () => {
    expect(interpretUpload({ activity_id: null, error: null })).toBeNull();
    expect(interpretUpload({ activity_id: 42, error: null })).toEqual({ status: 'done', activityId: 42 });
    expect(interpretUpload({ activity_id: null, error: "r.fit duplicate of <a href='/activities/987'>987</a>" })).toEqual({ status: 'done', activityId: 987 });
    expect(interpretUpload({ activity_id: null, error: 'r.fit duplicate of activity 555' })).toEqual({ status: 'done', activityId: 555 });
    expect(interpretUpload({ activity_id: null, error: 'Error parsing <b>file</b>' })).toEqual({ status: 'error', error: 'Error parsing file' });
  });

  it('refreshes an expired token, uploads, and polls until done', async () => {
    vi.useFakeTimers();
    kv.set('strava', { ...DEFAULT_STRAVA, clientId: '1', clientSecret: 's', accessToken: 'old', refreshToken: 'R', expiresAt: 0 });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'R2', expires_at: 2e9 }));
        expect((init?.headers as any).Authorization).toBe('Bearer new');
        if (url.endsWith('/uploads')) {
          const f = init!.body as FormData;
          expect(f.get('data_type')).toBe('fit');
          expect(f.get('trainer')).toBe('1');
          expect(f.get('external_id')).toBe('ridebox-x');
          return new Response(JSON.stringify({ id: 7, status: 'Your activity is still being processed.', error: null, activity_id: null }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: 7, status: 'Your activity is ready.', error: null, activity_id: 99 }));
      }),
    );
    const p = uploadFit(new Uint8Array([1, 2, 3]), { name: 'Ride', externalId: 'ridebox-x', fileName: 'r.fit' });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ status: 'done', activityId: 99 });
    expect(calls).toEqual(['POST https://www.strava.com/oauth/token', 'POST https://www.strava.com/api/v3/uploads', 'GET https://www.strava.com/api/v3/uploads/7']);
    expect((await loadStrava()).refreshToken).toBe('R2');
  });

  it('fails clearly when not connected', async () => {
    await expect(uploadFit(new Uint8Array(), { name: 'x', externalId: 'y', fileName: 'z' })).rejects.toThrow(/Settings/);
  });
});

describe('strava activity update', () => {
  it('renames / mutes an activity with a JSON PUT', async () => {
    kv.set('strava', { ...DEFAULT_STRAVA, clientId: '1', clientSecret: 's', accessToken: 'A', refreshToken: 'R', expiresAt: 2e9 });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await updateActivity(99, { name: 'New name', hide_from_home: true });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('https://www.strava.com/api/v3/activities/99');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer A');
    expect(JSON.parse(init.body)).toEqual({ name: 'New name', hide_from_home: true });
  });

  it('reports a deleted activity', async () => {
    kv.set('strava', { ...DEFAULT_STRAVA, clientId: '1', clientSecret: 's', accessToken: 'A', refreshToken: 'R', expiresAt: 2e9 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await expect(updateActivity(1, { name: 'x' })).rejects.toThrow(/no longer on Strava/);
  });
});
