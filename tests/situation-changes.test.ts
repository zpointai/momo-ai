// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { conditionEvent, flightChange, flightPhase, trafficChanges, weatherChange } from '../src/shared/situationChanges';
import { emptySituationConfig, type SituationLocation, type TrafficSnapshot } from '../src/shared/situation';
import { normalizeFlightAware, normalizeFlightAwarePosition } from '../electron/situation/flightAware';
import { normalizeWeather, SituationProviderError } from '../electron/situation/providers';
import { deriveSituationConditions, FlightChangeFeed } from '../electron/situation/conditions';
import { SituationStore, emptySituationRecord } from '../electron/situation/store';
import { SituationService } from '../electron/situation/service';
import { situationEvidence } from '../electron/situation/evidence';

const epoch = Date.parse('2026-09-29T12:00:00Z'), iso = (now = epoch) => new Date(now).toISOString();
const place: SituationLocation = { id: randomUUID(), label: 'Fixture town', purpose: '', latitude: 51.8, longitude: 4.6, timezone: 'Europe/Amsterdam', updatedAt: iso(), revision: 'p' };
const tracked = { id: randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513', flightNumber: 'W64513', departureDate: '2026-09-29' };
const rawFlight = (patch = {}) => ({ ident_iata: 'W64513', fa_flight_id: 'fixture-instance', operator_icao: 'WZZ', operator_iata: 'W6', status: 'Scheduled', scheduled_out: iso(), origin: { timezone: 'Europe/Sofia', code_iata: 'VAR' }, destination: { timezone: 'Europe/Amsterdam', code_iata: 'EIN' }, ...patch });
const result = (patch = {}, now = epoch) => normalizeFlightAware({ flights: [rawFlight(patch)] }, 'W64513', '2026-09-29', now);
const weather = (now = epoch, temp = 18, code = 3, rain = 20) => normalizeWeather({ current: { time: now / 1000, temperature_2m: temp, weather_code: code, precipitation: 0 }, daily: { time: [epoch / 1000], precipitation_probability_max: [rain] } }, place, now);
const routeId = randomUUID();
const traffic = (duration = 600, incidents: TrafficSnapshot['incidents'] = []): TrafficSnapshot => ({ routeId, routeRevision: 'r', durationSeconds: duration, delaySeconds: duration - 600, freeFlowSeconds: 600, typicalSeconds: 600, distanceMeters: 10000, congestion: 'light', geometry: [], incidents, displayOnly: true, partial: false, freshness: { provider: 'tomtom', fetchedAt: iso(), observedAt: null, freshUntil: iso(epoch + 300000), revision: String(duration) + incidents.length, attribution: 'TomTom' } });

describe('Baseline and meaningful-change rules', () => {
  it('never announces first weather/rain/traffic observations as changes', () => {
    expect(weatherChange(undefined, weather(epoch, 18, 95, 90), place.label)).toBeNull();
    expect(trafficChanges(null, traffic(1500), 'Route', epoch)).toEqual([]);
  });
  it('ignores identical/insignificant weather, detects precipitation family and 5-degree thresholds', () => {
    const old = weather();
    expect(weatherChange(old, weather(epoch + 1800000), place.label)).toBeNull();
    expect(weatherChange(old, weather(epoch + 1800000, 22), place.label)).toBeNull();
    expect(weatherChange(old, weather(epoch + 1800000, 23), place.label)?.title).toContain('Temperature');
    expect(weatherChange(old, weather(epoch + 1800000, 18, 61), place.label)?.title).toContain('Rain');
    expect(weatherChange(weather(epoch, 18, 61), weather(epoch + 1800000, 18, 63), place.label)).toBeNull();
    expect(weatherChange(old, weather(epoch + 1800000, 18, 3, 80), place.label)?.title).toContain('Rain more likely');
    expect(weatherChange(old, weather(epoch + 86400001, 30, 95), place.label)).toBeNull();
  });
  it('keeps semantic weather events across unchanged refreshes without renewing their age/expiry', () => {
    const a = emptySituationRecord(); a.config = { ...emptySituationConfig(), locations: [place] }; a.weather = [weather()];
    const b = structuredClone(a); b.weather = [weather(epoch + 1800000, 26)]; b.conditions = deriveSituationConditions(a, b, epoch + 1800000); expect(b.conditions).toHaveLength(1);
    const c = structuredClone(b); c.weather = [weather(epoch + 1801000, 26)]; c.conditions = deriveSituationConditions(b, c, epoch + 1801000);
    expect(c.conditions).toHaveLength(1); expect(c.conditions[0]).toMatchObject({ id: b.conditions[0].id, observedAt: b.conditions[0].observedAt, expiresAt: b.conditions[0].expiresAt });
    expect(deriveSituationConditions(c, c, epoch + 3600001)).toEqual([]);
  });
  it('requires a weather baseline for actionable failure and resolves it on recovery', () => {
    const a = emptySituationRecord(); a.config.locations = [place];
    const b = structuredClone(a); b.statuses = [{ source: 'weather', provider: 'open-meteo', state: 'error', detail: 'Cannot refresh', selectionRevision: 'a'.repeat(64), lastAttemptAt: iso(), lastError: 'network' }]; b.config.locations[0].revision = 'a'.repeat(64);
    expect(deriveSituationConditions(a, b, epoch)).toEqual([]);
    a.weather = [{ ...weather(), locationRevision: 'a'.repeat(64) }]; b.weather = a.weather;
    b.conditions = deriveSituationConditions(a, b, epoch); expect(b.conditions[0].category).toBe('situation-source-unavailable');
    const c = structuredClone(b); c.statuses[0].state = 'available'; expect(deriveSituationConditions(b, c, epoch + 1000)).toEqual([]);
  });
  it('compares traffic only within the requesting view lifetime and avoids +15 → +16 duplicates', () => {
    expect(trafficChanges(traffic(), traffic(1500), 'Home → Work', epoch)).toHaveLength(1);
    expect(trafficChanges(traffic(1500), traffic(1560), 'Home → Work', epoch)).toEqual([]);
    expect(trafficChanges(traffic(1500), traffic(), 'Home → Work', epoch)[0].title).toContain('faster');
    expect(trafficChanges(traffic(), traffic(1500), 'Route', epoch + 300001)).toEqual([]);
    expect(trafficChanges(traffic(), { ...traffic(1500), routeRevision: 'other' }, 'Route', epoch)).toEqual([]);
    const incident = { id: '1', kind: 'closure' as const, description: 'Fixture closure', delaySeconds: 0, position: null, startIndex: null, endIndex: null };
    expect(trafficChanges(traffic(), traffic(600, [incident]), 'Route', epoch)[0].category).toBe('traffic-incident');
    expect(trafficChanges(traffic(600, [incident]), traffic(600, [{ ...incident, id: '2' }]), 'Route', epoch)).toEqual([]);
    expect(trafficChanges(traffic(600, [incident]), traffic(), 'Route', epoch)[0].title).toContain('cleared');
  });
});

describe('FlightAware semantic feed and migration', () => {
  it('establishes a baseline, replaces scheduled → out → off → on → in, and ignores refresh timestamps/positions', () => {
    const feed = new FlightChangeFeed(); feed.accept(tracked, result(), epoch); expect(feed.prune([tracked], true, epoch)).toEqual([]);
    let current = epoch;
    for (const [field, phase] of [['actual_out', 'taxiing'], ['actual_off', 'airborne'], ['actual_on', 'landed'], ['actual_in', 'arrived']] as const) {
      current += 60001; feed.accept(tracked, result({ [field]: iso(current) }, current), current);
      expect(feed.prune([tracked], true, current)).toHaveLength(1); expect(feed.prune([tracked], true, current)[0].title).toContain(phase);
      const id = feed.prune([tracked], true, current)[0].id;
      feed.accept(tracked, result({ [field]: iso(current), atc_ident: 'NEWCALL' }, current + 1), current + 1);
      expect(feed.prune([tracked], true, current + 1)[0].id).toBe(id);
    }
    expect(feed.prune([tracked], true, current + 900001)).toEqual([]);
  });
  it('uses supplied cancellation/diversion, ETA, delay and gate fields with useful thresholds', () => {
    const f = result().flights[0];
    expect(flightPhase({ ...f, estimatedOut: iso(epoch - 600000) })).toBe('scheduled');
    expect(flightChange(f, { ...f, cancelled: true }, 'Flight')?.title).toContain('cancelled');
    expect(flightChange(f, { ...f, diverted: true }, 'Flight')?.title).toContain('diverted');
    expect(flightChange({ ...f, estimatedIn: iso() }, { ...f, estimatedIn: iso(epoch + 540000) }, 'Flight')).toBeNull();
    expect(flightChange({ ...f, estimatedIn: iso() }, { ...f, estimatedIn: iso(epoch + 600000) }, 'Flight')?.title).toContain('arrival changed');
    expect(flightChange({ ...f, arrivalDelaySeconds: 0 }, { ...f, arrivalDelaySeconds: 900 }, 'Flight')?.detail).toContain('15 min');
    expect(flightChange({ ...f, gateOrigin: 'A1' }, { ...f, gateOrigin: 'A2' }, 'Flight')?.detail).toContain('A1 → A2');
    expect(flightChange(f, { ...f, gateOrigin: 'A2' }, 'Flight')).toBeNull();
    expect(flightChange(f, { ...f, id: 'another-day', actualOff: iso() }, 'Flight')).toBeNull();
  });
  it('requires two failed checks after a baseline; recovery, identity change and removal retire current events', () => {
    const feed = new FlightChangeFeed(); feed.unavailable(tracked, epoch); expect(feed.prune([tracked], true, epoch)).toEqual([]);
    feed.accept(tracked, result(), epoch); feed.unavailable(tracked, epoch + 60001); expect(feed.prune([tracked], true, epoch + 60001)).toEqual([]);
    feed.unavailable(tracked, epoch + 120002); expect(feed.prune([tracked], true, epoch + 120002)[0].category).toBe('situation-source-unavailable');
    feed.accept(tracked, result(), epoch + 180003); expect(feed.prune([tracked], true, epoch + 180003)).toEqual([]);
    feed.accept(tracked, result({ actual_off: iso() }), epoch + 240004); expect(feed.prune([], true, epoch + 240004)).toEqual([]);
    feed.accept(tracked, result(), epoch + 300005); feed.accept(tracked, result({ actual_off: iso() }), epoch + 360006); expect(feed.prune([tracked], false, epoch + 360006)).toEqual([]);
  });
  it('wires real service Refresh to FlightAware conditions, without additional provider calls or persisted commercial facts', async () => {
    let now = epoch, patch = {};
    const store = new SituationStore(), keys = { available: () => true, status: vi.fn(async (key: string) => key === 'flightaware' ? 'configured' as const : 'missing' as const), read: vi.fn(async () => 'fixture-secret'), save: vi.fn(), remove: vi.fn() };
    const provider = { read: vi.fn(async () => result(patch, now)), position: vi.fn(async () => normalizeFlightAwarePosition({ fa_flight_id: 'fixture-instance', last_position: null }, 'fixture-instance', now)) };
    const service = new SituationService(store, keys, async () => ({ enabled: true, network: true }), () => now, { flightAware: provider });
    await service.command({ action: 'configure', expectedRevision: 0, config: { ...emptySituationConfig(), flightsEnabled: true, trackedFlights: [tracked] } });
    const refresh = () => service.command({ action: 'refresh', source: 'flights', flightId: tracked.id });
    expect((await refresh()).conditions).toEqual([]);
    now += 60001; patch = { actual_out: iso(now), status: 'Taxiing / Left Gate' }; expect((await refresh()).conditions[0].title).toContain('taxiing');
    now += 60001; patch = { actual_off: iso(now), status: 'En Route' }; const changed = await refresh(); expect(changed.conditions[0].title).toContain('airborne');
    now += 60001; const stable = await refresh(); expect(stable.conditions[0].id).toBe(changed.conditions[0].id);
    expect(provider.read).toHaveBeenCalledTimes(4); expect(provider.position).toHaveBeenCalledTimes(4);
    const saved = await store.get(); expect(saved.conditions).toEqual([]); expect(JSON.stringify(saved)).not.toContain('fixture-instance'); expect(saved.requests).toHaveLength(8);
    const restarted = new SituationService(store, keys, async () => ({ enabled: true, network: true }), () => now, { flightAware: provider }); expect((await restarted.snapshot()).conditions).toEqual([]);
    changed.config.includeInBriefing = true; expect(situationEvidence(changed, null, now).entries[0].title).toContain('airborne');
    const ephemeral = { ...changed, conditions: [conditionEvent('traffic', routeId, 'r', iso(now + 1000), { category: 'commute-delay', title: 'Traffic', detail: 'Restricted', attention: true }, now, true)] };
    expect(situationEvidence(ephemeral, null, now).entries).toEqual([]);
    provider.read.mockRejectedValue(new SituationProviderError('network')); now += 60001; await refresh(); now += 60001; expect((await refresh()).conditions[0].category).toBe('situation-source-unavailable');
  });
});
