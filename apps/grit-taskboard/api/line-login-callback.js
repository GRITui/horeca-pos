/* Sidekick — api/line-login-callback.js
 *
 * LINE redirects here after the user approves (or cancels) the login. On
 * success, hands the verified LINE profile (sub/name/picture — no tokens,
 * nothing secret) to the client as a URL fragment on the login.html the user
 * actually started from (see `returnTo` in lib/lineLogin.js / api/line-
 * login-start.js — never this handler's own `origin`, which is always the
 * Vercel origin regardless of where the flow began), which never reaches
 * this server or any server log. app/app.js's bootLogin() reads it once and
 * creates/logs into a local IndexedDB account keyed by `line:<sub>` — there
 * is no server-side user record to create, matching the rest of the app's
 * local-first model.
 */
import { verifyState, exchangeCodeForToken, verifyIdToken, constantTimeEqual, signLineIdentity } from '../lib/lineLogin.js';

const STATE_COOKIE = 'line_login_nonce';

function redirectTo(base, params) {
  const headers = new Headers({ location: `${base}#${new URLSearchParams(params).toString()}` });
  // One-shot: this cookie has done its job (or the flow failed), don't leave
  // it sitting around for longer than the state token it was bound to.
  headers.append('set-cookie', `${STATE_COOKIE}=; Max-Age=0; Path=/api/line-login-callback; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export default async function handler(request) {
  const { searchParams, origin } = new URL(request.url);
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET;
  const callbackUrl = process.env.LINE_LOGIN_CALLBACK_URL;
  const stateSecret = process.env.LINE_LOGIN_STATE_SECRET;
  if (!channelId || !channelSecret || !callbackUrl || !stateSecret) {
    return new Response('LINE Login is not configured on this deployment.', { status: 500 });
  }

  // Fallback for error paths reached before (or without ever) verifying
  // state — we don't yet know a validated returnTo, so land on this
  // deployment's own login page rather than failing the redirect outright.
  const fallbackBase = `${origin}/login.html`;

  if (searchParams.get('error')) {
    return redirectTo(fallbackBase, { line_error: searchParams.get('error') });
  }

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  if (!code || !state) return redirectTo(fallbackBase, { line_error: 'missing_params' });

  const verified = await verifyState(state, stateSecret);
  if (!verified) return redirectTo(fallbackBase, { line_error: 'invalid_state' });
  const { nonce, returnTo } = verified;
  const base = returnTo || fallbackBase;

  // Browser-binding check: the nonce must match the cookie api/line-login-
  // start.js set on the same browser at the start of this flow. A signed
  // `state` alone is tamper-evident but not proof of origin — without this,
  // an attacker could capture/replay a state value to force a login-CSRF on
  // a victim's browser (see lib/lineLogin.js's header).
  const cookieNonce = getCookie(request, STATE_COOKIE);
  if (!cookieNonce || !constantTimeEqual(cookieNonce, nonce)) {
    return redirectTo(base, { line_error: 'invalid_state' });
  }

  let claims;
  try {
    const token = await exchangeCodeForToken({ code, channelId, channelSecret, callbackUrl });
    claims = await verifyIdToken(token.id_token, { channelId, channelSecret, nonce });
  } catch (err) {
    console.error('line-login-callback failed', err);
    return redirectTo(base, { line_error: 'login_failed' });
  }

  const profile = { sub: claims.sub, name: claims.name || '', picture: claims.picture || '' };
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(profile))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // A signed proof of this exact, just-verified LINE identity, handed to
  // the client alongside the plain profile so it can enable cloud backup
  // later (api/auth-register-line.js) without a second OAuth round trip —
  // see signLineIdentity()'s own header comment in lib/lineLogin.js.
  const lineToken = await signLineIdentity({ sub: claims.sub, name: claims.name || '', picture: claims.picture || '' }, stateSecret);
  return redirectTo(base, { line: encoded, lineToken });
}

export const config = { runtime: 'edge' };
