import { useState } from 'react';
import { authorizeUrl, disconnect, isConnected, redirectUri, saveStrava, type StravaConfig } from '../strava/strava';

/** Settings → Strava: API app credentials, connect / disconnect, auto-upload. */
export function StravaSettings({ config, onChange }: { config: StravaConfig; onChange: (c: StravaConfig) => void }) {
  const [clientId, setClientId] = useState(config.clientId);
  const [clientSecret, setClientSecret] = useState(config.clientSecret);
  const connected = isConnected(config);
  const callbackDomain = location.hostname;

  const update = async (c: StravaConfig) => {
    await saveStrava(c);
    onChange(c);
  };

  async function connect() {
    // save the credentials first: the page reloads when Strava sends us back
    await update({ ...config, clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    location.href = authorizeUrl(clientId);
  }

  return (
    <>
      <h2>Strava</h2>
      {connected ? (
        <div className="card">
          <div className="row space">
            <div>
              Connected{config.athleteName ? <> as <b>{config.athleteName}</b></> : null}.
            </div>
            <button className="ghost" onClick={async () => onChange(await disconnect())}>Disconnect</button>
          </div>
          <p className="muted small">
            Nothing uploads automatically. After a ride, choose <b>Upload to Strava</b> on its summary (or <b>Strava…</b> in History). Rides upload as
            virtual rides with one lap per interval, and a ride that&apos;s already on Strava is linked instead of duplicated.
          </p>
        </div>
      ) : (
        <>
          <p className="muted">
            RideBox has no server, so you connect Strava through your own (free) Strava API app. It takes a minute, once:
          </p>
          <ol className="steps">
            <li>
              Go to{' '}
              <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">
                strava.com/settings/api
              </a>{' '}
              and create an app. Name it anything (e.g. “RideBox”), pick any category, and use any website.
            </li>
            <li>
              Set <b>Authorization Callback Domain</b> to <code>{callbackDomain}</code>.
            </li>
            <li>Copy the app&apos;s <b>Client ID</b> and <b>Client Secret</b> here, then click <b>Connect Strava</b>.</li>
          </ol>
          <div className="fields">
            <label className="field">
              <span>Client ID</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} inputMode="numeric" placeholder="e.g. 123456" />
            </label>
            <label className="field">
              <span>Client Secret</span>
              <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <button className="strava" disabled={!clientId.trim() || !clientSecret.trim()} onClick={connect}>
            Connect Strava
          </button>
          <p className="muted small">
            Strava will ask you to allow uploads, then send you back to <code>{redirectUri()}</code>. The secret and sign-in tokens are stored only in this
            browser. Only this app (and you) can use them.
          </p>
        </>
      )}
    </>
  );
}
