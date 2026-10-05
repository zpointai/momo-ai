// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { emptyGoogle } from '../src/shared/google';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SettingsDatabase } from '../electron/storage/database';
import { CredentialStore } from '../electron/credentials/store';
import { allowedRequest, assetPath, isTrustedSender } from '../electron/security';
import { invokeOperation } from '../electron/ipc/operations';
import { failure } from '../electron/errors';
import { channels, defaults, settingsSchema, type Snapshot } from '../src/shared/contracts';
const temporary: string[] = [];
it('serves only the approved brand assets and local fonts',()=>{const root=path.resolve('dist');expect(assetPath('app://momo/brand/momo-app-amber.ico',root)).toBe(path.join(root,'brand/momo-app-amber.ico'));expect(assetPath('app://momo/fonts/Geist-VariableFont_wght.ttf',root)).toBe(path.join(root,'fonts/Geist-VariableFont_wght.ttf'));for(const route of ['brand/other.ico','fonts/secret.json','references/M_1.png','../.env'])expect(assetPath('app://momo/'+route,root)).toBeNull();});
function directory() { const value = mkdtempSync(path.join(os.tmpdir(), 'momo-test-')); temporary.push(value); return value; }
afterEach(() => { for (const value of temporary.splice(0)) { if (!value.startsWith(path.join(os.tmpdir(), 'momo-test-'))) throw new Error('Unsafe test cleanup'); rmSync(value, { recursive: true, force: true }); } });
const snapshot: Snapshot = { version: 'test', settings: { values: defaults, revision: 0 }, credentials: {openai:'missing',  deepseek: 'missing', minimax: 'missing', jev: 'missing' }, protectionAvailable: true, networkEnabled: false, aiRequestsEnabled: false, google: emptyGoogle, storage: 'ready' };

