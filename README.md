# RideBox 🚴

A free, personal indoor-training app for **Chrome on macOS**. It connects to a **Wahoo KICKR Core** (or any FTMS smart trainer) and a **Bluetooth heart-rate strap**. You ride structured workouts in **ERG mode** on a generated 3D road, chasing **arches** that mark the end of each interval, or free-ride with the trainer simulating the hills.

There are no accounts, servers, social features, or game mechanics. Everything runs in your browser. You can upload finished rides to Strava with one click.

## Using it

1. Open the site in **Chrome** (Web Bluetooth is not available in Safari).
2. Click **Connect trainer** → pick your KICKR, then **Connect HRM** → pick your strap.
   macOS asks once whether Chrome can use Bluetooth (System Settings → Privacy & Security → Bluetooth).
3. On **Ride**, pick a workout (or Free ride) and a route, then **Start ride**. The workout clock starts when you pedal.
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

RideBox has no server, so you connect Strava through your own free Strava API app (one-time setup):

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an app (any name, category and website).
2. Set **Authorization Callback Domain** to the host RideBox is served from, e.g. `yourname.github.io` (or `localhost` for `npm run dev`).
3. In RideBox **Settings → Strava**, paste the app's **Client ID** and **Client Secret** and click **Connect Strava**. Allow uploads on Strava's page.

Nothing uploads automatically. On a ride's summary (open it from History any time):

- **Rename** it by clicking the title. If the ride is already on Strava, the activity is renamed too.
- **Upload to Strava** sends it as a virtual (trainer) ride with one lap per interval. Tick **Hide from followers' feeds** to mute it.
- **Delete ride** removes it from RideBox.

Strava's API doesn't let apps upload an activity as *Only You*. To keep uploads private, set Strava's **Privacy Controls → Activities** to *Only You* (new uploads use that default). Re-uploading a ride that's already on Strava links the existing activity rather than creating a duplicate.

The client secret and tokens stay in the browser's IndexedDB and are only sent to strava.com.

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

Every push to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`. In the repo, set **Settings → Pages → Source** to **GitHub Actions**.

Visuals: the world is drawn with **grade exaggeration** (Settings, default 1.8×) so climbs and descents read clearly on screen, like Zwift. It's visual only: trainer resistance, speed and the grade readout use the true gradient.

Built with Vite, React, TypeScript, Three.js, idb, and the Garmin FIT SDK.
