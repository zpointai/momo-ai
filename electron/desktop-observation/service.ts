import { randomUUID } from 'node:crypto';
import { desktopObservationLimits as limits, desktopObservationStateSchema, observationCommandSchema,
  observationReasonSchema, type DesktopObservationState, type ObservationCatalog, type TreeObservation,
  type ObservationDiagnostic, type ObservationReason, type ObservationStatus, type WindowObservation } from '../../src/shared/desktop-observation';
import { AppError } from '../errors';
import { fault, type ObservationHelper } from './helper-client';
import { boundedJson, normalizeCatalog, normalizeTree } from './normalize';

export interface ObservationAuthority { enabled: boolean; paused: boolean; policyRevision: number; contextKey: string }
export interface ObservationCaller { rendererId: number; generation: number }
interface Session {
  id: string; expires: number; authority: ObservationAuthority; caller: ObservationCaller;
  helper: ObservationHelper; targetId: string | null;
}
type Operation = ObservationDiagnostic['operation'];
const usable = (status: ObservationStatus) => status === 'AVAILABLE' || status === 'PARTIAL';
const iso = (time: number) => new Date(time).toISOString();
const statusFor = (reason: ObservationReason): ObservationStatus => {
  if (['TARGET_STALE', 'TARGET_EXPIRED', 'SESSION_EXPIRED', 'TARGET_CHANGED'].includes(reason)) return 'STALE';
  if (['PERMISSION_DISABLED', 'GLOBAL_PAUSE', 'OWNER_DECLINED', 'TARGET_RESTRICTED', 'SELF_ELEVATED', 'INPUT_DESKTOP_RESTRICTED'].includes(reason)) return 'RESTRICTED';
  if (['RESPONSE_INVALID', 'HELPER_PROTOCOL', 'INTERNAL_FAILURE'].includes(reason)) return 'ERROR';
  return 'UNAVAILABLE';
};
function safeReason(error: unknown): ObservationReason {
  if (error instanceof AppError) {
    const parsed = observationReasonSchema.safeParse(/\(([A-Z_]+)\)\.$/u.exec(error.message)?.[1]);
    if (parsed.success) return parsed.data;
  }
  return 'INTERNAL_FAILURE';
}

