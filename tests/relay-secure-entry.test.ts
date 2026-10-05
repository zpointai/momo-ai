// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { secureRelayEntry } from '../electron/relay/secure-entry';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), realpath: vi.fn() }));
const binary = Buffer.from('isolated native component fixture');
const identity = { bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') };
const options = { resourceRoot: path.resolve('test-resources'), ownerWindow: '12345', identity };
const sid = 'SK' + 'a'.repeat(32), secret = 'synthetic-test-secret-only';
function frame(first = sid, second = secret) {
  const header = Buffer.alloc(12); header.write('MR01'); header.writeUInt32LE(first.length, 4); header.writeUInt32LE(second.length, 8);
  return Buffer.concat([header, Buffer.from(first + second)]);
}
function result(stdout: Buffer, error: ExecFileException | null = null, stderr = Buffer.alloc(0)) {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[3] as (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void;
    queueMicrotask(() => callback(error, stdout, stderr));
    return {} as ChildProcess;
  }) as typeof execFile);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(realpath).mockImplementation(async value => String(value));
  vi.mocked(readFile).mockResolvedValue(binary);
});

describe('Relay owner-only native secure entry', () => {
  it('launches only the verified component with purpose and owner window, and clears the pipe buffer', async () => {
    const output = frame(); result(output);
    await expect(secureRelayEntry('rest', options)).resolves.toEqual({ apiKeySid: sid, secret });
    const [executable, args, launch] = vi.mocked(execFile).mock.calls[0];
    expect(executable).toBe(path.join(options.resourceRoot, 'relay-setup', 'momo-relay-setup.exe'));
    expect(args).toEqual(['rest', '12345']);
    expect(launch).toMatchObject({ shell: false, windowsHide: false, timeout: 600000, maxBuffer: 1024, encoding: 'buffer' });
    expect(Object.keys(launch!.env!)).toEqual(['SystemRoot', 'WINDIR']);
    expect(output.every(byte => byte === 0)).toBe(true);
  });
  it('accepts pairing only as its separate single-field purpose', async () => {
    result(frame('t'.repeat(48), ''));
    await expect(secureRelayEntry('pair', options)).resolves.toEqual({ token: 't'.repeat(48) });
  });
  it.each(['hash', 'path', 'size', 'missing'])('refuses a %s mismatch before launch', async kind => {
    if (kind === 'hash') vi.mocked(readFile).mockResolvedValue(Buffer.alloc(binary.length));
    if (kind === 'path') vi.mocked(realpath).mockResolvedValue(path.resolve('untrusted.exe'));
    if (kind === 'size') vi.mocked(readFile).mockResolvedValue(Buffer.alloc(1));
    if (kind === 'missing') vi.mocked(readFile).mockRejectedValue(new Error('private local detail'));
    await expect(secureRelayEntry('rest', options)).rejects.toMatchObject({ code: 'unavailable' });
    expect(execFile).not.toHaveBeenCalled();
  });
  it('requires a valid owner window argument before launch', async () => {
    await expect(secureRelayEntry('rest', { ...options, ownerWindow: '0' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each(['short', 'magic', 'length', 'extra', 'sid', 'secret', 'ascii', 'wrong-purpose'])('rejects %s output without exposing it', async kind => {
    let output = frame();
    if (kind === 'short') output = Buffer.from(secret);
    if (kind === 'magic') output[0] = 0xcd;
    if (kind === 'length') output.writeUInt32LE(10000, 4);
    if (kind === 'extra') output = Buffer.concat([output, Buffer.from('!')]);
    if (kind === 'sid') output = frame('AC' + 'a'.repeat(32));
    if (kind === 'secret') output = frame(sid, 'short');
    if (kind === 'ascii') output[output.length - 1] = 0xff;
    result(output);
    await expect(secureRelayEntry(kind === 'wrong-purpose' ? 'pair' : 'rest', options)).rejects.toMatchObject({ code: 'invalid_input', message: expect.not.stringContaining(secret) });
    expect(output.every(byte => byte === 0)).toBe(true);
  });
  it('treats Cancel as cancellation and clears both output buffers', async () => {
    const output = Buffer.from(secret), errorOutput = Buffer.from(secret);
    result(output, Object.assign(new Error(secret), { code: 2 }), errorOutput);
    await expect(secureRelayEntry('rest', options)).rejects.toMatchObject({ code: 'cancelled', message: 'Secure setup cancelled.' });
    expect(output.every(byte => byte === 0) && errorOutput.every(byte => byte === 0)).toBe(true);
  });
  it('contains antivirus/startup failures without passing child error text to the renderer', async () => {
    const output = frame(), errorOutput = Buffer.from(secret);
    result(output, Object.assign(new Error(secret), { code: 'EACCES' }), errorOutput);
    await expect(secureRelayEntry('rest', options)).rejects.toMatchObject({ code: 'unavailable', message: expect.not.stringContaining(secret) });
    expect(output.every(byte => byte === 0) && errorOutput.every(byte => byte === 0)).toBe(true);
  });
});
