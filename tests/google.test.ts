// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { authorize, googleScopes } from '../electron/google/oauth';
import { GoogleHttp, allowedGoogleRequest } from '../electron/google/http';
import { GoogleService } from '../electron/google/service';
import { ProtectedGoogleVault, type GoogleVault, type VaultData } from '../electron/google/vault';
import { normalizeEvent, plainText } from '../electron/google/normalize';
import { addDays, dateInZone, eventOnDate } from '../src/shared/google';
import { settingsUpdateSchema, defaults } from '../src/shared/contracts';
import { SettingsDatabase } from '../electron/storage/database';
import Database from 'better-sqlite3';
it('opens a phase-one settings file, defaulting only the newly added pane preference', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'momo-v1-settings-')); const filename = path.join(directory, 'momo.sqlite');
  try {
    const initial = new SettingsDatabase(filename); initial.update({ patch: { theme: 'light' }, expectedRevision: 0 }); initial.close();
    const old = new Database(filename);
    const values = { ...defaults, theme: 'light' }; delete (values as Partial<typeof values>).assistantCollapsed;
    old.prepare('UPDATE settings SET value = ?').run(JSON.stringify(values)); old.close();
    const reopened = new SettingsDatabase(filename);
    expect(reopened.get()).toEqual({ revision: 1, values: { ...defaults, theme: 'light' } }); reopened.close();
    const check = new Database(filename, { readonly: true }); try { expect(check.pragma('user_version', { simple: true })).toBe(9); } finally { check.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('filters the calendar envelope to exact local dates and reports invalid records', async () => {
  const service = makeService(async () => response({ items: [
    { id: 'previous', start: { date: '2026-03-28' }, end: { date: '2026-03-29' } },
    { id: 'today', start: { date: '2026-03-29' }, end: { date: '2026-03-30' } },
    { id: 'tomorrow', start: { date: '2026-03-30' }, end: { date: '2026-03-31' } },
    { id: 'dst', start: { dateTime: '2026-03-28T23:30:00Z' }, end: { dateTime: '2026-03-29T01:30:00Z' } },
    { id: 'cancelled', status: 'cancelled' }, { id: 'invalid' },
  ] }));
  const data = await service.calendar({ accountId: 'a', startDate: '2026-03-29', endDate: '2026-03-30', timezone: 'Europe/Amsterdam' });
  expect(data.events.map(event => event.id)).toEqual(['today','dst']); expect(data.skipped).toBe(1);
});
const now = +new Date('2026-09-19T09:00:00Z');
const client = { client_id: 'momo-test.apps.googleusercontent.com', client_secret: 'fake-client-secret' };
const makeAccount = (id = 'a', expired = false) => ({ id, email: id + '@example.com', status: 'connected' as const, token: { access: 'access-' + id, refresh: 'refresh-' + id, expiresAt: now + (expired ? -1000 : 3600000), scopes: googleScopes } });
class MemoryVault implements GoogleVault {
  constructor(public value: VaultData = { version: 1, client, activeAccountId: 'a', accounts: [makeAccount()] }) {}
  async read() { return structuredClone(this.value); }
  async write(value: VaultData) { this.value = structuredClone(value); }
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const rawMail = (id = 'm1') => ({ id, threadId: 't1', internalDate: String(now), labelIds: ['INBOX','UNREAD'], snippet: 'Preview', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'A real subject' }, { name: 'From', value: 'Sender <sender@example.com>' }], body: { data: Buffer.from('Safe plain text').toString('base64url') } } });
const flow = vi.fn(async () => ({ code: 'fake-code', verifier: 'fake-verifier', redirectUri: 'http://127.0.0.1:1234' }));
const makeService = (transport: (url: string, init?: RequestInit) => Promise<Response>, vault = new MemoryVault(), clock = () => now) => new GoogleService(vault, new GoogleHttp(transport), vi.fn(async () => undefined), vi.fn(), flow, clock);

