# RideBox 🚴

A free, personal indoor-training app for **Chrome on macOS**. It connects to a **Wahoo KICKR Core** (or any FTMS smart trainer) and a **Bluetooth heart-rate strap**. You ride structured workouts in **ERG mode** on a generated 3D road, chasing **arches** that mark the end of each interval, or free-ride with the trainer simulating the hills.

There are no social features or game mechanics. RideBox runs on your own private Cloudflare site: only you can sign in (Cloudflare Access), and your rides, workouts, calendar and settings sync across every browser you use. You can upload finished rides to Strava with one click.

## Using it

1. Open the site in **Chrome** (Web Bluetooth is not available in Safari).
2. Click **Connect trainer** → pick your KICKR, then **Connect HRM** → pick your strap.
   macOS asks once whether Chrome can use Bluetooth (System Settings → Privacy & Security → Bluetooth).
3. On **Ride**, pick a workout (or Free ride) and a route, then **Start ride**. The workout clock starts when you pedal.
   Pick **Portal Run** as the route to turn every interval gate of an ERG workout into a portal: ride through it and you land at a random spot in a random world (never the one you're in). Portals only open while ERG holds your power, so the jump in gradient is never felt; the last gate (the finish) is an ordinary arch, and the saved ride is named after the workout.
4. After the ride, rename it if you like and click **Upload to Strava** (once connected, see below), or delete it. **Garmin Connect ↗** downloads the .fit and opens Garmin Connect's Import Data page so you can drop it in (Garmin has no upload API for personal apps). You can also download the **.fit** and upload it to intervals.icu, TrainingPeaks, or TrainerRoad.

No trainer nearby? Click **Simulator** to try everything with a fake trainer and heart-rate strap.

### During a ride

| Key | Action |
| --- | --- |
| Space | Pause / resume (it also auto-pauses when you stop pedaling) |
| Esc | End ride (asks to confirm) |
| 1 / 2 / 3 | Camera: chase (default, Zwift-style) / close chase / first person |
| `+` / `−` or ↑ / ↓ | Workout intensity ±1% |
| → | Skip to the next interval |
| L | Extend the current interval by 1 minute |
| E | ERG on/off (off = SIM/slope mode, you hold the power) |
| K | Manual lap (free ride) |
| `[` / `]` | Simulator power −/+ 10 W |

The **mini map** (top right) turns with you so your direction is always up. The road from you to the next interval's start is drawn in your current interval's color, with a pulsing marker and countdown where the next one begins. Later intervals follow in their zone colors, and the bar underneath fills as the current interval progresses.

The arch ahead of you sits where you'll be when the current interval ends. Its position is recalculated continuously from your speed, so you ride through it exactly as the interval finishes. The arch's color is the power zone of the next interval. A faint second arch marks the end of the interval after that.

## Strava upload

On your private Cloudflare site, Strava is held by the server: your Strava API app's secret is a Worker secret, the Worker keeps your Strava sign-in, and the browser never sees either. One-time setup:

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an app (any name, category and website).
2. Set **Authorization Callback Domain** to your RideBox host, e.g. `ridebox.<you>.workers.dev`.
3. In the Cloudflare dashboard → Workers & Pages → **ridebox** → Settings → Variables and Secrets, add the secrets `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` from that Strava page.
4. In RideBox **Settings → Strava**, click **Connect Strava** and allow uploads and reading your activities.

(Running RideBox without the Worker, e.g. `npm run dev`, falls back to pasting the Client ID and Secret into Settings; they then stay in that browser.)

Nothing uploads automatically. On a ride's summary (open it from History any time):

- **Rename** it by clicking the title. If the ride is already on Strava, the activity is renamed too.
- **Upload to Strava** sends it as a virtual (trainer) ride with one lap per interval. Tick **Hide from followers' feeds** to mute it.
- **Delete ride** removes it from RideBox.

Strava's API doesn't let apps upload an activity as *Only You*. To keep uploads private, set Strava's **Privacy Controls → Activities** to *Only You* (new uploads use that default). Re-uploading a ride that's already on Strava links the existing activity rather than creating a duplicate.


## Calendar, plans and the Claude coach

- **Calendar** (month and week views): drag workouts to move them (hold Alt/⌥ to copy), **+** on a day adds one from your library, and clicking a workout lets you ride it, make it easier or harder, move, skip, add a note or remove it. Rides (RideBox and Strava) link to that day's workout automatically; unridden past workouts show as missed. The right-hand column shows each week's planned vs. done TSS and hours.
- **Fitness**: fitness (CTL), fatigue (ATL) and form (TSB) from your RideBox rides and imported Strava activities, with a projection from your calendar, weekly TSS, your FTP with W/kg and an FTP history chart (log a new FTP or weight, dated, right there), and **progression levels**: how hard a workout you can handle in each zone (1–10). Every workout shows its zone, level and how it compares with yours (Easy / Productive / Challenging / Very hard). Workouts ridden in other apps count too: a Strava ride named after a workout in your library or calendar (e.g. "Zwift - TrainerRoad: Warlow -1" or "Warlow -1") is rated as that workout and judged by its normalized power against the plan.
- **Claude coach** (on your private Cloudflare site, using your `ANTHROPIC_API_KEY`):
  - **Build a plan** (Calendar): goal, event date, hours per week and minutes per day. The coach writes the first three weeks in detail, and offers to plan the following weeks as you go so they match how training is going.
  - **Adjust with coach**: after missed workouts or a hard ride, the coach proposes swaps, moves and additions with a reason for each. Nothing changes until you accept (all or some).
  - **What should I ride today?** (Ride tab): time available plus how you feel gives one to three options.
  - After each ride, **How did it feel?** on the summary feeds levels and adaptations.
  - Requests stream the coach's reasoning while it works. A daily cap (`COACH_DAILY_LIMIT` in `wrangler.jsonc`, default 40) guards against runaway cost; a new plan typically costs well under a dollar with Claude Opus, and a daily pick a few cents.

## Claude connector (chat with your training in Claude)

RideBox is also an MCP server, so you can add it to Claude (claude.ai on the web, desktop or phone, and Claude Code) as a **custom connector**. Then you can talk through your training in any Claude chat, and Claude can change things directly.

- **Read:** today's fitness, fatigue and form, FTP and its estimate, progression levels, weekly history, the active plan and its weekly targets, the calendar, rides with per-interval results, Strava activities, and your workout library.
- **Change:** schedule, move, replace, skip, remove, or make a workout easier or harder; add notes; save new workouts to the library; create or edit plans; update FTP, weight or max HR.
- Changes save straight away and reach your browsers on their next sync (when the tab gets focus, or within 5 minutes). New workouts go through the same checks as the in-app coach's. Every change is logged, so you can ask Claude to "list recent changes" or "undo that".
- It uses your Claude subscription, not `ANTHROPIC_API_KEY`, and the in-app coach keeps working as before.

Dates use your time zone: the app saves it the first time it opens after this update (`RIDER_TIMEZONE` in `wrangler.jsonc` is an optional fallback until then).

**One-time setup** (after deploying):

1. **Let Claude reach the connector's endpoints past Cloudflare Access.** Claude's servers call these, not your browser, so they use OAuth tokens instead of an Access sign-in. In the Cloudflare dashboard → **Zero Trust** → **Access controls** → **Applications** → **Create new application** → **Self-hosted**. Name it something like *RideBox connector (public)* and add three public hostnames. For each one set **Subdomain** to `ridebox` (the Worker's name), **Domain** to `<your-subdomain>.workers.dev`, and **Path** to one of these (lowercase, exactly as written):
   - `mcp`
   - `oauth/*`
   - `.well-known/*`

   Give it one policy: **Action: Bypass**, **Include: Everyone**. Leave the main RideBox Access application as it is, so `/authorize` (the page where you approve Claude) and the rest of the site still need your Access sign-in. If you protect the Worker from its **Access** tab (*Protect this Worker*) instead of the workers.dev hostname, add the bypass there in the same way.
2. **Add the connector in Claude:** claude.ai → **Settings** → **Connectors** → **Add custom connector**. Name it *RideBox*, and set the URL to `https://ridebox.<your-subdomain>.workers.dev/mcp`. Click **Connect**: you sign in through Cloudflare Access as usual, see which app is asking, and click **Allow**. Turn it on in a chat from the tools menu.

No new secrets are needed: the connector uses the existing `ALLOWED_EMAILS` (removing your email there cuts it off at once) and keeps its sign-ins in D1 (migration `0005_mcp.sql`, applied by the deploy). A connection lasts as long as you use it at least every 60 days. To disconnect, remove the connector in Claude.

## Getting workouts in

- **TrainerRoad:** in **Settings**, drag the **TR → RideBox** bookmarklet to your bookmarks bar. Open any workout on trainerroad.com while logged in and click it. It copies the workout JSON to your clipboard; paste it into the box on the **Workouts** tab. (If the browser blocks clipboard access, it downloads `TR - <name>.json` instead; drop that file on the Workouts tab.) It uses the undocumented endpoint TrainerRoad's own page uses (the same one the open-source *trzwo* extension uses), so it could break if TrainerRoad changes its site.
- **Files:** `.zwo` (Zwift), `.erg` (watts), `.mrc` (% FTP), and RideBox `.json`.
- **Claude:** copy the prompt from **Settings → Workouts from Claude**, describe the session you want, and paste Claude's answer into the Workouts tab.
- **Builder:** build workouts from blocks, or type shorthand:

  ```
  # Over-unders
  10m 45-70%
  3x(2m @95%, 1m @108% "Over", 5m @50%)
  5m @150w
  5m free
  10m 60-40%
  ```

### RideBox JSON

```json
{
  "name": "Threshold 2x20",
  "steps": [
    { "type": "ramp", "duration": "10m", "from": 45, "to": 70 },
    { "type": "repeat", "count": 2, "steps": [
      { "type": "steady", "duration": "20m", "power": 97, "cadence": 90,
        "cues": [{ "at": "15m", "text": "5 min to go" }] },
      { "type": "steady", "duration": "5m", "power": 50 }
    ]},
    { "type": "ramp", "duration": "10m", "from": 60, "to": 40 }
  ]
}
```

- `power`, `from`, and `to` are a % of FTP. Use `watts`, `fromWatts`, and `toWatts` for absolute watts.
- Durations are given in seconds or as `"30s"`, `"5m"`, or `"1h10m"`.
- Step types are `steady`, `ramp`, `repeat`, and `free`.

## Chain tracker

The **Chains** tab (on a phone, the chain icon in the tab bar) tracks chain rotation, quick links and lubes per bike, counted from your Strava rides. It used to be a separate app (`aoffhaus/chain-tracker`) and now runs inside RideBox on your private Cloudflare site.

- **Bikes**: the installed chain on each bike, miles and hours since the swap and since the last lube, and **Swap chain** / **Log lube** buttons. Bikes without rotated chains only track miles since their last lube.
- **Chains**: each chain's lifetime miles and hours (including starting miles), install periods and quick-link uses.
- **History**: every swap and lube, editable.
- **Setup**: add or edit chains, record quick links, choose which bikes rotate chains, assign untagged virtual rides to a bike, sync with Strava, and download a backup.

A ride counts toward whichever chain was installed on its bike (matched by Strava's bike tag) when the ride started. The Worker pulls rides from Strava every 30 minutes (a Cron Trigger), and when you open the tab if the last sync is more than 15 minutes old. Each sync re-pulls the last 30 days, so edits and deletions on Strava are picked up.

It uses RideBox's own Strava connection. Reading your bikes needs Strava's "View data about your private profile" permission, so if you connected Strava before the chain tracker was added, click **Reconnect Strava** once (Settings, or Chains → Setup). Its data lives in RideBox's D1 database in tables prefixed `ct_` (migration `worker/migrations/0004_chain_tracker.sql`).

## Trainer details

- **FTMS** (`0x1826`): Indoor Bike Data provides power, cadence, and speed. The Control Point handles ERG (*Set Target Power*) and SIM (*Set Indoor Bike Simulation*).
- **Fallback for older KICKR firmware:** Cycling Power for data plus Wahoo's own control characteristic for ERG and grade.
- **SIM mode** sends the road grade scaled by **Trainer difficulty** (Settings, default 50%). The KICKR Core has a real cassette, so shift as normal.
- Only one app can control the KICKR at a time, so close Zwift, the Wahoo app, and TrainerRoad first.

## Development

```bash
npm install
npm run dev      # http://localhost:5173 (Web Bluetooth works on localhost)
npm test         # unit tests: parsers, engine, BLE packets, physics, arches, FIT export
npm run build
```

Every push to `main` runs the tests and deploys to Cloudflare via `.github/workflows/deploy.yml` (once the repo secrets below are set).

To run the full private site locally (Worker, sync API, local database), put `DEV_NO_AUTH=1` in a `.dev.vars` file (git-ignored; it only works on localhost) and run `npm run worker:dev` → http://localhost:8787.

## Hosting on Cloudflare (private, password-protected)

RideBox is served by a Cloudflare Worker (`worker/`) with a D1 database for sync (large rides are stored in chunks). **Cloudflare Access** puts a login screen in front of the entire site, so nobody else can see your rides or workouts or use your Claude and Strava connections. As a second line of defense the Worker checks the Access sign-in on every request and serves nothing if Access isn't set up (it fails closed). The only exceptions are the Claude connector's OAuth and `/mcp` endpoints, which require their own OAuth tokens instead (see *Claude connector*).

One-time setup:

1. **Cloudflare account** with your domain added (any domain you own; the free plan is fine).
2. **Create the database** (from this repo, after `npm install`):
   ```bash
   npx wrangler login
   npx wrangler d1 create ridebox          # paste the printed database_id into wrangler.jsonc
   ```
3. **Deploy once:** `npm run deploy`. The site is served at `ridebox.<your-subdomain>.workers.dev` (preview URLs are off in `wrangler.jsonc`). You can add a custom domain later under Workers & Pages → **ridebox** → Settings → Domains & Routes; protect it with Access too.
4. **Turn on Cloudflare Access:** Workers & Pages → **ridebox** → Settings → Domains & Routes → workers.dev → **Enable Cloudflare Access** (or Zero Trust → Access → Applications → Add → *Self-hosted* for a custom domain). Allow only yourself (your account, or Include → Emails → your email) and set the session to about a month so you don't sign in before every ride. Copy the application's **Audience (AUD) tag**, and note your team domain (`<team>.cloudflareaccess.com`, under Zero Trust → Settings).
5. **Secrets** (never committed):
   ```bash
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. yourteam.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD           # the AUD tag from step 4
   npx wrangler secret put ALLOWED_EMAILS       # your email (comma-separate to add more)
   npx wrangler secret put ANTHROPIC_API_KEY    # for the Claude coach
   npx wrangler secret put STRAVA_CLIENT_ID     # see "Strava upload"
   npx wrangler secret put STRAVA_CLIENT_SECRET
   ```
6. **Automatic deploys:** in GitHub → Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` (the *Edit Cloudflare Workers* template plus *D1: Edit*) and `CLOUDFLARE_ACCOUNT_ID`.
7. **Move your data, then retire the old public copy.** Browsers keep data per site address, so rides saved on the GitHub Pages copy don't appear on the new domain by themselves:
   - Open the old GitHub Pages site → **Settings → Backup & moving → Download backup**.
   - Open your private RideBox site → **Settings → Load backup…** and pick that file. It syncs up right away.
   - GitHub → Settings → Pages → *Unpublish site*, then add the repo variable `PAGES_RETIRED` = `true` (Settings → Secrets and variables → Actions → Variables) so the workflow stops publishing it.
   - Change your Strava API app's callback domain to your private site's host (e.g. `ridebox.<you>.workers.dev`) and reconnect Strava in RideBox Settings.

After that, every browser you sign in from pulls the same data. Every other browser then pulls the same data. The **✓ Synced** chip at the top right shows the sync state; click it to sync now.

Visuals: the world is drawn with **grade exaggeration** (Settings, default 1.8×) so climbs and descents read clearly on screen, like Zwift. It's visual only: trainer resistance, speed and the grade readout use the true gradient.

Built with Vite, React, TypeScript, Three.js, idb, and the Garmin FIT SDK.
