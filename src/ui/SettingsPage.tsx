import { useState } from 'react';
import type { Settings } from '../storage/db';
import { BOOKMARKLET } from './bookmarklet';
import { CLAUDE_PROMPT } from './claudePrompt';

export function SettingsPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [s, setS] = useState(settings);
  const [copied, setCopied] = useState('');
  const num = (k: keyof Settings, label: string, step = 1, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} value={s[k] as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  const imperial = s.units === 'imperial';
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(''), 2000);
  };
  return (
    <div className="page narrow">
      <h2>Rider</h2>
      <div className="fields">
        {num('ftp', 'FTP (W)')}
        <label className="field">
          <span>Weight ({imperial ? 'lb' : 'kg'})</span>
          <input
            type="number"
            value={imperial ? Math.round(s.riderKg * 2.20462) : s.riderKg}
            onChange={(e) => setS({ ...s, riderKg: imperial ? Number(e.target.value) / 2.20462 : Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span>Bike weight ({imperial ? 'lb' : 'kg'})</span>
          <input
            type="number"
            value={imperial ? Math.round(s.bikeKg * 2.20462) : s.bikeKg}
            onChange={(e) => setS({ ...s, bikeKg: imperial ? Number(e.target.value) / 2.20462 : Number(e.target.value) })}
          />
        </label>
        {num('maxHr', 'Max heart rate (bpm)')}
        <label className="field">
          <span>Units</span>
          <select value={s.units} onChange={(e) => setS({ ...s, units: e.target.value as Settings['units'] })}>
            <option value="imperial">Imperial (mi, mph, ft)</option>
            <option value="metric">Metric (km, km/h, m)</option>
          </select>
        </label>
        <label className="field">
          <span>Trainer difficulty: {s.simDifficulty}%</span>
          <input type="range" min={0} max={100} value={s.simDifficulty} onChange={(e) => setS({ ...s, simDifficulty: Number(e.target.value) })} />
          <small className="muted">How much of the road grade the KICKR applies in free rides / SIM mode (like Zwift&apos;s trainer difficulty). Shift your real gears as usual.</small>
        </label>
        {num('cda', 'CdA (m²)', 0.01, 'Aero drag for virtual speed: 0.32 hoods, 0.28 drops')}
      </div>
      <button className="primary" onClick={() => onSave(s)}>Save settings</button>

      <h2>TrainerRoad workouts</h2>
      <ol className="steps">
        <li>
          Drag this button to your bookmarks bar: <a className="bookmarklet" ref={(el) => el?.setAttribute('href', BOOKMARKLET)} onClick={(e) => e.preventDefault()}>⬇ TR → RideBox</a>
        </li>
        <li>On trainerroad.com, while logged in, open a workout page (Workouts → pick one).</li>
        <li>Click the bookmark. It downloads <code>TR - Name.json</code>.</li>
        <li>Drop that file on the <b>Workouts</b> tab.</li>
      </ol>
      <p className="muted small">
        It uses the same (undocumented) data TrainerRoad&apos;s own page loads, so it may break if TrainerRoad changes their site. If it does, you can still import <code>.zwo</code>/<code>.mrc</code> files or type the workout in the builder.
      </p>

      <h2>Workouts from Claude</h2>
      <p className="muted">Copy this prompt into Claude, describe the session you want, then paste Claude&apos;s answer on the Workouts tab.</p>
      <pre className="prompt">{CLAUDE_PROMPT}</pre>
      <button onClick={() => copy(CLAUDE_PROMPT, 'prompt')}>{copied === 'prompt' ? 'Copied ✓' : 'Copy prompt'}</button>

      <h2>Tips</h2>
      <ul className="muted small">
        <li>Use Chrome. The first time you connect, macOS will ask to let Chrome use Bluetooth (System Settings → Privacy &amp; Security → Bluetooth).</li>
        <li>Close Zwift, the Wahoo app, and TrainerRoad on other devices: the KICKR accepts only one controller at a time.</li>
        <li>If ERG doesn&apos;t respond, update the KICKR Core firmware in the Wahoo app (newer firmware adds FTMS).</li>
        <li>Your data stays in this browser (IndexedDB). Clearing site data deletes your rides and imported workouts.</li>
      </ul>
    </div>
  );
}