describe('local database', () => {
  it('persists UTC, fractional zones and saved aliases exactly without changing other settings', () => {
    const file=path.join(directory(),'zones.sqlite');
    for(const timezone of ['UTC','Asia/Calcutta','US/Eastern','Europe/Sofia']){
      const db=new SettingsDatabase(file),before=db.get();
      db.update({patch:{timezone},expectedRevision:before.revision});db.close();
      const reopened=new SettingsDatabase(file);expect(reopened.get().values).toEqual({...before.values,timezone});
      expect(()=>reopened.update({patch:{timezone:'Europe/London'},expectedRevision:before.revision})).toThrow('Settings changed');reopened.close();
    }
  });
  it('persists across reopen, increments revisions and rejects stale updates atomically', () => {
    const file = path.join(directory(), 'state.sqlite');
    const first = new SettingsDatabase(file);
    expect(first.get().values.timezone).toBe('Europe/Amsterdam');
    first.update({ patch: { theme: 'light', timezone: 'Asia/Tokyo' }, expectedRevision: 0 });
    expect(() => first.update({ patch: { theme: 'dark' }, expectedRevision: 0 })).toThrow('Settings changed');
    first.close();
    const second = new SettingsDatabase(file);
    expect(second.get()).toEqual({ values: { ...defaults, theme: 'light', timezone: 'Asia/Tokyo' }, revision: 1 });
    expect(() => second.update({ patch: { theme: 'blue' }, expectedRevision: 1 })).toThrow();
    expect(second.get().revision).toBe(1); second.close();
  });
  it('does not mutate a future-schema database', () => {
    const file = path.join(directory(), 'future.sqlite'); const db = new Database(file); db.pragma('user_version = 99'); db.close();
    const before = readFileSync(file); expect(() => new SettingsDatabase(file)).toThrow('newer MoMo'); expect(readFileSync(file)).toEqual(before);
  });
  it('preserves corrupt data instead of resetting it', () => {
    const file = path.join(directory(), 'corrupt.sqlite'); writeFileSync(file, 'not-a-database');
    expect(() => new SettingsDatabase(file)).toThrow(); expect(readFileSync(file).toString()).toBe('not-a-database');
  });
});
describe('trusted IPC and network', () => {
  it('accepts only the expected top-level trusted sender', () => {
    const event = { sender: { id: 7 }, senderFrame: { url: 'app://momo/index.html', parent: null } };
    expect(isTrustedSender(event, 7, false)).toBe(true);
    expect(isTrustedSender(event, 8, false)).toBe(false);
    expect(isTrustedSender({ ...event, senderFrame: { ...event.senderFrame, parent: {} } }, 7, false)).toBe(false);
    for (const url of ['https://momo/index.html','app://momo.evil/index.html','app://momo/other.html','app://user@momo/index.html','http://127.0.0.1:5173']) expect(isTrustedSender({ ...event, senderFrame: { url, parent: null } }, 7, false)).toBe(false);
  });
  it('rejects invalid, oversized, unknown and forbidden requests before effects', async () => {
    const execute = vi.fn(async () => snapshot);
    for (const [channel, input, trusted] of [
      [channels.settings, { patch: { apiKey: 'never-save-me' }, expectedRevision: 0 }, true],
      [channels.settings, { patch: { timezone: 'not/a/timezone' }, expectedRevision: 0 }, true],
      [channels.importCredential, { provider: 'gemini' }, true],
      [channels.importCredential, { provider: 'deepseek', secret: 'never-send-me' }, true],
      [channels.snapshot, 'x'.repeat(5000), true],
      [channels.google, { action: 'connect', url: 'https://evil.test' }, true],
      [channels.inbox, { accountId: 'a', pageToken: 'x'.repeat(2049) }, true],
      [channels.message, { accountId: 'a', id: '../secrets' }, true],
      [channels.calendar, { accountId: 'a', startDate: '2026-02-30', endDate: '2026-03-01', timezone: 'Europe/Amsterdam' }, true],
      [channels.calendar, { accountId: 'a', startDate: '2026-01-01', endDate: '2027-01-01', timezone: 'Europe/Amsterdam' }, true],
      ['momo:tools:execute', {}, true], [channels.snapshot, undefined, false],
    ] as const) expect((await invokeOperation(channel, input, trusted, execute)).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect((await invokeOperation(channels.snapshot, undefined, true, execute)).ok).toBe(true);
  });
  it('blocks provider/network URLs including Gemini and fake localhost lookalikes', () => {
    for (const url of ['https://generativelanguage.googleapis.com','https://api.deepseek.com','https://api.minimax.io','https://api.typesafe.ai','file:///C:/secret','http://127.0.0.1:5173','https://127.0.0.1:5173.evil']) expect(allowedRequest(url, false)).toBe(false);
    expect(allowedRequest('http://127.0.0.1:5173/src/main.tsx', true)).toBe(true);
    expect(allowedRequest('http://localhost:5173', true)).toBe(false);
  });
  it('serves only fixed local application assets', () => {
    const root = path.resolve('dist');
    expect(assetPath('app://momo/index.html', root)).toBe(path.join(root, 'index.html'));
    for (const url of ['app://momo/%2e%2e%2fsecret','app://momo/assets/%2e%2e%5csecret','app://momo/credentials.bin','app://momo.evil/index.html','app://momo/assets/a.js%00']) expect(assetPath(url, root)).toBeNull();
  });
  it('never exposes raw exception contents', () => { expect(JSON.stringify(failure(new Error('secret-key-123')))).not.toContain('secret-key-123'); });
});
describe('credential boundary', () => {
  const protection = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from([...value].reverse().join('')), decryptString: (value: Buffer) => [...value.toString()].reverse().join('') };
  it('stores protected bytes and exposes status only, replaces and removes one provider', async () => {
    const dir = directory(); const store = new CredentialStore(dir, protection); const canary = 'MOMO_TEST_SECRET_CANARY_928571';
    expect(await store.status('deepseek')).toBe('missing'); await store.save('deepseek', canary);
    expect(readFileSync(path.join(dir, 'deepseek.bin')).includes(canary)).toBe(false);
    expect(await store.status('deepseek')).toBe('configured'); expect(await store.status('jev')).toBe('missing');
    await store.save('deepseek', canary + '2'); await store.remove('deepseek'); expect(await store.status('deepseek')).toBe('missing');
  });
  it('fails closed without Windows protection and rejects malformed key input', async () => {
    const store = new CredentialStore(directory(), { ...protection, isEncryptionAvailable: () => false });
    await expect(store.save('minimax', 'never-plaintext-key')).rejects.toThrow('No key was saved');
    const normal = new CredentialStore(directory(), protection);
    await expect(normal.save('jev', 'key with spaces')).rejects.toThrow();
    await expect(normal.save('jev', 'a'.repeat(2049))).rejects.toThrow();
  });
  it('marks unreadable protected bytes as an error', async () => {
    const dir = directory(); writeFileSync(path.join(dir, 'jev.bin'), 'broken');
    const store = new CredentialStore(dir, { ...protection, decryptString: () => { throw new Error('private detail'); } });
    expect(await store.status('jev')).toBe('error');
  });
});
it('bounds settings and timezone values', () => {
  expect(settingsSchema.safeParse({ ...defaults, assistantWidth: 2000 }).success).toBe(false);
  expect(settingsSchema.safeParse({ ...defaults, timezone: 'Europe/Amsterdam' }).success).toBe(true);
});
