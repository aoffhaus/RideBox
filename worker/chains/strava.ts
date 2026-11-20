/**
 * Minimal Strava API v3 client for the chain tracker: token refresh, athlete
 * bikes, activity paging. Sign-in itself is RideBox's (worker/strava.ts).
 *
 * Verified against developers.strava.com (Oct 2026):
 * - Base URL is https://www.strava.com/api/v3. The changelog says
 *   https://api-v3.strava.com becomes available Jan 4, 2027. Switch API_BASE then.
 * - Refresh tokens rotate. When a new one comes back, the old one stops working,
 *   so every new one is saved through the TokenStore.
 * - Rate-limit headers are X-RateLimit-* and X-ReadRateLimit-*. Each holds
 *   "15min,daily". A 429 means the limit was exceeded.
 */

export const API_BASE = "https://www.strava.com/api/v3";
export const OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token";
export const PER_PAGE = 200;

export class StravaError extends Error {}

export class NotConnected extends StravaError {}

export class RateLimited extends StravaError {
  constructor(
    public retryAfter: Date,
    message: string,
  ) {
    super(message);
  }
}

export interface RateUsage {
  short_used: number;
  short_limit: number;
  daily_used: number;
  daily_limit: number;
}

function parsePair(value: string | null): [number, number] | null {
  if (!value) return null;
  const parts = value.split(",").map((x) => Number.parseInt(x, 10));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1]];
}

/** Prefer the read limit, which is what every call here counts against. */
export function parseRateHeaders(headers: Headers): RateUsage | null {
  for (const prefix of ["X-ReadRateLimit", "X-RateLimit"]) {
    const limit = parsePair(headers.get(`${prefix}-Limit`));
    const used = parsePair(headers.get(`${prefix}-Usage`));
    if (limit && used) {
      return { short_used: used[0], short_limit: limit[0], daily_used: used[1], daily_limit: limit[1] };
    }
  }
  return null;
}

/** When the exhausted window resets: next quarter hour, or midnight UTC for the daily cap. */
export function nextReset(u: RateUsage | null, now: Date = new Date()): Date {
  if (u && u.daily_used >= u.daily_limit) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }
  const d = new Date(now);
  d.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15 + 15, 0, 0);
  return d;
}

export interface Tokens {
  refresh_token: string;
  access_token: string;
  /** Epoch seconds. */
  expires_at: number;
}

export interface TokenStore {
  load(): Promise<Partial<Tokens> | null>;
  save(tokens: Tokens): Promise<void>;
}

export interface StravaActivity {
  id: number;
  gear_id?: string | null;
  start_date: string;
  distance?: number;
  moving_time?: number;
  name?: string;
  sport_type?: string;
  type?: string;
  trainer?: boolean;
}

export interface StravaApi {
  bikes(): Promise<{ bike_id: string; name: string }[]>;
  /** One page of activities starting after `after`. */
  activitiesPage(after: Date, page: number): Promise<StravaActivity[]>;
}

type Fetch = typeof fetch;

export class StravaClient implements StravaApi {
  private tokens: Partial<Tokens> | null = null;
  lastUsage: RateUsage | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private store: TokenStore,
    private fetchFn: Fetch = (...args) => fetch(...args),
  ) {}

  private async refresh(): Promise<string> {
    const refreshToken = this.tokens?.refresh_token;
    if (!refreshToken) throw new NotConnected("Strava isn't connected yet. Connect it in Settings.");
    const resp = await this.fetchFn(OAUTH_TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (resp.status === 400 || resp.status === 401) {
      throw new NotConnected(`Strava rejected the saved token (${resp.status}). Reconnect Strava in Settings.`);
    }
    if (!resp.ok) {
      throw new StravaError(`Token refresh failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    }
    const data = (await resp.json()) as Tokens;
    const tokens: Tokens = {
      refresh_token: data.refresh_token || refreshToken,
      access_token: data.access_token,
      expires_at: Number(data.expires_at),
    };
    this.tokens = tokens;
    await this.store.save(tokens);
    return tokens.access_token;
  }

  private async token(force = false): Promise<string> {
    if (this.tokens === null) this.tokens = (await this.store.load()) ?? {};
    const t = this.tokens;
    if (!force && t.access_token && (t.expires_at ?? 0) - Date.now() / 1000 > 300) return t.access_token;
    return this.refresh();
  }

  private async request(path: string, params: Record<string, string | number>, forceToken = false) {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return this.fetchFn(url, { headers: { Authorization: `Bearer ${await this.token(forceToken)}` } });
  }

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const u = this.lastUsage;
    if (u && (u.short_used >= u.short_limit - 2 || u.daily_used >= u.daily_limit - 2)) {
      // Stop just short of the cap rather than burning a request on a 429.
      throw new RateLimited(nextReset(u), "Close to the Strava rate limit; pausing sync.");
    }
    let resp = await this.request(path, params);
    this.lastUsage = parseRateHeaders(resp.headers) ?? this.lastUsage;
    if (resp.status === 429) throw new RateLimited(nextReset(this.lastUsage), "Strava rate limit reached.");
    if (resp.status === 401) {
      // Token may have been revoked or expired early; try one forced refresh.
      resp = await this.request(path, params, true);
      this.lastUsage = parseRateHeaders(resp.headers) ?? this.lastUsage;
    }
    if (!resp.ok) {
      throw new StravaError(`GET ${path} failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  }

  async bikes() {
    const athlete = await this.get<{ bikes?: { id: string; name?: string }[] }>("/athlete");
    return (athlete.bikes ?? []).map((b) => ({ bike_id: b.id, name: b.name || b.id }));
  }

  activitiesPage(after: Date, page: number) {
    return this.get<StravaActivity[]>("/athlete/activities", {
      after: Math.floor(after.getTime() / 1000),
      page,
      per_page: PER_PAGE,
    });
  }
}
