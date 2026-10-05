import { AppError } from '../errors';
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;
export class GoogleHttpError extends AppError {
  constructor(readonly status: number, readonly reason: string) {
    super('unavailable', status === 429 ? 'Google is limiting requests. Wait a minute, then refresh.' : status === 401 || reason === 'invalid_grant' ? 'Google access has expired. Reconnect this account in Settings.' : status === 403 ? 'Google denied access. Check API enablement and account permissions, then reconnect.' : 'Google is temporarily unavailable. Try refreshing shortly.');
  }
}
export function allowedGoogleRequest(raw: string, method: string): boolean {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false;
  return (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST')
    || (url.origin === 'https://openidconnect.googleapis.com' && url.pathname === '/v1/userinfo' && method === 'GET')
    || (url.origin === 'https://gmail.googleapis.com' && /^\/gmail\/v1\/users\/me\/messages(?:\/[a-zA-Z0-9_-]+)?$/.test(url.pathname) && method === 'GET')
    || (url.origin === 'https://gmail.googleapis.com' && /^\/gmail\/v1\/users\/me\/threads\/[a-zA-Z0-9_-]+$/.test(url.pathname) && method==='GET')
    || (url.origin === 'https://gmail.googleapis.com' && /^\/gmail\/v1\/users\/me\/messages\/[a-zA-Z0-9_-]+\/(modify|trash|untrash)$/.test(url.pathname) && method==='POST')
    || (url.origin === 'https://gmail.googleapis.com' && ['/gmail/v1/users/me/messages/send','/gmail/v1/users/me/drafts','/gmail/v1/users/me/drafts/send'].includes(url.pathname) && method==='POST')
    || (url.origin === 'https://gmail.googleapis.com' && /^\/gmail\/v1\/users\/me\/drafts\/[a-zA-Z0-9_-]+$/.test(url.pathname) && method==='PUT')
    || (url.origin === 'https://www.googleapis.com' && ((url.pathname === '/calendar/v3/calendars/primary/events' && ['GET','POST'].includes(method)) || (/^\/calendar\/v3\/calendars\/primary\/events\/[A-Za-z0-9_-]{1,1024}$/.test(url.pathname) && (method==='GET'||method==='PATCH'&&url.search==='?sendUpdates=none'))));
}
export class GoogleHttp {
  constructor(private transport: Transport = (...args) => globalThis.fetch(...args)) {}
  async json(url: string, init: RequestInit = {}): Promise<unknown> {
    if (!allowedGoogleRequest(url, init.method ?? 'GET')) throw new AppError('permission_denied', 'This Google request is not permitted.');
    try {
      const response = await this.transport(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init.signal ? [init.signal] : [])]) });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response');
      const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 4 * 1024 * 1024) throw new Error('Oversized response'); chunks.push(item.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw new GoogleHttpError(response.status, typeof value?.error === 'string' ? value.error : '');
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (init.signal?.aborted) throw new AppError('cancelled', 'The Google request was cancelled.');
      throw new AppError('unavailable', 'Google could not be reached or returned an invalid response. Try again.');
    }
  }
}

