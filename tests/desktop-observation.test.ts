// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { settingsSchema, defaults } from '../src/shared/contracts';
import { observationCommandSchema, observationText, observationTreeDataSchema, desktopObservationLimits as limits,
  type NodeObservation, type DesktopObservationState } from '../src/shared/desktop-observation';
import { normalizeCatalog, normalizeTree, boundedJson, type NativeCatalog, type NativeTree } from '../electron/desktop-observation/normalize';
import { DesktopObservationService, type ObservationAuthority } from '../electron/desktop-observation/service';
import { encodeHelperRequest, type ObservationHelper } from '../electron/desktop-observation/helper-client';
import { invokeOperation } from '../electron/ipc/operations';

const known = <T,>(value: T) => ({ state: 'known' as const, value });
const unsupported = { state: 'unsupported' as const };
const node = (patch: Partial<NodeObservation> = {}): NodeObservation => ({
  id: 'n0', parentId: null, role: 'button', name: known('Save'), automationId: known('save'), className: known('Button'),
  enabled: known(true), offscreen: known(false), keyboardFocusable: known(true), hasKeyboardFocus: known(false),
  readOnly: unsupported, selected: unsupported, toggle: unsupported, expansion: unsupported, bounds: unsupported,
  patterns: known(['invoke']), protectedContent: known(false), ...patch,
});
const tree = (nodes = [node()]): NativeTree => ({ status: 'AVAILABLE', reasons: [], limitsHit: [], elapsedMs: 10, nodes, visitedNodes: nodes.length, foreground: known(false), containsKeyboardFocus: known(false), focus: { state: 'outside-target' } });
const catalog = (): NativeCatalog => ({ status: 'AVAILABLE', reasons: [], limitsHit: [], elapsedMs: 10, examinedCandidates: 2,
  windows: [1, 2].map(ordinal => ({ nativeId: randomUUID(), pid: 10, application: known('Calculator.exe'), windowOrdinal: ordinal,
    visible: known(true), state: known('normal'), foreground: known(false), containsKeyboardFocus: known(false), bounds: unsupported, elevation: known('standard'), accessibility: 'not-checked' })) });
const caller = { rendererId: 7, generation: 1 };
const services: DesktopObservationService[] = [];
function harness(enabled = true) {
  const authority: ObservationAuthority = { enabled, paused: false, policyRevision: 1, contextKey: 'profile-1' };
  const helper: ObservationHelper = { start: vi.fn(async () => undefined), list: vi.fn(async () => catalog()),
    authorize: vi.fn(async () => ({ status: 'AVAILABLE', reason: null })), observe: vi.fn(async () => tree()), stop: vi.fn() };
  const confirm = vi.fn(async () => true), factory = vi.fn(() => helper);
  const service = new DesktopObservationService({ authority: async () => ({ ...authority }), helper: factory, confirm });
  services.push(service);
  let state: DesktopObservationState;
  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    state = await service.command({ action, requestId: randomUUID(), ...(['status', 'begin'].includes(action) ? {} : { sessionId: state.session?.id }), ...extra }, caller);
    return state;
  };
  const advance = () => vi.advanceTimersByTimeAsync(1000);
  const prepare = async () => { await call('begin'); await advance(); await call('list'); await advance(); const id = state.catalog!.windows[0].targetId; await call('authorize', { targetId: id }); await advance(); return id; };
  return { authority, helper, service, confirm, factory, call, advance, prepare, state: () => state };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z')); });
