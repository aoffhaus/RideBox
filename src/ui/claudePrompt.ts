export const CLAUDE_PROMPT = `Write me an indoor cycling workout in RideBox JSON format.

Goal: <describe it, e.g. "60 min threshold session, 2x20 at 95-100% FTP">

Format rules:
- Output ONLY a JSON object (no commentary) like:
{
  "name": "Threshold 2x20",
  "description": "Short purpose of the workout",
  "steps": [
    { "type": "ramp", "duration": "10m", "from": 45, "to": 70, "label": "Warm up" },
    { "type": "repeat", "count": 2, "steps": [
      { "type": "steady", "duration": "20m", "power": 97, "cadence": 90, "label": "Threshold",
        "cues": [{ "at": "0s", "text": "Settle in, smooth pedaling" }, { "at": "15m", "text": "5 min to go" }] },
      { "type": "steady", "duration": "5m", "power": 50, "label": "Recover" }
    ]},
    { "type": "ramp", "duration": "10m", "from": 60, "to": 40, "label": "Cool down" }
  ]
}
- "power", "from", "to" are % of FTP (integers like 95). Use "watts" / "fromWatts" / "toWatts" for absolute watts.
- "duration" is seconds (number) or a string like "30s", "5m", "1h10m".
- Step types: "steady", "ramp", "repeat" (with "count" and nested "steps"), "free" (no target).
- Optional per step: "cadence" (rpm target), "label", "cues" (text messages shown at "at" into the step).`;
