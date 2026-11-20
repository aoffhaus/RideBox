import { useState } from 'react';
import { authorizeUrl, canReadActivities, connectUrl, disconnect, isConnected, redirectUri, saveStrava, type StravaConfig } from '../strava/strava';

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

  // the private site: the Worker holds the Strava app's secret and the tokens
  if (config.server && !config.server.configured) {
    return (
      <>
        <h2>Strava</h2>
        <p className="muted">Strava is set up on your private Cloudflare site, once:</p>
        <ol className="steps">
          <li>
            On{' '}
            <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">
              strava.com/settings/api
            </a>
            , create an app (or use your existing one) and set <b>Authorization Callback Domain</b> to <code>{callbackDomain}</code>.
          </li>
          <li>
            In the Cloudflare dashboard: Workers &amp; Pages → <b>ridebox</b> → Settings → Variables and Secrets, add two secrets:{' '}
            <code>STRAVA_CLIENT_ID</code> and <code>STRAVA_CLIENT_SECRET</code> (from that Strava page). Then reload this page.
          </li>
        </ol>
        <p className="muted small">The secret and your Strava sign-in stay on the server; this browser never sees them.</p>
      </>
    );
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
          {canReadActivities(config) ? (
            <p className="muted small">Your Strava activities are imported on the Fitness tab, so outdoor rides count toward fitness and the coach sees them.</p>
          ) : (
            <p className="small">
              <b>Reconnect to import activities:</b> this connection can only upload. Click <b>Reconnect</b> and allow “View data about your private
              activities” so outdoor rides count toward fitness and training plans.{' '}
              <button onClick={() => (location.href = connectUrl(config))}>Reconnect</button>
            </p>
          )}
        </div>
      ) : config.server ? (
        <>
          <p className="muted">Connect your Strava account to upload rides and count outdoor rides toward fitness.</p>
          <button className="strava" onClick={() => (location.href = connectUrl(config))}>
            Connect Strava
          </button>
          <p className="muted small">Strava asks you to allow uploads and reading your activities. Your sign-in is kept on your private server, not in this browser.</p>
        </>
      ) : (
        <>
          <p className="muted">
            Connect Strava through your own (free) Strava API app. It takes a minute, once:
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
            Strava will ask you to allow uploads and reading your activities, then send you back to <code>{redirectUri()}</code>. The secret and sign-in
            tokens stay in your browser and your private, sign-in-protected RideBox database.
          </p>
        </>
      )}
    </>
  );
}
