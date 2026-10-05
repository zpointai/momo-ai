// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptySituationConfig, freshnessState, situationConfigSchema, situationLayers, zonedClock, type SituationLocation, type CommuteRoute } from '../src/shared/situation';
import { SituationStore } from '../electron/situation/store';
import { SituationService } from '../electron/situation/service';
import { NativeSituationTransport, OpenMeteoWeather, TomTomTraffic, normalizeAircraft, normalizeTraffic, normalizeWeather, situationHash, SituationProviderError, flightQueryRevision } from '../electron/situation/providers';
import { situationEvidence } from '../electron/situation/evidence';
import { buildBriefing } from '../electron/agent/briefing';
import { backgroundContext, backgroundMetadata, deriveInsights } from '../electron/agent/background';
import { initialAgentState, type AgentRun } from '../src/shared/orchestration';
import { defaults } from '../src/shared/contracts';
import { selectBriefingContext, selectWorkflowContext } from '../electron/context/adapters';
import { allowedRequest, productionCsp } from '../electron/security';
import { invokeOperation } from '../electron/ipc/operations';
import { resourceDestination } from '../src/shared/modules';

// Synthetic contract inputs ONLY. Never saved to the owner profile or used in acceptance captures.
const epoch = Date.parse('2026-09-27T12:00:00Z'), at = new Date(epoch).toISOString();
const location = (label = 'Isolated test place'): SituationLocation => ({ id: randomUUID(), label, latitude: 52.1, longitude: 4.2, timezone: null, purpose: '', revision: 'a'.repeat(64), updatedAt: at });
const payload = (now = epoch, temperature = 18) => ({ timezone: 'Europe/Amsterdam', current: { time: now / 1000, temperature_2m: temperature, apparent_temperature: 17, weather_code: 2, relative_humidity_2m: 60, precipitation: 0, wind_speed_10m: 12, wind_direction_10m: 220 }, daily: { time: Array.from({ length: 5 }, (_, i) => (now + i * 86400000) / 1000), weather_code: [2, 2, 2, 2, 2], temperature_2m_max: [20, 20, 20, 20, 20], temperature_2m_min: [12, 12, 12, 12, 12], precipitation_probability_max: [10, 10, 10, 10, 10], uv_index_max: [3, 3, 3, 3, 3] } });
async function fixture(weatherOnly = false) {
  let now = epoch, enabled = true, network = true;
  const store = new SituationStore(), keys = { available: () => true, status: vi.fn(async () => 'missing' as const), read: vi.fn(async () => 'isolated-secret'), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  const weather = { id: 'open-meteo', read: vi.fn(async (p: SituationLocation) => normalizeWeather(payload(now), p, now)) }, traffic = { id: 'tomtom', read: vi.fn() };
  const service = new SituationService(store, keys, async () => ({ enabled, network, weatherOnly }), () => now, { weather, traffic });
  const p = location(), config = { ...emptySituationConfig(), locations: [p], defaultLocationId: p.id };
  const saved = await service.command({ action: 'configure', config, expectedRevision: 0 });
  return { store, keys, weather, traffic, service, p: saved.config.locations[0], config: saved.config, advance: (ms: number) => { now += ms; }, revoke: () => { enabled = false; }, block: () => { network = false; } };
}
describe('Situation contracts and provider boundaries', () => {
  it('starts empty and rejects inferred/invalid locations, routes, zones and extra secrets', () => {
    expect(emptySituationConfig().locations).toEqual([]);
    expect(emptySituationConfig().trackedFlights).toEqual([]);
    const p = location();
    expect(situationConfigSchema.safeParse({ ...emptySituationConfig(), secret: 'key' }).success).toBe(false);
    expect(situationConfigSchema.safeParse({ ...emptySituationConfig(), locations: [{ ...p, latitude: 91 }] }).success).toBe(false);
    expect(situationConfigSchema.safeParse({ ...emptySituationConfig(), locations: [p], routes: [{ id: randomUUID(), label: 'r', originId: p.id, destinationId: p.id, revision: '', updatedAt: at }] }).success).toBe(false);
    expect(situationConfigSchema.safeParse({ ...emptySituationConfig(), timezones: [{ id: randomUUID(), label: 'zone', timezone: 'Not/AZone' }] }).success).toBe(false);
  });
  it('uses real IANA daylight-saving transitions without a provider', () => {
    const winter = zonedClock('Europe/Amsterdam', Date.parse('2026-01-01T12:00:00Z')), summer = zonedClock('Europe/Amsterdam', epoch);
    expect(winter.time).toBe('13:00'); expect(summer.time).toBe('14:00'); expect(winter.offset).not.toBe(summer.offset);
    expect(zonedClock('America/New_York', Date.parse('2026-03-08T06:59:00Z')).time).toBe('01:59');
    expect(zonedClock('America/New_York', Date.parse('2026-03-08T07:00:00Z')).time).toBe('03:00');
  });
  it('normalizes missing fields and stale observations without inventing current values', () => {
    const p = location(), raw = payload(); delete (raw.current as Partial<typeof raw.current>).apparent_temperature;
    expect(normalizeWeather(raw, p, epoch)).toMatchObject({ partial: true, apparentC: null, temperatureC: 18 });
    expect(freshnessState(normalizeWeather(payload(epoch - 7200000), p, epoch).freshness, epoch)).toBe('stale');
    expect(() => normalizeWeather({ error: true }, p, epoch)).toThrow();
    expect(() => normalizeWeather(payload(epoch + 7200000), p, epoch)).toThrow();
  });
  it('sends one selected coordinate pair only, with no private label or purpose', async () => {
    const transport = { get: vi.fn(async () => payload()) }, p = { ...location(), label: 'Private label', purpose: 'Private purpose' };
    await new OpenMeteoWeather(transport, () => epoch).read(p);
    const url = transport.get.mock.calls[0] as unknown as [URL];
    expect(url[0].hostname).toBe('api.open-meteo.com'); expect(url[0].searchParams.get('latitude')).toBe('52.1');
    expect(url[0].href).not.toMatch(/Private|purpose|label|key=/);
  });
  it('normalizes route estimates and incidents without treating departure time as source time', async () => {
    const a = location(), b = { ...location(), longitude: 5 }, route: CommuteRoute = { id: randomUUID(), label: 'Isolated route', originId: a.id, destinationId: b.id, revision: 'b'.repeat(64), updatedAt: at };
    const raw = { routes: [{ summary: { travelTimeInSeconds: 1800, lengthInMeters: 42000, noTrafficTravelTimeInSeconds: 1200, historicTrafficTravelTimeInSeconds: 1500, trafficDelayInSeconds: 600, departureTime: at }, legs: [{ points: [{ latitude: 52, longitude: 4 }, { latitude: 53, longitude: 5 }] }], sections: [{ sectionType: 'TRAFFIC', simpleCategory: 'ROAD_WORK', startPointIndex: 0, endPointIndex: 1, delayInSeconds: 100 }] }] };
    const transport = { get: vi.fn(async () => ({ copyrightsCaption: '©TomTom' })), response: vi.fn(async () => ({ body: raw, cacheControl: 'no-cache, no-transform', age: 0, receivedAt: epoch })) }, result = await new TomTomTraffic(transport, () => epoch).read(route, a, b, 'isolated-secret');
    expect(result).toMatchObject({ durationSeconds: 1800, delaySeconds: 600, congestion: 'heavy', freshness: { observedAt: null }, incidents: [{ kind: 'roadworks' }] });
    expect(JSON.stringify(result)).not.toContain('isolated-secret');
    const malformed = structuredClone(raw); malformed.routes[0].legs[0].points[0].latitude = 100;
    expect(normalizeTraffic(malformed, route, epoch)).toMatchObject({ partial: true, geometry: [], incidents: [{ position: null }] });
  });
  it('keeps aircraft schedule and destinations unknown; omits stale/invalid positions', () => {
    const id = randomUUID(), tracked = [{ id, label: 'Isolated aircraft', kind: 'callsign' as const, identifier: 'TEST123' }];
    const result = normalizeAircraft({ now: epoch / 1000, ac: [{ hex: 'abcdef', flight: 'TEST123 ', lat: 52, lon: 4, seen_pos: 5, gs: 100, track: 90 }, { hex: '123456', lat: 51, lon: 3, seen_pos: 180 }] }, tracked, epoch);
    expect(result.aircraft).toHaveLength(1); expect(result.aircraft[0]).toMatchObject({ trackedId: id, origin: null, destination: null, altitudeFeet: null });
  });
  it('admits only anonymous basemap requests in the renderer', () => {
    expect(allowedRequest('https://tiles.openfreemap.org/styles/dark', false)).toBe(true);
    for (const url of ['https://api.tomtom.com/routing/1', 'https://api.open-meteo.com/v1/forecast', 'https://tiles.openfreemap.org/?key=secret', 'https://tiles.openfreemap.org.evil.test/a', 'https://key@tiles.openfreemap.org/a']) expect(allowedRequest(url, false)).toBe(false);
    expect(productionCsp).not.toContain('unsafe-eval');
  });
  it('bounds HTTP responses, rejects redirects/hosts and sanitizes credential-bearing errors', async () => {
    const native = new NativeSituationTransport();
    await expect(native.get(new URL('https://other.test/'))).rejects.toMatchObject({ code: 'response' });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('key=isolated-secret'));
    try { await expect(native.get(new URL('https://api.tomtom.com/test?key=isolated-secret'))).rejects.toMatchObject({ message: 'Situation source could not be read.' });
      fetcher.mockResolvedValue(new Response('0123456789')); await expect(native.get(new URL('https://api.tomtom.com/test'), 5)).rejects.toMatchObject({ code: 'response' });
      expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    } finally { fetcher.mockRestore(); }
  });
});
describe('Native situation lifecycle', () => {
  it('limits a weather-only review to the default saved place while retaining network and cooldown guards', async () => {
    const f = await fixture(true);
    await f.service.command({ action: 'refresh', source: 'weather', locationId: f.p.id });
    await f.service.command({ action: 'refresh', source: 'weather' });
    expect(f.weather.read).toHaveBeenCalledTimes(1);
    for (const source of ['traffic', 'flights'] as const) await expect(f.service.command({ action: 'refresh', source })).rejects.toThrow('only weather');
    await expect(f.service.command({ action: 'refresh', source: 'weather', locationId: randomUUID() })).rejects.toThrow('only weather');
    await expect(f.service.command({ action: 'search-places', query: 'Synthetic place' })).rejects.toThrow('only weather');
    await expect(f.service.command({ action: 'check-flightaware', flightNumber: 'KL123', departureDate: '2026-09-27' })).rejects.toThrow('only weather');
    expect(f.keys.read).not.toHaveBeenCalled(); expect(f.traffic.read).not.toHaveBeenCalled();
    f.block(); await expect(f.service.command({ action: 'refresh', source: 'weather' })).rejects.toThrow('off for this review');
    expect(f.weather.read).toHaveBeenCalledTimes(1);
  });
  it('reads, clock ticks and repeated UI requests never poll providers', async () => {
    const f = await fixture(); await f.service.snapshot(); expect(f.weather.read).not.toHaveBeenCalled();
    await Promise.all([f.service.command({ action: 'refresh', source: 'weather' }), f.service.command({ action: 'refresh', source: 'weather' })]);
    expect(f.weather.read).toHaveBeenCalledTimes(1); expect(f.keys.read).not.toHaveBeenCalled();
    f.advance(1800001); expect((await f.service.snapshot()).statuses[0].state).toBe('stale');
    expect(f.weather.read).toHaveBeenCalledTimes(1); await f.service.command({ action: 'refresh', source: 'weather' }); expect(f.weather.read).toHaveBeenCalledTimes(2);
  });
  it('changes place/route revision bindings and drops incompatible cache', async () => {
    const f = await fixture(); await f.service.command({ action: 'refresh', source: 'weather' });
    const config = { ...f.config, locations: [{ ...f.p, longitude: 6 }] };
    const saved = await f.service.command({ action: 'configure', config, expectedRevision: f.config.revision });
    expect(saved.weather).toBeNull(); expect(saved.config.locations[0].revision).not.toBe(f.p.revision);
    await expect(f.service.command({ action: 'configure', config, expectedRevision: 0 })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('retains the last check timestamp after aircraft data expires without retaining the live position', async () => {
    const f = await fixture(), flight = { id: randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513' };
    const config = { ...f.config, flightsEnabled: true, trackedFlights: [flight] };
    await f.service.command({ action: 'configure', config, expectedRevision: f.config.revision });
    const record = await f.store.get(), revision = flightQueryRevision(undefined, [flight], flight.id);
    record.flights = { ...normalizeAircraft({ ac: [], now: epoch }, [flight], epoch, 'avioadsb'), queryRevision: revision, queriedFlightId: flight.id };
    record.statuses.push({ source: 'flights', provider: 'avioadsb', state: 'available', detail: 'Source refreshed.', selectionRevision: revision, lastAttemptAt: at, lastError: null });
    await f.store.put(record); f.advance(120001);
    expect(await f.service.snapshot()).toMatchObject({ flights: null, flightChecks: [{ flightId: flight.id, at }] });
    f.revoke(); expect((await f.service.snapshot()).flightChecks).toEqual([]);
  });
  it('binds retry cooldown to the selected place and keeps failure diagnostics private', async () => {
    const f = await fixture(), p2 = location('Second isolated place');
    await f.service.command({ action: 'configure', expectedRevision: 1, config: { ...f.config, locations: [f.p, p2] } });
    f.weather.read.mockRejectedValue(new SituationProviderError('rate-limit'));
    const failed = await f.service.command({ action: 'refresh', source: 'weather' });
    expect(failed.statuses[0].state).toBe('error'); expect(failed.conditions).toEqual([]); // No prior observation; rate limits stay in source diagnostics.
    await f.service.command({ action: 'refresh', source: 'weather' }); expect(f.weather.read).toHaveBeenCalledTimes(1);
    await f.service.command({ action: 'refresh', source: 'weather', locationId: p2.id }); expect(f.weather.read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(failed.usage)).not.toMatch(/latitude|longitude|Isolated|secret/);
  });
  it('blocks review, disabled module, unconfigured traffic, and unapproved flight calls before reading secrets', async () => {
    const f = await fixture();
    await expect(f.service.command({ action: 'refresh', source: 'traffic' })).rejects.toThrow();
    await expect(f.service.command({ action: 'refresh', source: 'flights' })).rejects.toThrow();
    f.block(); await expect(f.service.command({ action: 'refresh', source: 'weather' })).rejects.toMatchObject({ code: 'permission_denied' });
    f.revoke(); expect((await f.service.snapshot()).statuses[0].state).toBe('disabled'); expect(f.keys.read).not.toHaveBeenCalled(); expect(f.weather.read).not.toHaveBeenCalled();
  });
  it('discards a response if native permission is revoked while it is in flight', async () => {
    const f = await fixture(); f.weather.read.mockImplementation(async p => { f.revoke(); return normalizeWeather(payload(), p, epoch); });
    await f.service.command({ action: 'refresh', source: 'weather' }); expect((await f.store.get()).weather).toEqual([]);
  });
  it('does not expose a secret through strict native IPC output, errors, or cache configuration', async () => {
    const f = await fixture();
    const saved = await invokeOperation('momo:situation:command', { action: 'save-traffic-key', secret: 'isolated-secret' }, true, input => f.service.command(input as Parameters<SituationService['command']>[0]));
    expect(saved.ok).toBe(true); expect(f.keys.save).toHaveBeenCalledWith('tomtom', 'isolated-secret'); expect(JSON.stringify(saved)).not.toContain('isolated-secret'); expect(f.keys.read).not.toHaveBeenCalled();
    const rejected = await invokeOperation('momo:situation:command', { action: 'snapshot', secret: 'isolated-secret' }, true, vi.fn()); expect(rejected.ok).toBe(false);
    expect((await invokeOperation('momo:situation:command', { action: 'snapshot' }, false, vi.fn())).ok).toBe(false);
  });
  it('persists versioned configuration and an append-only request receipt without touching SQLite', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'momo-situation-test-')), filename = path.join(dir, 'situation.json'), store = new SituationStore(filename), value = await store.get();
    value.config.locations = [location()]; await store.put(value); expect((await new SituationStore(filename).get()).config.locations).toHaveLength(1);
    await store.appendRequest({ id: randomUUID(), provider: 'tomtom', service: 'route', at, outcome: 'error', costUSD: null, pricing: 'unpriced', durationMs: 10 });
    expect(await readFile(filename + '.requests.jsonl', 'utf8')).not.toMatch(/latitude|longitude|secret|Isolated/);
    await writeFile(filename, '{broken'); await expect(new SituationStore(filename).get()).rejects.toThrow('preserved'); expect(await readFile(filename, 'utf8')).toBe('{broken');
  });
});
describe('Situation evidence in existing bounded intelligence', () => {
  it('includes only opted-in fresh selected facts and respects local-only, account, expiry, module and budget policy', async () => {
    const f = await fixture(); await f.service.command({ action: 'refresh', source: 'weather' }); const view = await f.service.snapshot();
    expect(situationEvidence(view, 'accountA', epoch).entries).toEqual([]); view.config.includeInBriefing = true;
    const state = initialAgentState(); state.config.enabled = true; state.config.paused = false;
    const build = () => buildBriefing({ accountId: 'accountA', now: epoch, timezone: 'Europe/Amsterdam', trigger: 'view', state, authorityRevision: situationHash(view.config), plannerEnabled: true, inboxEnabled: true, situation: view });
    let snapshot = build(); expect(snapshot.entries).toHaveLength(1); expect(snapshot.entries[0].detail).not.toMatch(/latitude|longitude|geometry/);
    expect(selectBriefingContext(snapshot, randomUUID(), state, defaults, epoch).context.items).toHaveLength(0);
    view.config.shareWithAI = true; snapshot = build(); const selection = selectBriefingContext(snapshot, randomUUID(), state, defaults, epoch);
    expect(selection.context.items[0].kind).toBe('situation'); expect(selection.selection.counts.FULL).toBe(1);
    expect(selectBriefingContext(snapshot, randomUUID(), state, { ...defaults, disabledModules: ['situation'] }, epoch).context.items).toHaveLength(0);
    expect(selectBriefingContext(snapshot, randomUUID(), state, defaults, epoch + 7200000).context.items).toHaveLength(0);
    expect(() => resourceDestination(snapshot.entries[0].ref, 'accountB', [], epoch)).toThrow('original account');
    expect(situationEvidence(view, 'accountA', epoch + 7200000).entries).toHaveLength(0);
    const small = { ...defaults, contextBudgets: { ...defaults.contextBudgets!, briefing: { maxBytes: 256, maxEstimatedTokens: 64, maxChunks: 1, summaryCharacters: 80 } } };
    const bounded = selectBriefingContext(snapshot, randomUUID(), state, small, epoch); expect(bounded.selection.selectedSize.bytes).toBeLessThanOrEqual(256);
  });
  it('promotes deterministic significant changes through native background evidence and preserves expiry/dedup identity', async () => {
    const f = await fixture(); await f.service.command({ action: 'refresh', source: 'weather' }); f.advance(1800001);
    f.weather.read.mockImplementation(async p => normalizeWeather(payload(epoch + 1800001, 26), p, epoch + 1800001));
    const view = await f.service.command({ action: 'refresh', source: 'weather' }); view.config.includeInBriefing = true;
    const state = initialAgentState(); state.config.enabled = true; state.config.paused = false;
    const snapshot = buildBriefing({ accountId: 'accountA', now: epoch + 1800001, timezone: 'Europe/Amsterdam', trigger: 'view', state, authorityRevision: situationHash('test'), plannerEnabled: true, inboxEnabled: true, situation: view });
    const event = { id: randomUUID(), family: 'briefing' as const, accountId: 'accountA', prompt: 'Review current facts', trigger: 'manual' as const, causationId: null, depth: 0, origin: 'user' as const };
    const raw = backgroundContext(snapshot), selected = selectWorkflowContext(raw, event, state, defaults, epoch + 1800001, true, true);
    const dense = structuredClone(snapshot); const seed = dense.entries[0];
    dense.entries = [...Array.from({ length: 6 }, (_, i) => ({ ...seed, id: 'e' + i, kind: 'calendar' as const, ref: { ...seed.ref, module: 'planner' as const, connector: 'google' as const, type: 'calendar' as const, id: 'e' + i } })), ...Array.from({ length: 4 }, (_, i) => ({ ...seed, id: 't' + i, kind: 'task' as const, ref: { ...seed.ref, module: 'planner' as const, connector: 'local' as const, type: 'task' as const, id: 't' + i } })), ...Array.from({ length: 4 }, (_, i) => ({ ...seed, id: 'w' + i, kind: 'workflow' as const, ref: { ...seed.ref, module: 'dashboard' as const, connector: 'local' as const, type: 'briefing' as const, id: 'w' + i } })), ...snapshot.entries];
    expect(backgroundContext(dense).items).toHaveLength(14); // six Inbox slots remain reserved
    expect(selected.context.items.every(i => i.delivery?.ref.module === 'situation')).toBe(true);
    const metadata = backgroundMetadata('manual', situationHash('authority'), raw, snapshot, defaults, 0);
    const run = { id: randomUUID(), event, context: selected.context, background: metadata, team: { items: [], specialistId: randomUUID() } } as unknown as AgentRun;
    const insights = deriveInsights(run, [], epoch + 1800001); expect(insights).toHaveLength(1); expect(insights[0].category).toBe('weather-change'); expect(insights[0].expiresAt).toBe(view.weather!.freshness.freshUntil);
    expect(deriveInsights(run, insights, epoch + 1800100)[0].revisionIdentity).toBe(insights[0].revisionIdentity);
    expect(selectWorkflowContext(raw, event, state, defaults, epoch + 1800001, true, false).context.items).toHaveLength(0);
    expect(situationLayers(view)).toMatchObject({ weather: true, traffic: false, flights: false, satellite: false, radar: false });
  });
});