afterEach(() => { for (const s of services.splice(0)) s.invalidate('SHUTDOWN'); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Desktop Observation contracts and release filtering', () => {
  it('cancels a pending begin before a session exists and ignores later confirmation', async () => {
    const h = harness(); let answer!: (value: boolean) => void;
    h.confirm.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const requestId = randomUUID();
    const pending = h.service.command({ action: 'begin', requestId }, caller);
    await vi.advanceTimersByTimeAsync(0);
    const cancelled = await h.service.command({ action: 'cancel', requestId: randomUUID(), cancelRequestId: requestId }, caller);
    expect(cancelled.session).toBeNull(); expect(cancelled.reason).toBe('CANCELLED');
    answer(true); expect((await pending).session).toBeNull(); expect(h.factory).not.toHaveBeenCalled();
  });
  it('binds pending-begin cancellation to its renderer generation and exact request', async () => {
    const h = harness(); h.confirm.mockImplementation(() => new Promise(() => {}));
    const requestId = randomUUID(), pending = h.service.command({ action: 'begin', requestId }, caller);
    await vi.advanceTimersByTimeAsync(0);
    for (const input of [{ caller: { ...caller, generation: 2 }, id: requestId }, { caller, id: randomUUID() }]) {
      await expect(h.service.command({ action: 'cancel', requestId: randomUUID(), cancelRequestId: input.id }, input.caller)).rejects.toThrow(/REQUEST_INVALID/);
    }
    await h.service.command({ action: 'cancel', requestId: randomUUID(), cancelRequestId: requestId }, caller);
    expect((await pending).session).toBeNull();
  });
  it('cancels a begin blocked in the authority lookup without waiting for it', async () => {
    let authority!: (value: ObservationAuthority) => void;
    const factory = vi.fn();
    const service = new DesktopObservationService({ authority: () => new Promise(resolve => { authority = resolve; }), helper: factory, confirm: async () => true });
    services.push(service);
    const requestId = randomUUID(), pending = service.command({ action: 'begin', requestId }, caller);
    expect((await service.command({ action: 'cancel', requestId: randomUUID(), cancelRequestId: requestId }, caller)).reason).toBe('CANCELLED');
    authority({ enabled: true, paused: false, policyRevision: 0, contextKey: 'test' });
    expect((await pending).session).toBeNull(); expect(factory).not.toHaveBeenCalled();
  });
  it('defaults to off without migrating or adding the optional permission', () => {
    expect(settingsSchema.parse(defaults).desktopObservation).toBeUndefined();
    expect(settingsSchema.safeParse({ ...defaults, desktopObservation: { enabled: true, shareWithAI: true } }).success).toBe(false);
  });
  it.each(['click', 'scroll', 'type', 'SetFocus', 'launch', 'Invoke', 'SetValue', 'dispatch', 'screenshot'])('rejects prohibited command %s', action => {
    expect(observationCommandSchema.safeParse({ action, requestId: randomUUID() }).success).toBe(false);
    expect(() => encodeHelperRequest(action as 'list', 1)).toThrow(/REQUEST_INVALID/);
  });
  it('rejects native selectors, forged shapes, handles and renderer limits', async () => {
    for (const field of ['hwnd', 'propertyId', 'selector', 'depth', 'coordinates', 'executable']) {
      const execute = vi.fn();
      const result = await invokeOperation('momo:desktop-observation:command', { action: 'begin', requestId: randomUUID(), [field]: 1 }, true, execute);
      expect(result.ok).toBe(false); expect(execute).not.toHaveBeenCalled();
    }
    expect(() => encodeHelperRequest('observe', 1, '123')).toThrow(/REQUEST_INVALID/);
  });
  it('enforces trusted sender, UTF-8 request bytes and result schema at IPC', async () => {
    const execute = vi.fn(); const input = { action: 'status', requestId: randomUUID() };
    expect((await invokeOperation('momo:desktop-observation:command', input, false, execute)).ok).toBe(false);
    expect((await invokeOperation('momo:desktop-observation:command', { ...input, text: '界'.repeat(2000) }, true, execute)).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect((await invokeOperation('momo:desktop-observation:command', input, true, async () => ({ rawException: 'secret' }))).ok).toBe(false);
  });
  it('bounds enumeration, uniqueness and application basenames', () => {
    const c = catalog(); expect(normalizeCatalog(c).windows).toHaveLength(2);
    expect(() => normalizeCatalog({ ...c, examinedCandidates: 1025 })).toThrow(/RESPONSE_INVALID/);
    expect(() => normalizeCatalog({ ...c, windows: Array.from({ length: 65 }, () => ({ ...c.windows[0], nativeId: randomUUID() })) })).toThrow();
    expect(() => normalizeCatalog({ ...c, windows: [c.windows[0], c.windows[0]] })).toThrow();
    expect(() => normalizeCatalog({ ...c, windows: [{ ...c.windows[0], application: known('C:\\secret.txt') }] })).toThrow();
  });
  it('rejects cycles, duplicate IDs, orphans, multiple roots and foreign focus references', () => {
    for (const nodes of [[node({ parentId: 'n0' })], [node(), node()], [node(), node({ id: 'n1', parentId: 'n2' })], [node(), node({ id: 'n1' })]]) expect(() => normalizeTree(tree(nodes))).toThrow(/RESPONSE_INVALID/);
    expect(() => normalizeTree({ ...tree(), focus: { state: 'in-target', nodeId: 'n1' } })).toThrow();
  });
  it('enforces depth, visited nodes, per-field strings, aggregate strings, bytes and finite bounds', () => {
    const deep = Array.from({ length: 14 }, (_, i) => node({ id: `n${i}`, parentId: i ? `n${i - 1}` : null, role: 'pane' }));
    expect(() => normalizeTree(tree(deep))).toThrow();
    expect(() => normalizeTree({ ...tree(), visitedNodes: 513 })).toThrow();
    expect(() => normalizeTree(tree(Array.from({ length: 513 }, (_, i) => node({ id: `n${i}`, parentId: i ? 'n0' : null }))))).toThrow();
    expect(() => normalizeTree(tree([node({ name: known('a'.repeat(161)) })]))).toThrow();
    expect(() => normalizeTree(tree(Array.from({ length: 100 }, (_, i) => node({ id: `n${i}`, parentId: i ? 'n0' : null, name: known('界'.repeat(100)) }))))).toThrow();
    expect(() => boundedJson({ data: 'a'.repeat(limits.responseBytes) })).toThrow();
    expect(() => normalizeTree(tree([node({ bounds: known({ x: Infinity, y: 0, width: 1, height: 1 }) })]))).toThrow();
  });
  it.each(['\ud800', 'ok\u202eevil', 'nul\u0000', 'line\nfeed'])('rejects unsafe encoding %j', text => expect(observationText(160).safeParse(text).success).toBe(false));
  it('preserves unsupported states and reads availability as data, without action authority', () => {
    const result = normalizeTree(tree()); expect(result.nodes[0].readOnly).toEqual(unsupported);
    expect(result.nodes[0].patterns).toEqual(known(['invoke']));
    expect(observationTreeDataSchema.safeParse({ ...tree(), nodes: [{ ...node(), invoke: true }] }).success).toBe(false);
  });
  it('rejects contradictory in-target focus and preserves current target focus metadata', () => {
    const focus = { state: 'in-target', nodeId: 'n0' };
    expect(() => normalizeTree({ ...tree(), focus })).toThrow();
    const valid = { ...tree([node({ hasKeyboardFocus: known(true) })]), focus, foreground: known(true), containsKeyboardFocus: known(true) };
    expect(normalizeTree(valid).focus).toEqual(focus);
  });
  it('redacts strings when protected, unknown, unsupported, unavailable or content-bearing', () => {
    for (const protection of [known(true), { state: 'unknown' as const }, unsupported, { state: 'unavailable' as const }]) {
      const n = normalizeTree(tree([node({ protectedContent: protection })])).nodes[0];
      expect([n.name, n.automationId, n.className]).toEqual(Array(3).fill({ state: 'redacted' }));
      expect(() => normalizeTree(tree([node({ protectedContent: protection }), node({ id: 'n1', parentId: 'n0' })]))).toThrow();
    }
    for (const role of ['edit', 'document', 'listitem', 'datagrid', 'dataitem', 'text', 'image', 'custom'] as const) {
      expect(normalizeTree(tree([node({ role })])).nodes[0].name.state).toBe('redacted');
      expect(() => normalizeTree(tree([node({ role }), node({ id: 'n1', parentId: 'n0' })]))).toThrow();
    }
  });
});

describe('Main-owned authority, lifecycle and supervision', () => {
  it('does no native work while disabled or paused', async () => {
    const h = harness(false); expect((await h.call('begin')).reason).toBe('PERMISSION_DISABLED');
    h.authority.enabled = true; h.authority.paused = true;
    expect((await h.call('begin')).reason).toBe('GLOBAL_PAUSE'); expect(h.factory).not.toHaveBeenCalled();
  });
  it('requires owner confirmation, current session and listed target tokens', async () => {
    const h = harness(); h.confirm.mockResolvedValueOnce(false);
    expect((await h.call('begin')).reason).toBe('OWNER_DECLINED'); expect(h.factory).not.toHaveBeenCalled();
    await h.advance(); await h.call('begin'); await h.advance(); await h.call('list'); await h.advance();
    expect((await h.call('authorize', { targetId: randomUUID() })).reason).toBe('TARGET_UNKNOWN');
    expect(h.helper.authorize).not.toHaveBeenCalled();
    expect((await h.service.command({ action: 'list', requestId: randomUUID(), sessionId: randomUUID() }, caller)).reason).toBe('SESSION_REQUIRED');
  });
  it('issues new public target IDs and rejects stale catalog generations', async () => {
    const h = harness(); const id = await h.prepare(); await h.call('observe', { targetId: id }); await h.advance();
    const refreshed = await h.call('list'); expect(refreshed.tree).toBeNull(); expect(refreshed.session?.targetId).toBeNull();
    await h.advance(); expect((await h.call('authorize', { targetId: id })).reason).toBe('TARGET_UNKNOWN');
    expect(refreshed.catalog?.windows[0].targetId).not.toBe(id);
  });
  it('clears the previous tree before target confirmation, including declined changes', async () => {
    const h = harness(); const id = await h.prepare(); await h.call('observe', { targetId: id }); await h.advance();
    h.confirm.mockResolvedValueOnce(false); const other = h.state().catalog!.windows[1].targetId;
    const result = await h.call('authorize', { targetId: other }); expect(result.tree).toBeNull(); expect(result.session?.targetId).toBeNull();
  });
  it('enforces one active operation, one-second spacing, 30/minute and replay rejection', async () => {
    const h = harness(); await h.call('begin'); expect((await h.call('list')).reason).toBe('RATE_LIMITED'); await h.advance();
    const id = randomUUID(); await h.call('list', { requestId: id }); await h.advance();
    expect((await h.call('list', { requestId: id })).reason).toBe('REQUEST_REPLAY');
    for (let i = 0; i < 28; ++i) { await h.call('list'); await h.advance(); }
    expect((await h.call('list')).reason).toBe('RATE_LIMITED');
  });
  it('terminates on cancellation and ignores a late native reply', async () => {
    const h = harness(); const id = await h.prepare(); let finish!: (value: NativeTree) => void;
    vi.mocked(h.helper.observe).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const requestId = randomUUID(), pending = h.call('observe', { targetId: id, requestId }); await vi.advanceTimersByTimeAsync(0);
    expect((await h.call('list')).reason).toBe('BUSY');
    const result = await h.call('cancel', { cancelRequestId: requestId }); expect(result.session).toBeNull(); expect(result.tree).toBeNull();
    expect(h.helper.stop).toHaveBeenCalledWith('CANCELLED'); finish(tree());
    expect((await pending).tree).toBeNull(); expect((await h.call('status')).tree).toBeNull();
  });
  it('kills a hung helper on the whole-request deadline without retry', async () => {
    const h = harness(); vi.mocked(h.helper.start).mockImplementationOnce(() => new Promise(() => {}));
    const pending = h.call('begin'); await vi.advanceTimersByTimeAsync(3000);
    const result = await pending; expect(result.reason).toBe('HELPER_TIMEOUT'); expect(result.session).toBeNull();
    expect(h.helper.stop).toHaveBeenCalledWith('HELPER_TIMEOUT'); expect(h.factory).toHaveBeenCalledTimes(1);
  });
  it('bounds an authority lookup before helper startup and discards its late resolution', async () => {
    let resolve!: (authority: ObservationAuthority) => void;
    const factory = vi.fn();
    const service = new DesktopObservationService({ authority: () => new Promise(done => { resolve = done; }), helper: factory, confirm: async () => true });
    services.push(service);
    const pending = service.command({ action: 'begin', requestId: randomUUID() }, caller);
    await vi.advanceTimersByTimeAsync(3000); expect((await pending).reason).toBe('HELPER_TIMEOUT');
    resolve({ enabled: true, paused: false, policyRevision: 1, contextKey: 'x' }); await vi.advanceTimersByTimeAsync(0);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['permission', 'policy', 'profile', 'renderer', 'system', 'shutdown'] as const)('clears data and rejects late work on %s change', async change => {
    const h = harness(); const id = await h.prepare(); let finish!: (value: NativeTree) => void;
    vi.mocked(h.helper.observe).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.call('observe', { targetId: id }); await vi.advanceTimersByTimeAsync(0);
    if (change === 'permission') h.authority.enabled = false;
    if (change === 'policy') ++h.authority.policyRevision;
    if (change === 'profile') h.authority.contextKey = 'profile-2';
    if (change === 'renderer') await h.service.command({ action: 'status', requestId: randomUUID() }, { ...caller, generation: 2 });
    if (change === 'system') h.service.invalidate('SYSTEM_SESSION_CHANGED');
    if (change === 'shutdown') h.service.invalidate('SHUTDOWN');
    finish(tree()); const result = await pending;
    expect(result.tree).toBeNull(); expect(result.catalog).toBeNull(); expect(result.session).toBeNull(); expect(result.diagnostics).toEqual([]);
    expect(h.helper.stop).toHaveBeenCalled();
  });
  it('expires trees at 15s, catalog labels at 30s, authorization at 5min without restart', async () => {
    const h = harness(); const id = await h.prepare(); await h.call('observe', { targetId: id });
    await vi.advanceTimersByTimeAsync(15000); expect((await h.call('status')).tree).toBeNull();
    await vi.advanceTimersByTimeAsync(15000); expect((await h.call('status')).catalog).toBeNull();
    expect((await h.call('observe', { targetId: id })).tree).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300000); const result = await h.call('status');
    expect(result.reason).toBe('SESSION_EXPIRED'); expect(result.session).toBeNull(); expect(result.diagnostics).toEqual([]); expect(h.factory).toHaveBeenCalledTimes(1);
  });
  it('returns safe errors and content-free diagnostics, never raw provider exception text', async () => {
    const h = harness(); const id = await h.prepare(); const result = await h.call('observe', { targetId: id });
    const diagnostic = JSON.stringify(result.diagnostics); expect(diagnostic).not.toMatch(/Calculator|Save|Button|save|nativeId|pid/);
    expect(result.diagnostics.length).toBeLessThanOrEqual(200);
    await h.advance(); vi.mocked(h.helper.observe).mockRejectedValueOnce(new Error('C:\\secret PRIVATE PASSWORD'));
    const failed = await h.call('observe', { targetId: id }); expect(failed.reason).toBe('INTERNAL_FAILURE'); expect(JSON.stringify(failed)).not.toContain('PRIVATE');
  });
  it('caps diagnostic metadata at 200 even under rejected-request flooding', async () => {
    const h = harness(); await h.call('begin');
    for (let i = 0; i < 250; ++i) await h.call('list');
    expect(h.state().diagnostics).toHaveLength(200);
    expect((await h.call('end')).diagnostics).toEqual([]);
  });
  it('invalidates a stale status response as well as a native stale fault', async () => {
    const h = harness(); const id = await h.prepare();
    vi.mocked(h.helper.observe).mockResolvedValueOnce({ ...tree([]), status: 'STALE', reasons: ['TARGET_STALE'] });
    const result = await h.call('observe', { targetId: id });
    expect(result.session).toBeNull(); expect(result.tree).toBeNull(); expect(result.catalog).toBeNull();
    expect(h.helper.stop).toHaveBeenCalledWith('TARGET_STALE');
  });
  it('rejects malformed helper results before release and stops its helper', async () => {
    const h = harness(); const id = await h.prepare(); vi.mocked(h.helper.observe).mockResolvedValueOnce(tree([node({ parentId: 'n0' })]));
    const result = await h.call('observe', { targetId: id }); expect(result.reason).toBe('RESPONSE_INVALID'); expect(result.tree).toBeNull(); expect(h.helper.stop).toHaveBeenCalled();
  });
  it('has no persistence or model/tool registration imports', () => {
    const source = readFileSync('electron/desktop-observation/service.ts', 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:storage|agent|google|context|sqlite|node:fs)|localStorage|writeFile|AgentRun|console\./);
    for (const file of ['electron/agent/policy.ts', 'electron/agent/service.ts', 'src/shared/modules.ts', 'src/shared/orchestration.ts']) expect(readFileSync(file, 'utf8')).not.toMatch(/desktop\.observe|desktop-observation|DesktopObservation/);
    const main = readFileSync('electron/main.ts', 'utf8');
    for (const event of ['lock-screen', 'suspend', 'shutdown', 'did-start-navigation', 'render-process-gone', 'destroyed', 'session-end']) expect(main).toContain(`'${event}'`);
    expect(main).not.toMatch(/(?:resume|unlock-screen).*desktopObservation.*(?:begin|command|start)/);
  });
});
