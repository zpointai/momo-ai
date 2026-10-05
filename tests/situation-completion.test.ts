// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptySituationConfig, situationCommandSchema, situationMapFocus, zonedClock, type SituationLocation } from '../src/shared/situation';
import { AvioAircraft, flightQueryRevision, NativeSituationTransport, normalizeAircraft, normalizePlaces, normalizeTraffic, OpenMeteoGeocoding, permittedCacheUntil, TomTomTraffic } from '../electron/situation/providers';
import { SituationService } from '../electron/situation/service';
import { SituationStore } from '../electron/situation/store';
import { situationEvidence } from '../electron/situation/evidence';
import { allowedSituationLink } from '../electron/security';

// Isolated normalization fixtures, never acceptance or owner-profile input.
const epoch = Date.parse('2026-09-27T12:00:00Z');
const geocode = { results: [{ id: 2754454, name: 'Hendrik-Ido-Ambacht', country: 'Netherlands', country_code: 'NL', feature_code: 'PPL', timezone: 'Europe/Amsterdam', latitude: 51.84, longitude: 4.64, postcodes: ['discard'], admin4: 'discard' }] };
const place = (): SituationLocation => ({ ...normalizePlaces(geocode, epoch)[0], id: randomUUID(), label: 'Hendrik-Ido-Ambacht', purpose: '', revision: 'a'.repeat(64), updatedAt: new Date(epoch).toISOString() });
const keys = () => ({ available: () => true, status: vi.fn(async () => 'configured' as const), read: vi.fn(async () => 'test-key-only'), save: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) });
const aircraft = (now = epoch) => ({ now, ac: [{ hex: 'abcdef', flight: 'TEST123', lat: 51.8, lon: 4.6, seen_pos: 2, alt_baro: 18000, gs: 270, track: 10 }] });
const routing = { routes: [{ summary: { travelTimeInSeconds: 900, lengthInMeters: 12000, noTrafficTravelTimeInSeconds: 800, trafficDelayInSeconds: 100 }, legs: [{ points: [{ latitude: 51.8, longitude: 4.6 }, { latitude: 51.9, longitude: 4.7 }] }] }] };
it('normalizes the authorized locality without retaining addresses or inferring a purpose', async () => {
  const transport = { get: vi.fn(async () => geocode) }, result = await new OpenMeteoGeocoding(transport, () => epoch).search('Hendrik-Ido-Ambacht', 'NL');
  expect(result[0]).toMatchObject({ timezone: 'Europe/Amsterdam', locality: { name: 'Hendrik-Ido-Ambacht', country: 'Netherlands', countryCode: 'NL', provider: 'open-meteo' } });
  expect(JSON.stringify(result)).not.toMatch(/postcodes|admin4|purpose|Home|Office/);
  expect(transport.get).toHaveBeenCalledTimes(1);
  expect(normalizePlaces({ results: [{ ...geocode.results[0], timezone: 'invalid' }, { ...geocode.results[0], feature_code: 'BLDG' }] }, epoch)).toEqual([]);
  expect(situationMapFocus(place())).toMatchObject({ zoom: 9 }); expect(situationMapFocus()).toMatchObject({ zoom: 1.5 });
  const zones = ['Europe/Amsterdam', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
  expect(zones.map(z => zonedClock(z, epoch).time)).toEqual(['14:00', '08:00', '05:00', '21:00']);
});
it('searches only explicitly, records one free receipt and reuses a repeated search', async () => {
  const store = new SituationStore(), geocoder = { search: vi.fn(async () => normalizePlaces(geocode, epoch)) };
  const service = new SituationService(store, keys(), async () => ({ enabled: true, network: true }), () => epoch, { geocoder });
  expect((await service.snapshot()).placeResults).toEqual([]); expect(geocoder.search).not.toHaveBeenCalled();
  const result = await service.command({ action: 'search-places', query: 'Hendrik-Ido-Ambacht', countryCode: 'NL' });
  await service.command({ action: 'search-places', query: 'Hendrik-Ido-Ambacht', countryCode: 'NL' });
  expect(geocoder.search).toHaveBeenCalledTimes(1); expect(result.usage).toMatchObject([{ service: 'geocoding', outcome: 'success', costUSD: '0' }]);
  expect(JSON.stringify(result.usage)).not.toMatch(/latitude|longitude|Hendrik|NL/);
  expect((await store.get()).config.locations).toEqual([]);
});
it('does not claim geocoder provenance after an owner edits coordinates', async () => {
  const p = place(), service = new SituationService(new SituationStore(), keys(), async () => ({ enabled: true, network: true }), () => epoch);
  const a = await service.command({ action: 'configure', config: { ...emptySituationConfig(), locations: [p], defaultLocationId: p.id }, expectedRevision: 0 });
  expect(a.config.locations[0].locality).toBeTruthy();
  const b = await service.command({ action: 'configure', config: { ...a.config, locations: [{ ...a.config.locations[0], latitude: 50 }] }, expectedRevision: 1 });
  expect(b.config.locations[0].locality).toBeUndefined(); expect(b.config.locations[0].purpose).toBe('');
});
it('honors cache-control metadata and delivers TomTom only to the requesting view', async () => {
  const response = { body: routing, receivedAt: epoch, cacheControl: 'private, max-age=120', age: 20 };
  expect(permittedCacheUntil(response)).toBe(epoch + 100000);
  for (const cacheControl of [null, 'no-cache', 'no-store, max-age=300', 'max-age=garbage']) expect(permittedCacheUntil({ ...response, cacheControl })).toBeNull();
  const store = new SituationStore(), k = keys(), p = place(), q = { ...place(), label: 'Explicit second place' }, transport = { get: vi.fn(async () => ({ copyrightsCaption: '©TomTom' })), response: vi.fn(async () => response) };
  const service = new SituationService(store, k, async () => ({ enabled: true, network: true }), () => epoch, { traffic: new TomTomTraffic(transport, () => epoch) });
  const r = { id: randomUUID(), label: 'Owner route', originId: p.id, destinationId: q.id, revision: '', updatedAt: new Date(epoch).toISOString() };
  await service.command({ action: 'configure', config: { ...emptySituationConfig(), locations: [p, q], routes: [r], defaultRouteId: r.id, trafficEnabled: true }, expectedRevision: 0 });
  const live = await service.command({ action: 'refresh', source: 'traffic' });
  expect(live.traffic).toMatchObject({ displayOnly: true, durationSeconds: 900, freshness: { attribution: '©TomTom', freshUntil: new Date(epoch + 100000).toISOString() } });
  expect(live.usage.map(r => r.service)).toEqual(['route', 'attribution']); expect(live.usage.every(r => r.costUSD === null && r.outcome === 'success')).toBe(true);
  expect((await store.get()).traffic).toEqual([]); expect((await service.snapshot()).traffic).toBeNull();
  live.config.includeInBriefing = true; live.config.shareWithAI = true; expect(situationEvidence(live, 'owner', epoch).entries).toEqual([]);
  await service.command({ action: 'refresh', source: 'traffic' }); expect(transport.response).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await store.get())).not.toMatch(/test-key-only|durationSeconds|geometry|12,000/);
});
it('will not dispatch a route when required attribution fails', async () => {
  const transport = { get: vi.fn(async () => ({})), response: vi.fn() }, p = place(), q = place(), r = { id: randomUUID(), label: 'Explicit', originId: p.id, destinationId: q.id, revision: 'a', updatedAt: new Date(epoch).toISOString() };
  await expect(new TomTomTraffic(transport).read(r, p, q, 'test-key-only')).rejects.toMatchObject({ code: 'response' }); expect(transport.response).not.toHaveBeenCalled();
});
it('supports native-only key import and rotation without a source request', async () => {
  const k = keys(), imported = vi.fn(async () => undefined), traffic = { id: 'tomtom', read: vi.fn() }, service = new SituationService(new SituationStore(), k, async () => ({ enabled: true, network: true }), () => epoch, { traffic }, imported);
  expect(situationCommandSchema.safeParse({ action: 'import-traffic-key', filename: 'private' }).success).toBe(false);
  const result = await service.command({ action: 'import-traffic-key' }); expect(imported).toHaveBeenCalledOnce(); expect(result.config.trafficEnabled).toBe(false); expect(traffic.read).not.toHaveBeenCalled(); expect(k.read).not.toHaveBeenCalled();
});
it('requests only the chosen aircraft or one region and never invents destinations', async () => {
  const transport = { get: vi.fn(async () => aircraft()) }, provider = new AvioAircraft(transport, () => epoch), p = place(), f = { id: randomUUID(), label: 'Tracked', kind: 'callsign' as const, identifier: 'TEST123' };
  const local = await provider.read(p, [f]); expect(local.freshness.provider).toBe('avioadsb'); expect(local.queryRevision).toBe(flightQueryRevision(p, [f]));
  expect((transport.get.mock.calls[0] as unknown as [URL])[0].pathname).toBe('/v1/point/51.84/4.64/40');
  await provider.read(p, [f], f.id); const url = (transport.get.mock.calls[1] as unknown as [URL])[0]; expect(url.pathname).toBe('/v1/callsign/TEST123'); expect(url.href).not.toContain('51.84');
  expect(local.aircraft[0]).toMatchObject({ origin: null, destination: null, trackedId: f.id });
  expect(normalizeAircraft(aircraft(epoch - 180000), [], epoch).aircraft).toEqual([]);
});
it('retires nearby aircraft dispatch while preserving its historical allowance', async () => {
  const store = new SituationStore(), record = await store.get();
  record.config.flightsEnabled = true;
  record.aircraftAccess = { day: '2026-09-27', count: 12, retryAt: new Date(epoch).toISOString() };
  await store.put(record);
  const flights = { id: 'avioadsb', read: vi.fn() };
  const service = new SituationService(store, keys(), async () => ({ enabled: true, network: true }), () => epoch, { flights });
  await expect(service.command({ action: 'refresh', source: 'flights' })).rejects.toThrow('flight number');
  expect(flights.read).not.toHaveBeenCalled();
  expect((await store.get()).aircraftAccess).toEqual(record.aircraftAccess);
});
it('keeps renderer requests separate from a small allowlist of owner-clicked public links', async () => {
  expect(allowedSituationLink('https://my.tomtom.com')).toBe(true); expect(allowedSituationLink('https://my.tomtom.com?key=secret')).toBe(false); expect(allowedSituationLink('https://avioadsb.org.evil.test')).toBe(false);
  const transport = new NativeSituationTransport(), fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }));
  try { await expect(transport.get(new URL('https://avioadsb.org/v1/point/1/2/40'))).rejects.toMatchObject({ code: 'response' }); expect(fetcher).not.toHaveBeenCalled(); }
  finally { fetcher.mockRestore(); }
});
it('treats route endpoint validation as native authority', () => {
  const p = place(), r = { id: randomUUID(), label: 'Not inferred', originId: p.id, destinationId: p.id, revision: '', updatedAt: new Date(epoch).toISOString() };
  expect(situationCommandSchema.safeParse({ action: 'configure', config: { ...emptySituationConfig(), locations: [p], routes: [r] }, expectedRevision: 0 }).success).toBe(false);
  expect(normalizeTraffic(routing, r, epoch).freshness.observedAt).toBeNull();
});
