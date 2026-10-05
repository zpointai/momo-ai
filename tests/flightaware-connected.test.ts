// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { SituationService } from '../electron/situation/service';
import { SituationStore } from '../electron/situation/store';
import { NativeFlightAware, normalizeFlightAware, normalizeFlightAwarePosition } from '../electron/situation/flightAware';
import { flightTrackingView, freshAircraft, mappedAircraft, positionLabel } from '../src/shared/flightTracking';
import { aircraftMotion, animateAircraft } from '../src/desktop/situation/aircraftMotion';

const epoch = Date.parse('2026-09-28T15:00:00Z'), tracking = { id: randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513' };
const flight = { fa_flight_id: 'isolated-flight-instance', ident_iata: 'W64513', scheduled_out: '2026-09-28T13:05:00Z', origin: { code_iata: 'VAR', timezone: 'Europe/Sofia' }, destination: { code_iata: 'EIN', timezone: 'Europe/Amsterdam' }, status: 'En Route' };
const rawPosition = { fa_flight_id: flight.fa_flight_id, last_position: { latitude: 50.2, longitude: 6.3, altitude: 340, groundspeed: 440, heading: 287, timestamp: '2026-09-28T14:59:30Z', update_type: 'A' } };
const refresh = { action: 'refresh' as const, source: 'flights' as const, flightId: tracking.id };
afterEach(() => vi.unstubAllGlobals());
async function fixture(limit = 400) {
  let now = epoch;
  const store = new SituationStore(), record = await store.get();
  record.config = { ...record.config, trackedFlights: [tracking], flightsEnabled: true, flightAwareMonthlyLimitCents: limit }; await store.put(record);
  const provider = { read: vi.fn(async () => normalizeFlightAware({ flights: [flight] }, 'W64513', '2026-09-28', now)), position: vi.fn(async (id: string) => normalizeFlightAwarePosition(rawPosition, id, now)) };
  const avio = { id: 'avioadsb', read: vi.fn() }, keys = { available: () => true, status: vi.fn(async () => 'configured' as const), read: vi.fn(async () => 'isolated-secret'), save: vi.fn(), remove: vi.fn() };
  const service = () => new SituationService(store, keys, async () => ({ enabled: true, network: true }), () => now, { flightAware: provider, flights: avio });
  return { store, provider, avio, service, advance: (ms = 60001) => { now += ms; } };
}
it('retrieves status and verified flight-instance position once; snapshots and rapid refresh reuse results', async () => {
  const f = await fixture(), service = f.service(), result = await service.command(refresh);
  expect(f.provider.position).toHaveBeenCalledWith(flight.fa_flight_id, 'isolated-secret'); expect(f.avio.read).not.toHaveBeenCalled();
  expect(result.flightAware).toMatchObject({ requests: 2, estimatedMilliUSD: 15, limitMilliUSD: 4000 });
  expect(flightTrackingView(result, tracking, epoch).scheduleStatus.state).toBe('connected');
  expect(freshAircraft(result, epoch)[0]).toMatchObject({ icao: '', flightAwareId: flight.fa_flight_id, altitudeFeet: 34000, groundSpeedKnots: 440 });
  await service.command(refresh); await service.snapshot(); expect(f.provider.read).toHaveBeenCalledTimes(1); expect(f.provider.position).toHaveBeenCalledTimes(1);
  const stored = await f.store.get(); expect(stored.flights).toBeNull(); expect(JSON.stringify(stored)).not.toContain(flight.fa_flight_id); expect(stored.requests.map(r=>r.outcome)).toEqual(['success','success']);
});
it('retains schedule if the position call fails, counts it and suppresses upstream secrets', async () => {
  const f = await fixture(); f.provider.position.mockRejectedValue(new Error('isolated-secret'));
  const result = await f.service().command(refresh);
  expect(result.flightAware?.result?.flights).toHaveLength(1); expect(result.flightAware?.positionError).toContain('could not return'); expect(result.flightAware?.estimatedMilliUSD).toBe(15);
  expect(JSON.stringify(result)).not.toContain('isolated-secret'); expect(mappedAircraft(result, epoch)).toEqual([]);
});
it('enforces mixed-price reservations across restart and safely migrates the old status-only counter', async () => {
  const f = await fixture(2); await f.service().command(refresh); f.advance();
  const result = await f.service().command(refresh);
  expect(result.flightAware?.estimatedMilliUSD).toBe(20); expect(result.flightAware?.positionError).toContain('monthly limit'); expect(f.provider.position).toHaveBeenCalledTimes(1);
  f.advance(); const denied = await f.service().command(refresh); expect(denied.flightAware?.error?.detail).toContain('monthly limit'); expect(f.provider.read).toHaveBeenCalledTimes(2);
  const record = await f.store.get(); record.flightAwareAccess = { month: '2026-09', count: 4, lastAttemptAt: new Date(epoch).toISOString() }; await f.store.put(record);
  expect((await f.service().snapshot()).flightAware?.estimatedMilliUSD).toBe(20);
  f.advance(4 * 86400000); expect((await f.service().snapshot()).flightAware?.estimatedMilliUSD).toBe(0);
});
it('does not choose a position for ambiguous or mismatched flight records', async () => {
  const f = await fixture(); f.provider.read.mockImplementation(async () => normalizeFlightAware({ flights: [flight, flight] }, 'W64513', '2026-09-28', epoch));
  const result = await f.service().command(refresh); expect(f.provider.position).not.toHaveBeenCalled(); expect(flightTrackingView(result, tracking, epoch).scheduleStatus.state).toBe('ambiguous');
});
it('distinguishes missing, stale, projected and foreign positions without fabricating an ICAO address', async () => {
  const empty = normalizeFlightAwarePosition({ fa_flight_id: flight.fa_flight_id, last_position: null }, flight.fa_flight_id, epoch); expect(empty.position).toBeNull();
  expect(() => normalizeFlightAwarePosition({ ...rawPosition, fa_flight_id: 'different' }, flight.fa_flight_id, epoch)).toThrow();
  expect(() => normalizeFlightAwarePosition({ ...rawPosition, last_position: { ...rawPosition.last_position, latitude: 200 } }, flight.fa_flight_id, epoch)).toThrow();
  const f = await fixture(), result = await f.service().command(refresh);
  const stale = epoch + 180000; expect(freshAircraft(result, stale)).toEqual([]); expect(positionLabel(result, mappedAircraft(result, stale)[0], stale)).toBe('Last known position');
  result.flightAware!.position!.position!.projected = true; expect(freshAircraft(result, epoch)).toEqual([]); expect(positionLabel(result, mappedAircraft(result, epoch)[0], epoch)).toBe('Projected position');
  result.config.flightsEnabled = false; expect(mappedAircraft(result, epoch)).toEqual([]);
});
it('uses the dedicated native position endpoint with a verified instance id and private header', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(rawPosition))); vi.stubGlobal('fetch', fetcher);
  const result = await new NativeFlightAware(() => epoch).position(flight.fa_flight_id, 'isolated-secret');
  expect(result.position?.altitudeFeet).toBe(34000); expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/aeroapi/flights/isolated-flight-instance/position'); expect(url.href).not.toContain('isolated-secret'); expect(options.redirect).toBe('error');
});
it('animates only between observations, uses the short dateline crossing and respects reduced motion', () => {
  expect(aircraftMotion([179, 20], [-179, 22], .5)).toEqual([-180, 21]); expect(aircraftMotion([4, 50], [6, 52], 2)).toEqual([6, 52]);
  const update = vi.fn(), raf = vi.fn(); vi.stubGlobal('requestAnimationFrame', raf);
  animateAircraft([4, 50], [6, 52], update, true); expect(update).toHaveBeenCalledExactlyOnceWith([6, 52]); expect(raf).not.toHaveBeenCalled();
});
it('refreshes an existing padded ICAO flight through FlightAware, with no legacy fallback or configuration migration', async () => {
  const f = await fixture(), record = await f.store.get();
  const saved = { ...tracking, label: 'AHY071', identifier: 'AHY071' };
  record.config.trackedFlights = [saved]; await f.store.put(record);
  const before = structuredClone(record.config);
  f.provider.read.mockImplementation(async () => normalizeFlightAware({ flights: [{ ...flight, ident_iata: 'J2071', ident_icao: 'AHY071' }] }, 'AHY71', '2026-09-28', epoch));
  const service = f.service(), result = await service.command(refresh);
  expect(f.provider.read).toHaveBeenCalledExactlyOnceWith('AHY71', '2026-09-28', 'isolated-secret');
  expect(f.provider.position).toHaveBeenCalledExactlyOnceWith(flight.fa_flight_id, 'isolated-secret');
  expect(f.avio.read).not.toHaveBeenCalled();
  expect(flightTrackingView(result, saved, epoch).scheduleStatus.state).toBe('connected');
  expect(mappedAircraft(result, epoch)).toHaveLength(1);
  await service.command(refresh); await service.snapshot();
  expect(f.provider.read).toHaveBeenCalledTimes(1); expect(f.provider.position).toHaveBeenCalledTimes(1);
  expect((await f.store.get()).config).toEqual(before);
});
it('never falls back to retired aircraft sources for missing keys, unsupported IDs, or nearby searches', async () => {
  const f = await fixture(), record = await f.store.get();
  const keys = { available: () => true, status: vi.fn(async () => 'missing' as const), read: vi.fn(), save: vi.fn(), remove: vi.fn() };
  const service = new SituationService(f.store, keys, async () => ({ enabled: true, network: true }), () => epoch, { flightAware: f.provider, flights: f.avio });
  await expect(service.command(refresh)).rejects.toThrow('Connect FlightAware');
  await expect(service.command({ action: 'refresh', source: 'flights' })).rejects.toThrow('flight number');
  record.config.trackedFlights = [{ ...tracking, kind: 'icao', identifier: 'ABC123' }]; await f.store.put(record);
  await expect(service.command(refresh)).rejects.toThrow('flight number');
  expect(f.avio.read).not.toHaveBeenCalled(); expect(f.provider.read).not.toHaveBeenCalled();
  expect((await f.store.get()).requests).toEqual([]);
});