/** Main-owned, owner/native only. No storage, agent, provider, WorkItem or Context Manager dependency. */
export class DesktopObservationService {
  private session: Session | null = null;
  private epoch = 0;
  private enabled = false;
  private reason: ObservationReason | null = 'PERMISSION_DISABLED';
  private status: ObservationStatus = 'RESTRICTED';
  private catalog: ObservationCatalog | null = null;
  private tree: TreeObservation | null = null;
  private targets = new Map<string, { nativeId: string; window: WindowObservation }>();
  private diagnostics: ObservationDiagnostic[] = [];
  private seen = new Set<string>();
  private requests: number[] = [];
  private busy: { id: string; caller: ObservationCaller; action: string; abort(reason: ObservationReason): void } | null = null;
  private sessionTimer?: NodeJS.Timeout;
  private catalogTimer?: NodeJS.Timeout;
  private treeTimer?: NodeJS.Timeout;
  constructor(private readonly options: {
    authority(): Promise<ObservationAuthority>;
    helper(invalidated: (reason: ObservationReason) => void): ObservationHelper;
    confirm(kind: 'begin' | 'target', target?: WindowObservation): Promise<boolean>;
    now?: () => number;
  }) {}
  private now() { return (this.options.now ?? Date.now)(); }
  invalidate(reason: ObservationReason) {
    ++this.epoch;
    const active = this.session; this.session = null;
    this.catalog = null; this.tree = null; this.targets.clear(); this.diagnostics = []; this.seen.clear();
    this.authorizedNativeId = null;
    clearTimeout(this.sessionTimer); clearTimeout(this.catalogTimer); clearTimeout(this.treeTimer);
    this.reason = reason; this.status = statusFor(reason);
    const busy = this.busy; this.busy = null;
    active?.helper.stop(reason); busy?.abort(reason);
    // Rate history intentionally survives session changes, cancellation and helper termination.
  }
  private expire() {
    if (this.session && this.now() >= this.session.expires) { this.invalidate('SESSION_EXPIRED'); return; }
    if (this.catalog && this.now() >= Date.parse(this.catalog.expiresAt)) this.expireCatalog();
    if (this.tree && this.now() >= Date.parse(this.tree.expiresAt)) this.tree = null;
    this.diagnostics = this.diagnostics.filter(event => this.now() - Date.parse(event.at) < limits.diagnosticMs);
  }
  private expireCatalog() {
    this.catalog = null;
    // The authorized native ID is retained separately, without catalog labels, until session expiry.
    this.targets.clear();
  }
  private authorizedNativeId: string | null = null;
  private async check(caller: ObservationCaller) {
    const epoch = this.epoch;
    const authority = await this.options.authority();
    if (epoch !== this.epoch) throw fault(this.reason ?? 'CONTEXT_CHANGED');
    this.enabled = authority.enabled === true;
    this.expire();
    if (!this.enabled || authority.paused) { this.invalidate(!this.enabled ? 'PERMISSION_DISABLED' : 'GLOBAL_PAUSE'); return authority; }
    if (this.session) {
      const s = this.session;
      if (s.caller.rendererId !== caller.rendererId || s.caller.generation !== caller.generation) this.invalidate('RENDERER_CHANGED');
      else if (s.authority.policyRevision !== authority.policyRevision || s.authority.contextKey !== authority.contextKey) this.invalidate('CONTEXT_CHANGED');
    }
    return authority;
  }
  private state(): DesktopObservationState {
    this.expire();
    const s = this.session;
    const value: DesktopObservationState = {
      capability: 'desktop.observe', enabled: this.enabled, status: this.status, reason: this.reason,
      session: s ? { id: s.id, expiresAt: iso(s.expires), targetId: s.targetId } : null,
      catalog: this.catalog, tree: this.tree, diagnostics: [...this.diagnostics],
    };
    // Reserve the public wire ceiling, including freshness and diagnostics. Internal TTLs still apply.
    const wireBudget = limits.responseBytes - 32; // Includes the IPC Result envelope.
    while (Buffer.byteLength(JSON.stringify(value), 'utf8') > wireBudget && value.diagnostics.length) value.diagnostics.shift();
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > wireBudget) value.catalog = null;
    boundedJson(value, wireBudget);
    const parsed = desktopObservationStateSchema.safeParse(value);
    if (!parsed.success) throw fault('RESPONSE_INVALID');
    return parsed.data;
  }
  private outcome(status: ObservationStatus, reason: ObservationReason | null) { this.status = status; this.reason = reason; return this.state(); }
  private event(id: string, operation: Operation, targetId: string | null, started: number) {
    if (!this.session) return;
    this.diagnostics.push({ requestId: id, targetId, operation, at: iso(this.now()), status: this.status,
      reason: this.reason, nodeCount: operation === 'observe' ? this.tree?.nodes.length ?? 0 : 0,
      limitsHit: operation === 'observe' ? this.tree?.limitsHit ?? [] : operation === 'list' ? this.catalog?.limitsHit ?? [] : [],
      elapsedMs: Math.min(limits.requestMs, Math.max(0, this.now() - started)) });
    this.diagnostics = this.diagnostics.slice(-limits.diagnosticEvents);
  }
  private rate() {
    const now = this.now(); this.requests = this.requests.filter(t => now - t < 60000);
    if (this.requests.length >= limits.perMinute || this.requests.length && now - this.requests.at(-1)! < limits.intervalMs) throw fault('RATE_LIMITED');
    this.requests.push(now);
  }
  async command(raw: unknown, caller: ObservationCaller): Promise<DesktopObservationState> {
    try { boundedJson(raw, limits.requestBytes); } catch { throw fault('REQUEST_INVALID'); }
    const parsed = observationCommandSchema.safeParse(raw);
    if (!parsed.success) throw fault('REQUEST_INVALID');
    const command = parsed.data;
    // Reducing authority must also work while begin is waiting for an owner confirmation
    // or authority lookup. No session exists then; bind cancellation to the exact caller/request.
    if (command.action === 'cancel') {
      const pending = this.busy;
      if (!pending || pending.id !== command.cancelRequestId || pending.caller.rendererId !== caller.rendererId || pending.caller.generation !== caller.generation ||
        (this.session ? command.sessionId !== this.session.id : pending.action !== 'begin' || command.sessionId !== undefined)) throw fault('REQUEST_INVALID');
      this.invalidate('CANCELLED'); return this.state();
    }
    // Reserve synchronously before the first await; control commands remain available during work.
    const work = ['begin', 'list', 'authorize', 'observe'].includes(command.action);
    if (work && this.busy) { await this.check(caller); return this.outcome('UNAVAILABLE', 'BUSY'); }
    let abort: ((reason: ObservationReason) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { abort = reason => reject(fault(reason)); });
    // A control command does not await this promise; attach a handler immediately to avoid rejection gaps.
    void interrupted.catch(() => undefined);
    const reservation = work ? { id: command.requestId, caller: { ...caller }, action: command.action, abort: abort! } : null;
    if (reservation) this.busy = reservation;
    let timer: NodeJS.Timeout | undefined;
    const starting: { helper: ObservationHelper | null } = { helper: null };
    const started = this.now(), initialEpoch = this.epoch;
    const armDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { starting.helper?.stop('HELPER_TIMEOUT'); this.invalidate('HELPER_TIMEOUT'); }, limits.requestMs);
    };
    if (work) armDeadline();
    try {
      const authority = await (work ? Promise.race([this.check(caller), interrupted]) : this.check(caller));
      if (command.action === 'status') {
        if (authority.enabled && !authority.paused && !this.session && this.reason === 'PERMISSION_DISABLED') return this.outcome('AVAILABLE', 'SESSION_REQUIRED');
        return this.state();
      }
      if (!authority.enabled || authority.paused) return this.state();
      if (this.epoch !== initialEpoch) throw fault(this.reason ?? 'CONTEXT_CHANGED');
      if (this.seen.has(command.requestId)) throw fault('REQUEST_REPLAY');
      if (this.seen.size >= 2048) { this.invalidate('SESSION_EXPIRED'); return this.state(); }
      this.seen.add(command.requestId);
      if (command.action !== 'begin') {
        if (!this.session || !('sessionId' in command) || this.session.id !== command.sessionId) throw fault('SESSION_REQUIRED');
      }
      if (command.action === 'end') { this.invalidate('CANCELLED'); return this.state(); }
      this.rate();
      const epoch = this.epoch;
      const assertCurrent = async () => {
        const current = await this.check(caller);
        if (epoch !== this.epoch || !current.enabled || current.paused || current.policyRevision !== authority.policyRevision || current.contextKey !== authority.contextKey) throw fault(this.reason ?? 'CONTEXT_CHANGED');
      };
      // Human confirmation time is outside the native request deadline, but remains cancellable.
      if (command.action === 'begin') {
        if (this.session) throw fault('BUSY');
        clearTimeout(timer);
        if (!await Promise.race([this.options.confirm('begin'), interrupted])) throw fault('OWNER_DECLINED');
        armDeadline(); await Promise.race([assertCurrent(), interrupted]);
      } else if (command.action === 'authorize') {
        this.tree = null; clearTimeout(this.treeTimer); this.session!.targetId = null; this.authorizedNativeId = null;
        const target = this.targets.get(command.targetId);
        if (!this.catalog) throw fault('TARGET_EXPIRED');
        if (!target) throw fault('TARGET_UNKNOWN');
        clearTimeout(timer);
        if (!await Promise.race([this.options.confirm('target', target.window), interrupted])) throw fault('OWNER_DECLINED');
        armDeadline(); await Promise.race([assertCurrent(), interrupted]);
        if (!this.catalog || !this.targets.has(command.targetId)) throw fault('TARGET_EXPIRED');
      }
      const perform = async () => {
        if (command.action === 'begin') {
          const helper = this.options.helper(reason => { if (epoch === this.epoch) this.invalidate(reason); }); starting.helper = helper;
          await helper.start(); await assertCurrent();
          this.session = { id: randomUUID(), expires: this.now() + limits.sessionMs, authority, caller, helper, targetId: null };
          starting.helper = null; this.authorizedNativeId = null;
          this.sessionTimer = setTimeout(() => this.invalidate('SESSION_EXPIRED'), limits.sessionMs); this.sessionTimer.unref();
          this.outcome('AVAILABLE', null);
        } else if (command.action === 'list') {
          const session = this.session!;
          this.catalog = null; this.tree = null; this.targets.clear(); session.targetId = null; this.authorizedNativeId = null;
          clearTimeout(this.catalogTimer); clearTimeout(this.treeTimer);
          const result = normalizeCatalog(await session.helper.list()); await assertCurrent();
          const now = this.now();
          this.catalog = { ...result, version: 1, sessionId: session.id, requestId: command.requestId, catalogId: randomUUID(),
            observedAt: iso(now), expiresAt: iso(Math.min(session.expires, now + limits.catalogMs)),
            windows: result.windows.map(({ nativeId, ...window }) => {
              const targetId = randomUUID(), publicWindow = { ...window, targetId };
              this.targets.set(targetId, { nativeId, window: publicWindow }); return publicWindow;
            }) };
          this.catalogTimer = setTimeout(() => this.expireCatalog(), limits.catalogMs); this.catalogTimer.unref();
          this.outcome(result.status, result.reasons[0] ?? null);
        } else if (command.action === 'authorize') {
          const session = this.session!, target = this.targets.get(command.targetId)!;
          const result = await session.helper.authorize(target.nativeId); await assertCurrent();
          if (!this.catalog || !this.targets.has(command.targetId)) throw fault('TARGET_EXPIRED');
          if (usable(result.status)) { session.targetId = command.targetId; this.authorizedNativeId = target.nativeId; }
          else if (result.status === 'STALE') { this.invalidate('TARGET_STALE'); return; }
          this.outcome(result.status, result.reason);
        } else if (command.action === 'observe') {
          const session = this.session!;
          if (session.targetId !== command.targetId || !this.authorizedNativeId) throw fault('TARGET_UNKNOWN');
          this.tree = null; clearTimeout(this.treeTimer);
          const result = normalizeTree(await session.helper.observe(this.authorizedNativeId)); await assertCurrent();
          if (result.status === 'STALE' || result.reasons.includes('TARGET_STALE')) { this.invalidate('TARGET_STALE'); return; }
          if (session.targetId !== command.targetId) throw fault('TARGET_CHANGED');
          const now = this.now();
          this.tree = { ...result, version: 1, sessionId: session.id, requestId: command.requestId, snapshotId: randomUUID(), targetId: command.targetId,
            startedAt: iso(started), completedAt: iso(now), expiresAt: iso(Math.min(session.expires, now + limits.treeTtlMs)) };
          this.treeTimer = setTimeout(() => { this.tree = null; }, limits.treeTtlMs); this.treeTimer.unref();
          this.outcome(result.status, result.reasons[0] ?? null);
        }
      };
      await Promise.race([perform(), interrupted]);
      await Promise.race([assertCurrent(), interrupted]);
      this.event(command.requestId, command.action, 'targetId' in command ? command.targetId : null, started);
      return this.state();
    } catch (error) {
      if (initialEpoch !== this.epoch) {
        // A superseded caller cannot invalidate or receive a replacement session's observations.
        const reason = this.reason ?? 'CONTEXT_CHANGED';
        return { capability: 'desktop.observe', enabled: this.enabled, status: statusFor(reason), reason, session: null, catalog: null, tree: null, diagnostics: [] };
      }
      const reason = safeReason(error);
      if (['HELPER_TIMEOUT', 'HELPER_EXIT', 'HELPER_UNAVAILABLE', 'HELPER_IDENTITY', 'HELPER_PROTOCOL', 'RESPONSE_INVALID', 'TARGET_STALE', 'INPUT_DESKTOP_RESTRICTED', 'SYSTEM_SESSION_CHANGED', 'INTERNAL_FAILURE'].includes(reason)) this.invalidate(reason);
      this.status = statusFor(reason); this.reason = reason;
      if (work) this.event(command.requestId, command.action as Operation, 'targetId' in command ? command.targetId : null, started);
      return this.state();
    } finally {
      clearTimeout(timer); starting.helper?.stop(this.reason ?? 'CANCELLED');
      if (this.busy === reservation) this.busy = null;
    }
  }
}
