/* Sidekick — api/line-login-start.js
 *
 * Entry point for the "Log in with LINE" button (app/login.html). Redirects
 * the browser straight to LINE's authorize page — nothing is persisted here,
 * the signed `state` carries the per-attempt nonce (and the caller's
 * `returnTo`) forward to api/line-login-callback.js (see lib/lineLogin.js's
 * header for why).
 *
 * The app is deployed at more than one origin — GitHub Pages (root and the
 * /gym/ mirror) and this Vercel project's own static mirror — each with its
 * own separate local IndexedDB. `returnTo` is which one the button was
 * clicked from; it's checked against an exact allowlist here (never trusted
 * as-is) since it ends up as a redirect target in the callback.
 */
import { signState, buildAuthorizeUrl } from '../lib/lineLogin.js';

const ALLOWED_RETURN_TO = [
  'https://gritui.github.io/Sidekickz/login.html',
  'https://gritui.github.io/Sidekickz/gym/login.html',
  'https://sidekickz.vercel.app/login.html',
];

const STATE_COOKIE = 'line_login_nonce';

export default async function handler(request) {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  const callbackUrl = process.env.LINE_LOGIN_CALLBACK_URL;
  const stateSecret = process.env.LINE_LOGIN_STATE_SECRET;
  if (!channelId || !callbackUrl || !stateSecret) {
    return new Response('LINE Login is not configured on this deployment.', { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const requestedReturnTo = searchParams.get('returnTo');
  const returnTo = ALLOWED_RETURN_TO.includes(requestedReturnTo) ? requestedReturnTo : null;

  const nonce = crypto.randomUUID();
  const state = await signState({ nonce, returnTo }, stateSecret);
  const url = buildAuthorizeUrl({ channelId, callbackUrl, state, nonce });

  // Binds this flow to the browser that started it: the callback checks this
  // cookie's value against the nonce recovered from `state`, so a signed
  // state token captured/replayed by an attacker (e.g. via referrer leakage)
  // can't complete a login on a victim's browser, which never received this
  // cookie. Scoped to the callback path only, short-lived, and not readable
  // by page JS.
  const headers = new Headers({ location: url });
  headers.append(
    'set-cookie',
    `${STATE_COOKIE}=${nonce}; Max-Age=600; Path=/api/line-login-callback; HttpOnly; Secure; SameSite=Lax`
  );
  return new Response(null, { status: 302, headers });
}

export const config = { runtime: 'edge' };
