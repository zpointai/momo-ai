import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors';
export const googleScopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'];
export interface Authorization { code: string; verifier: string; redirectUri: string }
export async function authorize(clientId: string, openBrowser: (url: string) => Promise<void>, signal: AbortSignal, timeoutMs = 180000, scopes = googleScopes): Promise<Authorization> {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return new Promise((resolve, reject) => {
    let finished = false; let redirectUri = '';
    const done = (error?: AppError, code?: string) => {
      if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); server.close(); server.closeAllConnections();
      if (error) reject(error); else resolve({ code: code!, verifier, redirectUri });
    };
    const cancel = () => done(new AppError('cancelled', 'Google sign-in cancelled.'));
    const timer = setTimeout(() => done(new AppError('cancelled', 'Google sign-in timed out. Try connecting again.')), timeoutMs);
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      let url: URL;
      try {
        if (!request.url?.startsWith('/') || request.url.length > 8192) throw new Error('Invalid callback');
        url = new URL(request.url, redirectUri);
      } catch { response.writeHead(400).end('Invalid sign-in response.'); return; }
      const received = Buffer.from(url.searchParams.get('state') ?? '');
      if (finished || request.method !== 'GET' || url.pathname !== '/' || request.headers.host !== new URL(redirectUri).host || url.searchParams.getAll('state').length !== 1 || received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
        response.writeHead(400).end('Invalid sign-in response. Return to MoMo.'); return;
      }
      if (url.searchParams.has('error')) { response.end('Sign-in cancelled. Return to MoMo.'); done(new AppError('cancelled', 'Google sign-in was not approved.')); return; }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) { response.writeHead(400).end('Invalid sign-in response.'); return; }
      response.end('Sign-in received. Return to MoMo to finish connecting.');
      done(undefined, code);
    });
    server.on('error', () => done(new AppError('unavailable', 'MoMo could not open the local Google sign-in callback. Try again.')));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    server.listen(0, '127.0.0.1', () => {
      if (finished) { server.close(); return; }
      const address = server.address();
      if (!address || typeof address === 'string') { done(new AppError('internal', 'Google sign-in could not start.')); return; }
      redirectUri = 'http://127.0.0.1:' + address.port;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' }).toString();
      void openBrowser(url.toString()).catch(() => done(new AppError('unavailable', 'The system browser could not open. Try connecting again.')));
    });
  });
}
