// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { WindowsObservationHelper, encodeHelperRequest, type HelperIdentity } from '../electron/desktop-observation/helper-client';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), realpath: vi.fn(), stat: vi.fn() }));
const bytes = Buffer.from('fixed trusted test component');
const identity: HelperIdentity = { protocol: 1, helperVersion: '0.1.0', buildId: 'b'.repeat(64), sha256: createHash('sha256').update(bytes).digest('hex'), architecture: 'x64', runtime: 'static-msvc', bytes: bytes.length };
function frame(kind: string, sequence: number, data: unknown, patch = {}) {
  const payload = Buffer.from(JSON.stringify({ protocol: 1, helperVersion: '0.1.0', buildId: identity.buildId, sequence, kind, data, ...patch }), 'utf8');
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
}
const all: WindowsObservationHelper[] = [];
function harness() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const invalidated = vi.fn();
  const helper = new WindowsObservationHelper({ resourceRoot: 'C:\\MoMo\\resources', identity, invalidated }); all.push(helper);
  const ready = async () => {
    const pending = helper.start();
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0));
    child.stdout.write(frame('ready', 1, { architecture: 'x64' })); await pending; child.stdin.read();
  };
  return { helper, child, invalidated, ready };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(realpath).mockImplementation(async value => String(value));
  vi.mocked(readFile).mockResolvedValue(bytes);
  vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: bytes.length } as Awaited<ReturnType<typeof stat>>);
});
afterEach(() => { for (const h of all.splice(0)) h.stop(); vi.useRealTimers(); });

describe('Fixed native component and private protocol', () => {
  it('pins path, hash, x64/build/version and minimal non-shell launch', async () => {
    const h = harness(); await h.ready();
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(executable).toBe('C:\\MoMo\\resources\\desktop-observer\\momo-desktop-observer.exe'); expect(args).toEqual([]);
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(Object.keys(options!.env!)).toEqual(['SystemRoot', 'WINDIR']);
  });
  it.each(['hash', 'location', 'size'])('refuses %s substitution before process creation', async kind => {
    const h = harness();
    if (kind === 'hash') vi.mocked(readFile).mockResolvedValue(Buffer.alloc(bytes.length));
    if (kind === 'location') vi.mocked(realpath).mockImplementation(async value => String(value).endsWith('.exe') ? 'C:\\other\\evil.exe' : String(value));
    if (kind === 'size') vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: bytes.length + 1 } as Awaited<ReturnType<typeof stat>>);
    await expect(h.helper.start()).rejects.toThrow(/HELPER_IDENTITY/); expect(spawn).not.toHaveBeenCalled();
  });
  it('accepts only fixed binary tags with bounded UUID input', () => {
    const nativeId = randomUUID();
    expect(encodeHelperRequest('hello', 1).length).toBe(14);
    expect(encodeHelperRequest('list', 2).length).toBe(10);
    expect(encodeHelperRequest('observe', 3, nativeId).length).toBe(46);
    expect(() => encodeHelperRequest('list', 1, nativeId)).toThrow(/REQUEST_INVALID/);
    expect(() => encodeHelperRequest('observe', 1, '0x123456')).toThrow(/REQUEST_INVALID/);
    expect(() => encodeHelperRequest('list', 0)).toThrow(/REQUEST_INVALID/);
  });
  it('handles split pipe frames without releasing partial data', async () => {
    const h = harness(); await h.ready(); const pending = h.helper.list();
    const reply = frame('catalog', 2, { status: 'AVAILABLE', reasons: [], limitsHit: [], elapsedMs: 0, windows: [], examinedCandidates: 0 });
    h.child.stdout.write(reply.subarray(0, 3)); h.child.stdout.write(reply.subarray(3, 20)); h.child.stdout.write(reply.subarray(20));
    expect((await pending).windows).toEqual([]);
  });
  it.each(['version', 'build', 'sequence', 'kind', 'utf8', 'length', 'extra-field'])('kills and rejects invalid %s output without exposing payload', async kind => {
    const h = harness(); await h.ready(); const pending = h.helper.list(); const rejected = expect(pending).rejects.toThrow(/HELPER_PROTOCOL/);
    const data = { status: 'AVAILABLE', reasons: [], limitsHit: [], elapsedMs: 0, windows: [], examinedCandidates: 0 };
    if (kind === 'length') { const header = Buffer.alloc(4); header.writeUInt32LE(262145); h.child.stdout.write(header); }
    else if (kind === 'utf8') h.child.stdout.write(Buffer.from([2, 0, 0, 0, 0xc0, 0x80]));
    else h.child.stdout.write(frame(kind === 'kind' ? 'invoke' : 'catalog', kind === 'sequence' ? 1 : 2, data,
      kind === 'version' ? { protocol: 2 } : kind === 'build' ? { buildId: 'c'.repeat(64) } : kind === 'extra-field' ? { privateText: 'PRIVATE' } : {}));
    await rejected; expect(h.child.kill).toHaveBeenCalledTimes(1); expect(h.invalidated).toHaveBeenCalledWith('HELPER_PROTOCOL');
  });
  it('kills a blocked node after 500 ms and never automatically restarts', async () => {
    const h = harness(); await h.ready(); const pending = h.helper.observe(randomUUID()); const rejected = expect(pending).rejects.toThrow(/HELPER_TIMEOUT/);
    h.child.stdout.write(frame('progress', 2, { node: 0 })); await vi.advanceTimersByTimeAsync(500); await rejected;
    expect(h.child.kill).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('kills a helper stuck before progress at 3 seconds', async () => {
    const h = harness(); await h.ready(); const pending = h.helper.list(); const rejected = expect(pending).rejects.toThrow(/HELPER_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(3000); await rejected; expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
  it('cancellation destroys pipes and terminates the real process abstraction', async () => {
    const h = harness(); await h.ready(); const pending = h.helper.list(); const rejected = expect(pending).rejects.toThrow(/CANCELLED/);
    h.helper.stop('CANCELLED'); await rejected;
    expect(h.child.stdin.destroyed && h.child.stdout.destroyed && h.child.stderr.destroyed).toBe(true);
    expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
  it.each(['stderr', 'exit', 'destroyed', 'lock'])('invalidates idle session immediately on %s', async kind => {
    const h = harness(); await h.ready();
    if (kind === 'stderr') h.child.stderr.write('PRIVATE native error');
    else if (kind === 'exit') h.child.emit('exit', 1);
    else h.child.stdout.write(frame('invalidated', 0, { reason: kind === 'lock' ? 'SYSTEM_SESSION_CHANGED' : 'TARGET_STALE' }));
    expect(h.invalidated).toHaveBeenCalledTimes(1); expect(JSON.stringify(h.invalidated.mock.calls)).not.toContain('PRIVATE'); expect(h.child.kill).toHaveBeenCalledTimes(1);
  });
});
