import { describe, expect, it } from "vitest";
import { NotConnected, nextReset, parseRateHeaders, StravaClient, type Tokens } from "../chains/strava";

describe("rate limits", () => {
  it("prefers the read limit headers", () => {
    const u = parseRateHeaders(
      new Headers({
        "X-RateLimit-Limit": "200,2000",
        "X-RateLimit-Usage": "10,100",
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "99,500",
      }),
    );
    expect(u).toEqual({ short_used: 99, short_limit: 100, daily_used: 500, daily_limit: 1000 });
  });

  it("resets at the next quarter hour, or midnight UTC for the daily cap", () => {
    const t = new Date(Date.UTC(2026, 9, 26, 18, 7));
    expect(nextReset({ short_used: 100, short_limit: 100, daily_used: 5, daily_limit: 1000 }, t)).toEqual(
      new Date(Date.UTC(2026, 9, 26, 18, 15)),
    );
    expect(nextReset({ short_used: 1, short_limit: 100, daily_used: 1000, daily_limit: 1000 }, t)).toEqual(
      new Date(Date.UTC(2026, 9, 27)),
    );
    expect(nextReset(null, new Date(Date.UTC(2026, 9, 26, 18, 50)))).toEqual(new Date(Date.UTC(2026, 9, 26, 19, 0)));
  });
});

describe("token handling", () => {
  function setup(initial: Partial<Tokens> | null) {
    const saved: Tokens[] = [];
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/oauth/token")) {
        const body = init!.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        return Response.json({ access_token: "acc2", refresh_token: "ref2", expires_at: Date.now() / 1000 + 21600 });
      }
      return Response.json({ bikes: [{ id: "b1", name: "Road" }] });
    }) as typeof fetch;
    const client = new StravaClient("id", "secret", { load: async () => initial, save: async (t) => void saved.push(t) }, fetchFn);
    return { client, saved, calls };
  }

  it("refreshes an expired token and saves the rotated refresh token", async () => {
    const { client, saved, calls } = setup({ refresh_token: "ref1", access_token: "old", expires_at: 0 });
    expect(await client.bikes()).toEqual([{ bike_id: "b1", name: "Road" }]);
    expect(saved[0].refresh_token).toBe("ref2");
    expect(calls[0]).toContain("/oauth/token");
  });

  it("reuses a valid access token without refreshing", async () => {
    const { client, saved, calls } = setup({ refresh_token: "ref1", access_token: "ok", expires_at: Date.now() / 1000 + 3600 });
    await client.bikes();
    expect(saved).toEqual([]);
    expect(calls.every((c) => !c.includes("/oauth/token"))).toBe(true);
  });

  it("reports not connected when there is no refresh token", async () => {
    const { client } = setup(null);
    await expect(client.bikes()).rejects.toBeInstanceOf(NotConnected);
  });
});
