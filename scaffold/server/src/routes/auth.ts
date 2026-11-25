import { Router, type Response } from 'express';
import { config } from '../config.js';
import { wrap } from '../errors.js';
import { parseCookies, serializeCookie } from '../auth/cookies.js';
import { AuthError, finishLogin, startLogin } from '../auth/oidc.js';
import { createSession, deleteSession, LOGIN_COOKIE, savePendingLogin, SESSION_COOKIE, takePendingLogin } from '../auth/sessions.js';

const secure = () => config.session.secureCookies;

function loginFailed(res: Response, status: number, reason: string): void {
  res.setHeader('set-cookie', serializeCookie(LOGIN_COOKIE, '', { maxAgeSeconds: 0, path: '/auth', secure: secure() }));
  res.status(status).type('text/plain').send(`Login failed: ${reason}. Start again at /auth/login.`);
}

/**
 *   GET  /auth/login     302 to the IdP (authorization code + PKCE S256)
 *   GET  /auth/callback  checks state, exchanges the code, sets the session cookie, 302 to the web app
 *   POST /auth/logout    deletes the session
 */
export function authRouter(): Router {
  const r = Router();

  r.get(
    '/login',
    wrap(async (_req, res) => {
      let start;
      try {
        start = await startLogin();
      } catch (err) {
        console.error('login: IdP unavailable:', (err as Error).message);
        res.status(503).type('text/plain').send('The login provider is unavailable. Try again shortly.');
        return;
      }
      await savePendingLogin(start.state, { verifier: start.verifier, nonce: start.nonce });
      // Binds the login to this browser: a callback URL sent to someone else
      // (login CSRF) has no matching cookie there.
      res.setHeader('set-cookie', serializeCookie(LOGIN_COOKIE, start.state, { maxAgeSeconds: config.session.loginStateTtlSeconds, path: '/auth', secure: secure() }));
      res.redirect(302, start.url);
    }),
  );

  r.get(
    '/callback',
    wrap(async (req, res) => {
      const { code, state, error } = req.query;
      if (typeof error === 'string') return loginFailed(res, 400, `the login provider said ${error}`);
      if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) return loginFailed(res, 400, 'code or state missing');
      if (parseCookies(req.headers.cookie)[LOGIN_COOKIE] !== state) return loginFailed(res, 400, 'this login was not started in this browser');

      const pending = await takePendingLogin(state);
      if (!pending) return loginFailed(res, 400, 'unknown or expired login');

      let identity;
      try {
        identity = await finishLogin(code, pending.verifier, pending.nonce);
      } catch (err) {
        if (err instanceof AuthError) return loginFailed(res, 400, err.message);
        console.error('login: token exchange failed:', (err as Error).message);
        return loginFailed(res, 502, 'the login provider did not answer');
      }

      const sessionId = await createSession(identity);
      res.setHeader('set-cookie', [
        serializeCookie(SESSION_COOKIE, sessionId, { maxAgeSeconds: config.session.ttlSeconds, secure: secure() }),
        serializeCookie(LOGIN_COOKIE, '', { maxAgeSeconds: 0, path: '/auth', secure: secure() }),
      ]);
      res.redirect(302, new URL('/', config.webOrigin).toString());
    }),
  );

  r.post(
    '/logout',
    wrap(async (req, res) => {
      await deleteSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: secure() }));
      res.status(204).end();
    }),
  );

  return r;
}