describe('native Google authorization', () => {
  it('uses loopback, one-use state and S256 PKCE; rejects a forged callback', async () => {
    let observed: URL | undefined;
    const callbacks: Promise<void>[] = [];
    const authorization = await authorize(client.client_id, async raw => {
      observed = new URL(raw);
      const callback = new URL(observed.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('127.0.0.1');
      expect(observed.origin).toBe('https://accounts.google.com');
      expect(observed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(observed.searchParams.get('scope')).toBe(googleScopes.join(' '));
      const work = (async () => {
        callback.search = new URLSearchParams({ state: 'wrong', code: 'fake-code' }).toString();
        expect((await fetch(callback)).status).toBe(400);
        callback.search = new URLSearchParams({ state: observed!.searchParams.get('state')!, code: 'fake-code' }).toString();
        expect((await fetch(callback)).status).toBe(200);
      })();
      callbacks.push(work);
      await work;
    }, new AbortController().signal);
    await Promise.all(callbacks);
    expect(authorization.code).toBe('fake-code');
    expect(createHash('sha256').update(authorization.verifier).digest('base64url')).toBe(observed!.searchParams.get('code_challenge'));
    await expect(fetch(authorization.redirectUri)).rejects.toThrow();
  });
  it('handles cancellation and expiry without exchanging tokens', async () => {
    const controller = new AbortController();
    await expect(authorize(client.client_id, async () => { controller.abort(); }, controller.signal)).rejects.toThrow('cancelled');
    await expect(authorize(client.client_id, async () => undefined, new AbortController().signal, 15)).rejects.toThrow('timed out');
  });
  it('stores verified subject identity and requires all read scopes before saving', async () => {
    const vault = new MemoryVault({ version: 1, client, activeAccountId: null, accounts: [] });
    const transport = vi.fn(async (url: string) => url.endsWith('/token') ? response({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: googleScopes.join(' ') }) : response({ sub: 'stable-subject', email: 'me@example.com', email_verified: true }));
    const service = makeService(transport, vault); await service.connect();
    expect((await service.state()).accounts).toEqual([{ id: 'stable-subject', email: 'me@example.com', status: 'connected', calendarWrite:false,mailCompose:false,mailSend:false,mailModify:false }]);
    expect(JSON.stringify(await service.state())).not.toContain('refresh');
    const missing = makeService(async () => response({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid email' }), new MemoryVault({ version: 1, client, activeAccountId: null, accounts: [] }));
    await expect(missing.connect()).rejects.toThrow('permissions');
    expect((await missing.state()).accounts).toEqual([]);
  });
  it('rejects Web OAuth client imports and replacing clients while connected', async () => {
    const service = makeService(async () => { throw new Error('Network forbidden'); }, new MemoryVault({ version: 1, client: null, activeAccountId: null, accounts: [] }));
    await expect(service.importClient({ web: client })).rejects.toThrow('Desktop');
    await service.importClient({ installed: { ...client, token_uri: 'https://evil.test' } });
    expect((await service.state()).configuration).toBe('configured');
    await expect(makeService(async () => response({})).importClient({ installed: client })).rejects.toThrow('Disconnect');
  });
});

describe('read boundaries and isolation', () => {
  it('permits only exact Google routes; never Gemini, permanent deletion, event edits or arbitrary hosts', () => {
    for (const [url, method] of [
      ['https://generativelanguage.googleapis.com/v1/models', 'GET'],
      ['https://gmail.googleapis.com/gmail/v1/users/me/messages/m1', 'DELETE'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events', 'DELETE'],
      ['https://openidconnect.googleapis.com.evil.test/v1/userinfo', 'GET'],
      ['https://user@openidconnect.googleapis.com/v1/userinfo', 'GET'],
    ]) expect(allowedGoogleRequest(url, method)).toBe(false);
    expect(allowedGoogleRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full', 'GET')).toBe(true);
  });
  it('coalesces reads and refreshes, caches results, and uses bounded Gmail pagination', async () => {
    const vault = new MemoryVault({ version: 1, client, activeAccountId: 'a', accounts: [makeAccount('a', true)] });
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return response({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 });
      if (url.includes('/calendar/')) return response({ items: [] });
      if (new URL(url).pathname.endsWith('/messages')) { expect(new URL(url).searchParams.get('maxResults')).toBe('25'); return response({ messages: [{ id: 'm1' }], nextPageToken: 'next-page' }); }
      return response(rawMail());
    });
    const service = makeService(transport, vault);
    const [first, second] = await Promise.all([service.inbox({ accountId: 'a' }), service.inbox({ accountId: 'a' }), service.calendar({ accountId: 'a', startDate: '2026-09-19', endDate: '2026-09-26', timezone: 'Europe/Amsterdam' })]);
    expect(first).toEqual(second); expect(first.nextPageToken).toBe('next-page');
    expect(transport.mock.calls.filter(([url]) => url.endsWith('/token')).length).toBe(1);
    expect(transport.mock.calls.length).toBe(4);
    expect((await service.inbox({ accountId: 'a' })).cached).toBe(true); expect(transport.mock.calls.length).toBe(4);
    expect((await service.message({ accountId: 'a', id: 'm1' })).text).toBe('Safe plain text');
  });
  it('prevents late results and cached messages crossing accounts', async () => {
    const vault = new MemoryVault({ version: 1, client, activeAccountId: 'a', accounts: [makeAccount(), makeAccount('b')] });
    let resolve: ((value: Response) => void) | undefined;
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).Authorization;
      if (token === 'Bearer access-a') return new Promise<Response>(done => { resolve = done; });
      return response({ messages: [] });
    });
    const service = makeService(transport, vault);
    const pending = service.inbox({ accountId: 'a' });
    const rejected = expect(pending).rejects.toThrow('account changed');
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await service.select('b'); resolve!(response({ messages: [] })); await rejected;
    await expect(service.inbox({ accountId: 'a' })).rejects.toThrow('Choose a connected');
    expect((await service.inbox({ accountId: 'b' })).accountId).toBe('b');
  });
  it('marks expired grants for reconnect and never resurrects a disconnected account', async () => {
    const vault = new MemoryVault({ version: 1, client, activeAccountId: 'a', accounts: [makeAccount('a', true)] });
    const service = makeService(async () => response({ error: 'invalid_grant' }, 400), vault);
    await expect(service.inbox({ accountId: 'a' })).rejects.toThrow('Reconnect');
    expect((await service.state()).accounts[0].status).toBe('reconnect');
    await service.disconnect('a'); expect((await service.state()).accounts).toEqual([]);
    expect(vault.value.accounts).toEqual([]);
  });
  it('reports partial metadata failures with at most five concurrent detail reads', async () => {
    let active = 0; let peak = 0;
    const service = makeService(async url => {
      if (new URL(url).pathname.endsWith('/messages')) return response({ messages: Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i })) });
      active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--;
      const id = new URL(url).pathname.split('/').at(-1)!;
      return id === 'm5' ? response({ error: {} }, 503) : response(rawMail(id));
    });
    const value = await service.inbox({ accountId: 'a' }); expect(value.failed).toBe(1); expect(value.messages.length).toBe(11); expect(peak).toBe(5);
  });
  it('applies a rate-limit cooldown and rejects redirects at transport level', async () => {
    let clock = now;
    const transport = vi.fn(async (_url: string, init?: RequestInit) => { expect(init?.redirect).toBe('error'); return response({ error: {} }, 429); });
    const service = makeService(transport, new MemoryVault(), () => clock);
    await expect(service.inbox({ accountId: 'a' })).rejects.toThrow('limiting');
    await expect(service.inbox({ accountId: 'a' })).rejects.toThrow('limiting'); expect(transport).toHaveBeenCalledTimes(1);
    clock += 61000; await expect(service.inbox({ accountId: 'a' })).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('bounds calendar pagination and labels incomplete results', async () => {
    const transport = vi.fn(async () => response({ items: [], nextPageToken: 'more' }));
    const value = await makeService(transport).calendar({ accountId: 'a', startDate: '2026-09-19', endDate: '2026-09-26', timezone: 'Europe/Amsterdam' });
    expect(transport).toHaveBeenCalledTimes(4); expect(value.truncated).toBe(true);
  });
});

describe('calendar and display semantics', () => {
  it('preserves exclusive all-day end dates and recurring instance provenance', () => {
    const event = normalizeEvent({ id: 'e', summary: 'Travel', start: { date: '2026-10-24' }, end: { date: '2026-10-27' }, recurringEventId: 'series', originalStartTime: { date: '2026-10-24' } })!;
    expect(event.time).toEqual({ kind: 'allDay', startDate: '2026-10-24', endDate: '2026-10-27' });
    expect(eventOnDate(event, '2026-10-26', 'Europe/Amsterdam')).toBe(true);
    expect(eventOnDate(event, '2026-10-27', 'Europe/Amsterdam')).toBe(false);
    expect(event.recurringEventId).toBe('series');
    expect(normalizeEvent({ id: 'gone', status: 'cancelled' })).toBeNull();
  });
  it('handles both Amsterdam DST transitions, overnight events, and midnight-exclusive ends', () => {
    expect(dateInZone(new Date('2026-03-29T01:30:00Z'), 'Europe/Amsterdam')).toBe('2026-03-29');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    const event = normalizeEvent({ id: 'dst', start: { dateTime: '2026-10-25T01:30:00+02:00', timeZone: 'Europe/Amsterdam' }, end: { dateTime: '2026-10-25T03:30:00+01:00', timeZone: 'Europe/Amsterdam' } })!;
    expect(event.time.kind === 'timed' && +new Date(event.time.end) - +new Date(event.time.start)).toBe(10800000);
    const overnight = normalizeEvent({ id: 'night', start: { dateTime: '2026-09-19T23:00:00+02:00' }, end: { dateTime: '2026-09-21T00:00:00+02:00' } })!;
    expect(eventOnDate(overnight, '2026-09-20', 'Europe/Amsterdam')).toBe(true);
    expect(eventOnDate(overnight, '2026-09-21', 'Europe/Amsterdam')).toBe(false);
    expect(() => normalizeEvent({ id: 'bad', start: { date: '2026-02-30' }, end: { date: '2026-03-02' } })).toThrow();
  });
  it('renders only inline plain text, never HTML, attachments, or tracking images', () => {
    const part = (mimeType: string, data: string, filename?: string) => ({ mimeType, filename, body: { data: Buffer.from(data).toString('base64url') } });
    const value = plainText({ payload: { parts: [part('text/html', '<img src="https://tracking.test">'), part('text/plain', 'Attached private data', 'file.txt'), part('text/plain', '<script>literal untrusted text</script>')] } });
    expect(value.text).toBe('<script>literal untrusted text</script>'); expect(value.textAvailable).toBe(true);
    expect(plainText({ payload: part('text/html', '<b>HTML only</b>') }).textAvailable).toBe(false);
  });
});
it('protects Google tokens on disk and preserves unreadable data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'momo-google-test-')); const filename = path.join(directory, 'google.bin');
  try {
    const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from([...value].reverse().join('')), decryptString: (value: Buffer) => [...value.toString()].reverse().join('') };
    const vault = new ProtectedGoogleVault(filename, protection); const state = new MemoryVault().value; await vault.write(state);
    expect((await readFile(filename)).includes(Buffer.from('refresh-a'))).toBe(false); expect(await vault.read()).toEqual(state);
    const before = await readFile(filename);
    await expect(new ProtectedGoogleVault(filename, { ...protection, decryptString: () => { throw new Error('private'); } }).read()).rejects.toThrow('preserved');
    expect(await readFile(filename)).toEqual(before);
    await expect(new ProtectedGoogleVault(filename, { ...protection, isEncryptionAvailable: () => false }).write(state)).rejects.toThrow('not saved');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('does not reset assistant collapse on unrelated settings patches', () => {
  const db = new SettingsDatabase(':memory:');
  db.update({ patch: { assistantCollapsed: true }, expectedRevision: 0 });
  expect(settingsUpdateSchema.parse({ patch: { theme: 'light' }, expectedRevision: 1 }).patch).toEqual({ theme: 'light' });
  db.update({ patch: { theme: 'light' }, expectedRevision: 1 });
  expect(db.get().values).toEqual({ ...defaults, theme: 'light', assistantCollapsed: true }); db.close();
});
