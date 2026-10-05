import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { desktopObservationLimits as limits, desktopObserverProtocol, desktopObserverVersion,
  observationReasonSchema, observationStatusSchema, type ObservationReason } from '../../src/shared/desktop-observation';
import { AppError } from '../errors';
import { nativeCatalogSchema, normalizeCatalog, normalizeTree, type NativeCatalog, type NativeTree } from './normalize';
import { observationTreeDataSchema } from '../../src/shared/desktop-observation';

export const helperIdentitySchema = z.object({ protocol: z.literal(1), helperVersion: z.literal('0.1.0'),
  buildId: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  architecture: z.literal('x64'), runtime: z.literal('static-llvm-mingw-ucrt'), bytes: z.number().int().positive().max(16777216),
}).strict();
export type HelperIdentity = z.infer<typeof helperIdentitySchema>;
declare const __MOMO_DESKTOP_OBSERVER_IDENTITY__: HelperIdentity;
export function builtHelperIdentity(): HelperIdentity {
  if (typeof __MOMO_DESKTOP_OBSERVER_IDENTITY__ === 'undefined') throw fault('HELPER_IDENTITY');
  return helperIdentitySchema.parse(__MOMO_DESKTOP_OBSERVER_IDENTITY__);
}
export const fault = (reason: ObservationReason) => new AppError(reason === 'CANCELLED' ? 'cancelled' : 'unavailable', `Desktop observation stopped (${reason}).`);
const envelope = { protocol: z.literal(1), helperVersion: z.literal('0.1.0'), buildId: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().min(0).max(0xffffffff) };
const replySchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('ready'), data: z.object({ architecture: z.literal('x64') }).strict() }).strict(),
  z.object({ ...envelope, kind: z.literal('catalog'), data: nativeCatalogSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('bound'), data: z.object({ status: observationStatusSchema, reason: observationReasonSchema.nullable() }).strict() }).strict(),
  z.object({ ...envelope, kind: z.literal('tree'), data: observationTreeDataSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('fault'), data: z.object({ reason: observationReasonSchema }).strict() }).strict(),
  z.object({ ...envelope, kind: z.literal('progress'), data: z.object({ node: z.number().int().min(0).max(511) }).strict() }).strict(),
  z.object({ ...envelope, kind: z.literal('invalidated'), data: z.object({ reason: z.enum(['TARGET_STALE', 'SYSTEM_SESSION_CHANGED']) }).strict() }).strict(),
]);
type Reply = z.infer<typeof replySchema>;
export interface ObservationHelper {
  start(): Promise<void>;
  list(): Promise<NativeCatalog>;
  authorize(nativeId: string): Promise<{ status: z.infer<typeof observationStatusSchema>; reason: ObservationReason | null }>;
  observe(nativeId: string): Promise<NativeTree>;
  stop(reason?: ObservationReason): void;
}
/** Binary requests have no strings except a fixed-format opaque UUID. No general native dispatch. */
export function encodeHelperRequest(operation: 'hello' | 'list' | 'authorize' | 'observe', sequence: number, target?: string) {
  const tag = { hello: 1, list: 2, authorize: 3, observe: 4 }[operation];
  if (!tag || !Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff ||
      (tag >= 3 ? !z.string().uuid().safeParse(target).success : target !== undefined)) throw fault('REQUEST_INVALID');
  const payload = Buffer.alloc(tag === 1 ? 10 : tag >= 3 ? 42 : 6);
  payload[0] = desktopObserverProtocol; payload[1] = tag; payload.writeUInt32LE(sequence, 2);
  if (tag === 1) payload.writeUInt32LE(process.pid, 6);
  if (tag >= 3) payload.write(target!, 6, 36, 'ascii');
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); return frame;
}
export class WindowsObservationHelper implements ObservationHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private terminal = false;
  private pending: { sequence: number; kind: 'ready' | 'catalog' | 'bound' | 'tree'; resolve(value: Reply): void; reject(error: AppError): void; timer: NodeJS.Timeout; nodeTimer?: NodeJS.Timeout; lastNode: number; bytes: number } | null = null;
  constructor(private readonly options: { resourceRoot: string; identity: HelperIdentity; invalidated(reason: ObservationReason): void }) {}
  async start() {
    if (this.child || this.terminal) throw fault('HELPER_UNAVAILABLE');
    const started = Date.now();
    try {
      const identity = helperIdentitySchema.parse(this.options.identity);
      const root = await realpath(this.options.resourceRoot);
      const expected = path.join(root, 'desktop-observer', 'momo-desktop-observer.exe');
      const canonical = await realpath(expected);
      if (canonical.toLowerCase() !== expected.toLowerCase()) throw fault('HELPER_IDENTITY');
      const file = await stat(canonical);
      if (!file.isFile() || file.size !== identity.bytes) throw fault('HELPER_IDENTITY');
      const binary = await readFile(canonical);
      if (createHash('sha256').update(binary).digest('hex') !== identity.sha256) throw fault('HELPER_IDENTITY');
      if (this.terminal || Date.now() - started >= limits.requestMs) throw fault('HELPER_TIMEOUT');
      // No PATH, user environment, account tokens, provider keys, script command or cwd selection.
      const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.SystemRoot ?? 'C:\\Windows' };
      const child = spawn(canonical, [], { shell: false, windowsHide: true, cwd: path.dirname(canonical), env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
      child.stderr.on('data', () => this.fail('HELPER_PROTOCOL')); // Never retain stderr contents.
      child.stdin.on('error', () => this.fail('HELPER_EXIT'));
      child.once('error', () => this.fail('HELPER_UNAVAILABLE'));
      child.once('exit', () => this.fail('HELPER_EXIT'));
      await this.request('hello', 'ready', undefined, limits.requestMs - (Date.now() - started));
    } catch (error) {
      this.stop('HELPER_UNAVAILABLE');
      throw error instanceof AppError ? error : fault('HELPER_IDENTITY');
    }
  }
  private request(operation: 'hello' | 'list' | 'authorize' | 'observe', kind: 'ready' | 'catalog' | 'bound' | 'tree', target?: string, timeout: number = limits.requestMs): Promise<Reply> {
    if (this.pending) return Promise.reject(fault('BUSY'));
    if (!this.child || this.terminal || timeout <= 0) return Promise.reject(fault('HELPER_UNAVAILABLE'));
    const sequence = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('HELPER_TIMEOUT'), timeout);
      this.pending = { sequence, kind, resolve, reject, timer, lastNode: -1, bytes: 0 };
      this.child!.stdin.write(encodeHelperRequest(operation, sequence, target), error => { if (error) this.fail('HELPER_EXIT'); });
    });
  }
  private receive(chunk: Buffer) {
    if (this.terminal) return;
    try {
      if (this.pending) { this.pending.bytes += chunk.length; if (this.pending.bytes > limits.responseBytes + 131072) throw fault('HELPER_PROTOCOL'); }
      if (chunk.length + this.buffer.length > limits.responseBytes + 65540) throw fault('HELPER_PROTOCOL');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE();
        if (!length || length > limits.responseBytes) throw fault('HELPER_PROTOCOL');
        if (this.buffer.length < length + 4) return;
        const frame = this.buffer.subarray(4, length + 4);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
        this.buffer = this.buffer.subarray(length + 4);
        const result = replySchema.safeParse(value);
        if (!result.success || result.data.buildId !== this.options.identity.buildId || result.data.protocol !== desktopObserverProtocol || result.data.helperVersion !== desktopObserverVersion) throw fault('HELPER_PROTOCOL');
        const reply = result.data;
        if (reply.kind === 'invalidated') {
          if (reply.sequence !== 0) throw fault('HELPER_PROTOCOL');
          this.fail(reply.data.reason); return;
        }
        const pending = this.pending;
        if (!pending || reply.sequence !== pending.sequence) throw fault('HELPER_PROTOCOL');
        if (reply.kind === 'progress') {
          if (pending.kind !== 'tree' || reply.data.node !== pending.lastNode + 1) throw fault('HELPER_PROTOCOL');
          pending.lastNode = reply.data.node; clearTimeout(pending.nodeTimer);
          pending.nodeTimer = setTimeout(() => this.fail('HELPER_TIMEOUT'), limits.nodeMs); continue;
        }
        if (reply.kind === 'fault') { this.fail(reply.data.reason); return; }
        if (reply.kind !== pending.kind) throw fault('HELPER_PROTOCOL');
        clearTimeout(pending.timer); clearTimeout(pending.nodeTimer); this.pending = null; pending.resolve(reply);
      }
    } catch { this.fail('HELPER_PROTOCOL'); }
  }
  async list(): Promise<NativeCatalog> { const reply = await this.request('list', 'catalog'); if (reply.kind !== 'catalog') throw fault('HELPER_PROTOCOL'); return normalizeCatalog(reply.data); }
  async authorize(nativeId: string) { const reply = await this.request('authorize', 'bound', nativeId); if (reply.kind !== 'bound') throw fault('HELPER_PROTOCOL'); return reply.data; }
  async observe(nativeId: string): Promise<NativeTree> { const reply = await this.request('observe', 'tree', nativeId); if (reply.kind !== 'tree') throw fault('HELPER_PROTOCOL'); return normalizeTree(reply.data); }
  private fail(reason: ObservationReason) {
    if (this.terminal) return;
    this.stop(reason); this.options.invalidated(reason);
  }
  stop(reason: ObservationReason = 'CANCELLED') {
    if (this.terminal) return;
    this.terminal = true; this.buffer = Buffer.alloc(0);
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); clearTimeout(pending.nodeTimer); pending.reject(fault(reason)); }
    const child = this.child; this.child = null;
    if (child) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill(); }
  }
}
