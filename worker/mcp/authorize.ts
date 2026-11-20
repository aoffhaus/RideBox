// The connector's sign-in page (/authorize).
//
// Claude sends the rider here when they click Connect. Cloudflare Access sits in
// front of this path like the rest of the site, and the Worker has already
// checked the Access sign-in (and ALLOWED_EMAILS) before this runs, so the page
// only has to show who is asking and get an explicit Allow.

import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/**
 * What the connector may do. One scope covers it (single rider, all or nothing),
 * so the rider approves it plus refresh tokens whatever the client asked for.
 */
export const SCOPE = 'ridebox';
export const SCOPES_SUPPORTED = [SCOPE, 'offline_access'];

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers?: Headers) {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:30rem;margin:16px;padding:24px;background:#1b1b1b;border:1px solid #333;border-radius:12px}
h1{font-size:1.3rem;margin:0 0 12px}
ul{padding-left:1.2rem}
.warn{background:#3a2a00;border:1px solid #7a5a00;padding:8px 12px;border-radius:8px}
.muted{color:#aaa;font-size:.9rem}
.row{display:flex;gap:12px;margin-top:20px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #555;background:#222;color:#eee;cursor:pointer}
button.primary{background:#e8590c;border-color:#e8590c;color:#fff;font-weight:600}
</style><main>${body}</main>`;
  return new Response(html, { status, headers: h });
}

function consentPage(c: ConsentDescription, handle: string, email: string, headers: Headers) {
  const name = esc(c.clientName);
  const who = c.clientDomain ? `published by <b>${esc(c.clientDomain)}</b>` : 'which registered itself (its name isn’t verified)';
  return page(
    `Connect ${c.clientName} to RideBox`,
    `<h1>🚴 Allow ${name} to use RideBox?</h1>
<p><b>${name}</b>, ${who}, wants to connect to your RideBox as <b>${esc(email)}</b>. Access will be sent to <b>${esc(c.redirectHost)}</b>.</p>
${c.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ''}
${c.redirectHost === 'claude.ai' || c.redirectHost.endsWith('.claude.ai') || c.redirectHost.endsWith('.anthropic.com') ? '' : '<p class="warn">This isn’t Claude’s usual address (claude.ai). Only allow it if you just added RideBox to an app you trust.</p>'}
<p>It will be able to:</p>
<ul><li>read your rides, Strava activities, fitness, levels, calendar, plans and workout library</li>
<li>change your calendar, plans and library, and your FTP, weight and max HR</li></ul>
<p class="muted">Changes are logged and can be undone. Disconnect any time in the app you connected from.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div></form>`,
    200,
    headers,
  );
}

function errorPage(message: string, status = 400) {
  return page('RideBox connection', `<h1>🚴 Couldn’t connect</h1><p>${esc(message)}</p><p class="muted">Start connecting again from Claude.</p>`, status);
}

/** GET / POST /authorize for the rider signed in as `email` (already checked by verifyAccess). */
export async function authorize(req: Request, oauth: OAuthHelpers, email: string): Promise<Response> {
  try {
    if (req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request); // first: a failed lookup leaves nothing stored
      const consent = await oauth.beginConsent(request);
      return consentPage(details, consent.handle, email, consent.headers);
    }
    if (req.method === 'POST') {
      const form = await req.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle, { scope: SCOPES_SUPPORTED });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, // from storage, not from the form
        userId: email,
        metadata: { label: 'RideBox connector' },
        scope: approved.request.scope,
        props: { email },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return errorPage(e.description ?? 'The request wasn’t valid.');
    if (e instanceof CimdFetchError) return errorPage('This app could not be verified.');
    throw e;
  }
}

