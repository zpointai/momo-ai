// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { carrierDomain, allowedCarrierImage, logoTokenSchema } from '../src/shared/carrierBranding';
import { LogoDevCarrierBrandProvider } from '../electron/situation/carrierBranding';
import { normalizeFlightAware, normalizeFlightAwareOperator, NativeFlightAware } from '../electron/situation/flightAware';
import { SituationStore } from '../electron/situation/store';
import { SituationService } from '../electron/situation/service';
import { emptySituationConfig } from '../src/shared/situation';
import { allowedRequest, productionCsp } from '../electron/security';

const epoch = Date.parse('2026-09-29T12:00:00Z'), at = new Date(epoch).toISOString(), token = 'pk_isolated_fixture_token';
it('normalizes bare operator websites and uses only the exact verified Azerbaijan image mapping', () => {
  for (const value of ['www.azal.az', 'azal.az/en/', 'https://www.azal.az']) expect(carrierDomain(value)).toBe('azal.az');
  for (const value of ['azal.az@evil.com', '//evil.com', 'azal.az:444', 'javascript:azal.az']) expect(carrierDomain(value)).toBeNull();
  const carrier = { icao: 'AHY', iata: 'J2', name: 'Azerbaijan Airlines', callsign: 'Azal', domain: null };
  const brand = new LogoDevCarrierBrandProvider().resolve(carrier, token, epoch);
  expect(brand.availability).toBe('ready'); expect(new URL(brand.imageUrl!).pathname).toBe('/azal.az'); expect(brand.carrier.domain).toBeNull(); expect(allowedCarrierImage(brand.imageUrl!)).toBe(true);
  for (const patch of [{ icao: 'BAW' }, { iata: 'XX' }, { name: 'Another airline' }]) expect(new LogoDevCarrierBrandProvider().resolve({ ...carrier, ...patch }, token, epoch).imageUrl).toBeNull();
});
afterEach(() => vi.unstubAllGlobals());
it.each([['W6', 'WZZ', 'Wizz Air', 'wizzair.com'], ['KL', 'KLM', 'KLM', 'klm.com'], ['BA', 'BAW', 'British Airways', 'britishairways.com'], ['LH', 'DLH', 'Lufthansa', 'lufthansa.com']])('resolves %s/%s only through exact FlightAware operator identity', (iata, icao, name, domain) => {
  const identity = { iata, icao, name: null, callsign: null, domain: null };
  const carrier = normalizeFlightAwareOperator({ iata, icao, name, url: 'https://www.' + domain + '/en', callsign: name.toUpperCase() }, identity);
  const value = new LogoDevCarrierBrandProvider().resolve(carrier, token, epoch);
  expect(value).toMatchObject({ source: 'logo-dev', availability: 'ready', carrier: { iata, icao, name, domain } });
  expect(allowedCarrierImage(value.imageUrl!)).toBe(true); expect(allowedRequest(value.imageUrl!, false)).toBe(true);
  expect(() => normalizeFlightAwareOperator({ icao: 'BAD', iata, name, url: 'https://' + domain }, identity)).toThrow();
  expect(() => normalizeFlightAwareOperator({ icao, iata: 'XX', name, url: 'https://' + domain }, identity)).toThrow();
});
it('rejects ambiguous, missing, unsafe and fuzzy carrier matches; accepts no private key in the image seam', () => {
  const identity = { iata: 'W6', icao: 'WZZ', name: null, callsign: null, domain: null }, candidate = { iata: 'W6', icao: 'WZZ', name: 'Wizz Air', url: 'https://wizzair.com' };
  expect(() => normalizeFlightAwareOperator({ ...candidate, alternatives: [candidate] }, identity)).toThrow();
  expect(() => normalizeFlightAwareOperator({ name: 'Wizz Air', url: candidate.url }, identity)).toThrow();
  for (const raw of ['javascript:alert(1)', 'https://user:pass@wizzair.com', 'http://127.0.0.1', 'https://instagram.com/wizzair', 'https://wizzair.com:444']) expect(carrierDomain(raw)).toBeNull();
  expect(new LogoDevCarrierBrandProvider().resolve(identity, token, epoch)).toMatchObject({ availability: 'unverified', imageUrl: null });
  expect(logoTokenSchema.safeParse('sk_private_key').success).toBe(false);
  for (const raw of ['https://img.logo.dev/wizzair.com?token=sk_private', 'https://img.logo.dev.evil.test/wizzair.com', 'https://api.logo.dev/search?q=Wizz']) expect(allowedRequest(raw, false)).toBe(false);
  expect(productionCsp).toContain("connect-src 'self' https://tiles.openfreemap.org;");
});
it('uses the bounded native operator endpoint and does not follow the returned website URL', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ icao: 'WZZ', iata: 'W6', name: 'Wizz Air', url: 'http://wizzair.com', callsign: 'WIZZAIR' }))); vi.stubGlobal('fetch', fetcher);
  const result = await new NativeFlightAware(() => epoch).operator('WZZ', 'isolated-secret');
  expect(result.domain).toBe('wizzair.com'); expect(fetcher).toHaveBeenCalledTimes(1);
  const args = fetcher.mock.calls[0] as unknown as [URL, RequestInit]; expect(args[0].href).toBe('https://aeroapi.flightaware.com/aeroapi/operators/WZZ'); expect(args[1].redirect).toBe('error'); expect(args[0].href).not.toContain('isolated-secret');
});
it('is opt-in, reserves operator spend, caches exact matches, and never lets branding failures break flight tracking', async () => {
  let now = epoch, logoKey = false;
  const store = new SituationStore(), tracking = { id: randomUUID(), kind: 'callsign' as const, identifier: 'WZZ4513', label: 'W6 4513', flightNumber: 'W64513', departureDate: '2026-09-29' };
  const keys = { available: () => true, status: vi.fn(async (key: string) => key === 'flightaware' || key === 'logodev' && logoKey ? 'configured' as const : 'missing' as const), read: vi.fn(async (key: string) => key === 'logodev' ? token : 'isolated-secret'), save: vi.fn(async () => { logoKey = true; }), remove: vi.fn(async () => { logoKey = false; }) };
  const provider = { read: vi.fn(async () => normalizeFlightAware({ flights: [{ ident_iata: 'W64513', fa_flight_id: 'fixture-flight', operator_icao: 'WZZ', operator_iata: 'W6', scheduled_out: at, origin: { timezone: 'Europe/Sofia' }, status: 'Scheduled' }] }, 'W64513', '2026-09-29', now)), position: vi.fn(async () => ({ flightId: 'fixture-flight', checkedAt: new Date(now).toISOString(), position: null })), operator: vi.fn(async () => ({ icao: 'WZZ', iata: 'W6', name: 'Wizz Air', callsign: 'WIZZAIR', domain: 'wizzair.com' })) };
  const service = new SituationService(store, keys, async () => ({ enabled: true, network: true }), () => now, { flightAware: provider });
  let view = await service.command({ action: 'configure', expectedRevision: 0, config: { ...emptySituationConfig(), flightsEnabled: true, trackedFlights: [tracking] } });
  const refresh = () => service.command({ action: 'refresh', source: 'flights', flightId: tracking.id });
  await refresh(); expect(provider.operator).not.toHaveBeenCalled();
  view = await service.command({ action: 'save-carrier-logo-token', token }); expect(view.config.carrierLogosEnabled).toBe(false); expect(provider.operator).not.toHaveBeenCalled();
  view = await service.command({ action: 'configure', config: { ...view.config, carrierLogosEnabled: true }, expectedRevision: view.config.revision }); expect(provider.operator).not.toHaveBeenCalled();
  now += 60001; view = await refresh(); expect(view.carrierBranding?.brands[0].availability).toBe('ready'); expect(provider.operator).toHaveBeenCalledTimes(1); expect(view.flightAware?.estimatedMilliUSD).toBe(45);
  now += 60001; await refresh(); expect(provider.operator).toHaveBeenCalledTimes(1);
  view = await service.command({ action: 'configure', config: { ...view.config, carrierLogosEnabled: false }, expectedRevision: view.config.revision });
  view = await service.command({ action: 'configure', config: { ...view.config, carrierLogosEnabled: true }, expectedRevision: view.config.revision });
  expect(view.carrierBranding?.brands).toEqual([]); expect(provider.operator).toHaveBeenCalledTimes(1);
  const saved = await store.get(); expect(saved.requests.filter(r => r.service === 'operator')).toHaveLength(1); expect(JSON.stringify(saved)).not.toContain(token); expect(JSON.stringify(saved)).not.toContain('wizzair.com');
  const failed = new SituationService(store, keys, async () => ({ enabled: true, network: true }), () => now, { flightAware: { ...provider, operator: vi.fn(async () => { throw Error('Private error'); }) } });
  now += 60001; const fallback = await failed.command({ action: 'refresh', source: 'flights', flightId: tracking.id }); expect(fallback.flightAware?.result?.flights).toHaveLength(1); expect(fallback.carrierBranding?.brands[0]).toMatchObject({ availability: 'unverified', imageUrl: null });
  const receiptCount = (await store.get()).requests.length; await service.command({ action: 'remove-carrier-logo-token' }); expect((await store.get()).requests).toHaveLength(receiptCount);
});
