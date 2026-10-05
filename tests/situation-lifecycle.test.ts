// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SituationService } from '../electron/situation/service';
import { SituationStore } from '../electron/situation/store';
import { emptySituationConfig, type SituationConfig, type SituationLocation } from '../src/shared/situation';
import { flightQueryRevision, normalizeAircraft, normalizeTraffic, normalizeWeather } from '../electron/situation/providers';
import { normalizeFlightAware, normalizeFlightAwarePosition } from '../electron/situation/flightAware';
import { mappedAircraft } from '../src/shared/flightTracking';
import { situationEvidence } from '../electron/situation/evidence';
import { backgroundAuthority } from '../electron/agent/background';
import { defaults } from '../src/shared/contracts';
import { emptyGoogle } from '../src/shared/google';
import { initialAgentState } from '../src/shared/orchestration';
import { BackgroundStore } from '../electron/agent/background-store';
import { OrchestrationService } from '../electron/agent/service';
import { insightSchema } from '../src/shared/background';
import { resourceKey } from '../electron/context/manager';

const now = Date.parse('2026-09-29T12:00:00Z'), at = new Date(now).toISOString();
const place = (label: string): SituationLocation => ({ id: randomUUID(), label, latitude: 51.8, longitude: 4.6, timezone: 'Europe/Amsterdam', purpose: '', revision: '', updatedAt: at });
async function fixture() {
  const store = new SituationStore(), home = place('Fixture Home'), work = place('Fixture Work'); work.longitude = 4.7;
  const flight = { id: randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513', departureDate: '2026-09-29' };
  const route = { id: randomUUID(), label: 'Fixture commute', originId: home.id, destinationId: work.id, revision: '', updatedAt: at };
  const weather = { id: 'open-meteo', read: vi.fn(async (p: SituationLocation) => normalizeWeather({ current: { time: now / 1000, temperature_2m: 20 } }, p, now)) };
  const traffic = { id: 'tomtom', read: vi.fn(async () => normalizeTraffic({ routes: [{ summary: { travelTimeInSeconds: 900, lengthInMeters: 12000, trafficDelayInSeconds: 10 }, legs: [{ points: [{ latitude: 51.8, longitude: 4.6 }, { latitude: 51.8, longitude: 4.7 }] }] }] }, view.config.routes[0], now)) };
  const flights = { id: 'avioadsb', read: vi.fn(async () => ({ ...normalizeAircraft({ now, ac: [{ hex: 'abcdef', flight: 'WZZ4513', lat: 51.8, lon: 4.6, seen_pos: 0 }] }, [flight], now, 'avioadsb'), queryRevision: flightQueryRevision(undefined, [flight], flight.id), queriedFlightId: flight.id })) };
  const flightAware = { read: vi.fn(async () => normalizeFlightAware({ flights: [{ fa_flight_id: 'isolated-instance', ident_iata: 'W64513', scheduled_out: at, origin: { code_iata: 'VAR', timezone: 'Europe/Sofia' }, destination: { code_iata: 'EIN' }, status: 'En Route' }] }, 'W64513', '2026-09-29', now)), position: vi.fn(async () => normalizeFlightAwarePosition({ fa_flight_id: 'isolated-instance', last_position: { latitude: 51.8, longitude: 4.6, timestamp: at, update_type: 'A' } }, 'isolated-instance', now)) };
  const keys = { available: () => true, status: vi.fn(async () => 'configured' as 'configured' | 'missing'), read: vi.fn(async () => 'isolated-secret'), save: vi.fn(), remove: vi.fn() };
  const service = new SituationService(store, keys, async () => ({ enabled: true, network: true }), () => now, { weather, traffic, flights, flightAware });
  let view = await service.command({ action: 'configure', expectedRevision: 0, config: { ...emptySituationConfig(), locations: [home, work], routes: [route], defaultLocationId: home.id, defaultRouteId: route.id, trackedFlights: [flight], weatherEnabled: true, trafficEnabled: true, flightsEnabled: true, includeInBriefing: true } });
  const configure = async (patch: Partial<SituationConfig>) => view = await service.command({ action: 'configure', expectedRevision: view.config.revision, config: { ...view.config, ...patch } });
  return { service, store, home, work, route, flight, weather, traffic, flights, flightAware, keys, configure, view: () => view };
}
it('stops the last tracked flight and retires FlightAware current data without deleting accounting or querying providers', async () => {
  const f = await fixture();
  const live = await f.service.command({ action: 'refresh', source: 'flights', flightId: f.flight.id });
  expect(mappedAircraft(live, now)).toHaveLength(1);
  const before = await f.store.get(), requests = f.flightAware.read.mock.calls.length + f.flightAware.position.mock.calls.length + f.flights.read.mock.calls.length;
  const removed = await f.configure({ trackedFlights: [] });
  expect(removed.config.trackedFlights).toEqual([]); expect(removed.flights).toBeNull(); expect(removed.flightChecks).toEqual([]);
  expect(removed.flightAware?.result).toBeNull(); expect(removed.flightAware?.position).toBeNull(); expect(mappedAircraft(removed, now)).toEqual([]);
  const after = await f.store.get(); expect(after.requests).toEqual(before.requests); expect(after.flightAwareAccess).toEqual(before.flightAwareAccess); expect(after.aircraftAccess).toEqual(before.aircraftAccess);
  expect(f.flightAware.read.mock.calls.length + f.flightAware.position.mock.calls.length + f.flights.read.mock.calls.length).toBe(requests); expect(f.keys.save).not.toHaveBeenCalled(); expect(f.keys.remove).not.toHaveBeenCalled();
  const readded = await f.configure({ trackedFlights: [f.flight] }); expect(mappedAircraft(readded, now)).toEqual([]);
  await expect(f.service.command({ action: 'configure', config: live.config, expectedRevision: live.config.revision })).rejects.toMatchObject({ code: 'conflict' });
});
it.each(['latitude', 'label', 'purpose', 'timezone'] as const)('revises dependent routes and Weather after a place %s edit', async field => {
  const f = await fixture(); await f.service.command({ action: 'refresh', source: 'weather' });
  const old = f.view().config, value = field === 'latitude' ? 52 : field === 'timezone' ? 'Europe/Sofia' : 'Changed explicitly';
  const next = await f.configure({ locations: old.locations.map((p, i) => i ? p : { ...p, [field]: value }) });
  expect(next.config.locations[0].revision).not.toBe(old.locations[0].revision); expect(next.config.routes[0].revision).not.toBe(old.routes[0].revision); expect(next.weather).toBeNull();
  expect(f.weather.read).toHaveBeenCalledTimes(1); expect(f.traffic.read).not.toHaveBeenCalled();
});
it('rejects dangling routes, removes routes independently, and returns the last removed place to neutral state', async () => {
  const f = await fixture(), old = f.view().config;
  expect(() => f.service.command({ action: 'configure', expectedRevision: old.revision, config: { ...old, locations: [old.locations[1]], defaultLocationId: null } })).toThrow();
  const noRoute = await f.configure({ routes: [], defaultRouteId: null }); expect(noRoute.selectedRouteId).toBeNull(); expect(noRoute.traffic).toBeNull(); expect(noRoute.config.locations).toHaveLength(2);
  const none = await f.configure({ locations: [], defaultLocationId: null }); expect(none.selectedLocationId).toBeNull(); expect(none.weather).toBeNull(); expect(situationEvidence(none, 'isolated', now).entries).toEqual([]);
  expect(f.weather.read).not.toHaveBeenCalled(); expect(f.traffic.read).not.toHaveBeenCalled(); expect(f.flights.read).not.toHaveBeenCalled();
});
it('supports route rename and endpoint replacement with different revisions', async () => {
  const f = await fixture(), original = f.view().config.routes[0];
  const rename = await f.configure({ routes: [{ ...original, label: 'New route name' }] }); expect(rename.config.routes[0].revision).not.toBe(original.revision);
  const reversed = await f.configure({ routes: [{ ...rename.config.routes[0], originId: f.work.id, destinationId: f.home.id }] }); expect(reversed.config.routes[0].revision).not.toBe(rename.config.routes[0].revision); expect(f.traffic.read).not.toHaveBeenCalled();
});
it('keeps clock lifecycle independent, rejects new duplicate IANA aliases, and checks stale writes', async () => {
  const f = await fixture(), id = randomUUID();
  const added = await f.configure({ timezones: [{ id, label: 'Amsterdam', timezone: 'Europe/Amsterdam' }] });
  await expect(f.configure({ timezones: [...added.config.timezones, { id: randomUUID(), label: 'Duplicate', timezone: 'Europe/Amsterdam' }] })).rejects.toThrow('already has a clock');
  const replaced = await f.configure({ timezones: [{ id, label: 'Tokyo', timezone: 'Asia/Tokyo' }] }); expect(replaced.config.timezones[0].id).toBe(id);
  const empty = await f.configure({ timezones: [] }); expect(empty.config.locations).toEqual(added.config.locations);
  await expect(f.service.command({ action: 'configure', expectedRevision: added.config.revision, config: added.config })).rejects.toMatchObject({ code: 'conflict' });
  expect((await f.service.snapshot()).config).toEqual(empty.config); expect(f.keys.read).not.toHaveBeenCalled();
});
it('disables both flight providers, blocks explicit checks, preserves keys and allowances, and makes no request on re-enable', async () => {
  const f = await fixture(); await f.service.command({ action: 'refresh', source: 'flights', flightId: f.flight.id }); const before = await f.store.get();
  const disabled = await f.configure({ flightsEnabled: false, weatherEnabled: false, trafficEnabled: false });
  expect(disabled.statuses.map(s => s.state)).toEqual(['disabled', 'disabled', 'disabled']); expect(disabled.flightAware?.credential).toBe('configured'); expect(disabled.flightAware?.result).toBeNull();
  await expect(f.service.command({ action: 'refresh', source: 'flights', flightId: f.flight.id })).rejects.toThrow();
  await expect(f.service.command({ action: 'check-flightaware', flightNumber: 'W64513', departureDate: '2026-09-29' })).rejects.toThrow('disabled');
  await f.configure({ flightsEnabled: true }); expect(f.flightAware.read).toHaveBeenCalledOnce(); expect(f.flightAware.position).toHaveBeenCalledOnce(); expect(f.keys.remove).not.toHaveBeenCalled(); expect((await f.store.get()).flightAwareAccess).toEqual(before.flightAwareAccess);
});
it('keeps cooldown timestamps through unrelated configuration and source toggles', async () => {
  const f = await fixture(); await f.service.command({ action: 'refresh', source: 'weather' }); const before = await f.store.get();
  await f.configure({ weatherEnabled: false }); await f.configure({ weatherEnabled: true }); await f.service.command({ action: 'refresh', source: 'weather' });
  expect(f.weather.read).toHaveBeenCalledOnce(); expect((await f.store.get()).statuses).toEqual(before.statuses);
});
it('retires active evidence and changes Background/Context authority while request history remains', async () => {
  const f = await fixture(), live = await f.service.command({ action: 'refresh', source: 'weather' }), history = (await f.store.get()).requests;
  expect(situationEvidence(live, 'isolated', now).entries).toHaveLength(1);
  const authority = backgroundAuthority(defaults, initialAgentState(), emptyGoogle, live.config.revision);
  const next = await f.configure({ weatherEnabled: false });
  expect(situationEvidence(next, 'isolated', now).entries).toEqual([]); expect(backgroundAuthority(defaults, initialAgentState(), emptyGoogle, next.config.revision)).not.toBe(authority); expect((await f.store.get()).requests).toEqual(history);
});
it('uses the existing native invalidation hook to retire Background evidence without deleting history or invoking a model', async () => {
  const f = await fixture(), live = await f.service.command({ action: 'refresh', source: 'weather' });
  const ref = situationEvidence(live, 'isolated', now).entries[0].ref, digest = 'a'.repeat(64);
  const insight = insightSchema.parse({ version: 1, id: randomUUID(), runId: randomUUID(), workItemId: randomUUID(), accountId: 'isolated', profile: 'local', category: 'weather-change', title: 'Fixture evidence', summary: 'Controlled fixture', sources: [ref], sourceRevisions: [{ key: resourceKey(ref), revision: ref.revision }], provenance: { trigger: 'manual', authorityRevision: digest, method: 'deterministic', reason: 'Isolated test' }, observedAt: at, expiresAt: null, priority: 'normal', significance: 'informational', advisory: [], unresolvedQuestions: [], suggestedNextStep: null, ownerAttention: false, actionProposal: null, status: 'active', identity: digest, revisionIdentity: digest, supersedes: null, transitions: [] });
  const backgrounds = new BackgroundStore(); await backgrounds.commit([insight], 'isolated', digest, now, new Map([[resourceKey(ref), ref.revision]]));
  await f.configure({ routes: [], defaultRouteId: null, locations: [], defaultLocationId: null });
  const scopeChanged = vi.fn(async () => {});
  await OrchestrationService.prototype.situationChanged.call({ google: { state: async () => ({ activeAccountId: 'isolated' }) }, situation: f.service, backgrounds, now: () => now, scopeChanged } as unknown as OrchestrationService);
  const history = await backgrounds.all(); expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ id: insight.id, status: 'stale', sources: [ref] }); expect(history[0].transitions).toHaveLength(1); expect(scopeChanged).toHaveBeenCalledOnce();
});
