// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SituationService } from '../electron/situation/service';
import { SituationStore } from '../electron/situation/store';
import { NativeFlightAware, normalizeFlightAware } from '../electron/situation/flightAware';
import { SituationProviderError } from '../electron/situation/providers';
import { situationCommandSchema } from '../src/shared/situation';

// Isolated contract data, never written to the owner profile or used as application evidence.
const epoch = Date.parse('2026-09-28T14:00:00Z');
const query = { action: 'check-flightaware' as const, flightNumber: 'W64513', departureDate: '2026-09-28' };
const flight = { fa_flight_id: 'isolated-flight', ident: 'WZZ4513', ident_iata: 'W64513', ident_icao: 'WZZ4513', atc_ident: 'WZZTEST', registration: 'TEST-REG', status: 'En Route', scheduled_out: '2026-09-28T13:05:00Z', actual_off: '2026-09-28T13:15:00Z', estimated_in: '2026-09-28T16:10:00Z', origin: { code_iata: 'VAR', name: 'Isolated origin', timezone: 'Europe/Sofia' }, destination: { code_iata: 'EIN', name: 'Isolated destination', timezone: 'Europe/Amsterdam' } };
const response = { flights: [flight], links: { next: null } };
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  let now = epoch, permitted = true, configured = true;
  const store = new SituationStore(), keys = { available: () => true, status: vi.fn(async () => configured ? 'configured' as const : 'missing' as const), read: vi.fn(async () => { if (!configured) throw Error('Missing'); return 'isolated-secret'; }), save: vi.fn(async () => { configured = true; }), remove: vi.fn(async () => { configured = false; }) };
  const provider = { position: vi.fn(async (id: string) => ({ flightId: id, checkedAt: new Date(now).toISOString(), position: null })), read: vi.fn(async () => normalizeFlightAware(response, query.flightNumber, query.departureDate, now)) };
  const record = await store.get(); record.config.flightsEnabled = true; await store.put(record);
  const service = () => new SituationService(store, keys, async () => ({ enabled: true, network: permitted }), () => now, { flightAware: provider });
  return { store, keys, provider, service, advance: (ms = 60001) => { now += ms; }, block: () => { permitted = false; } };
}
describe('FlightAware bounded coverage check', () => {
  it('matches padded numeric designators while rejecting another carrier, suffix, date or ATC-only identity', () => {
    const candidate = { ...flight, ident: 'AHY071', ident_iata: 'J2071', ident_icao: 'AHY071', atc_ident: 'AHYABC' };
    const wrong = [
      { ...candidate, ident: 'BAW071', ident_icao: 'BAW071', ident_iata: 'BA071' },
      { ...candidate, ident: 'AHY071A', ident_icao: 'AHY071A', ident_iata: 'J2071A' },
      { ...candidate, scheduled_out: '2026-09-27T13:00:00Z' },
      { ...candidate, ident: 'AHY999', ident_icao: 'AHY999', ident_iata: 'J2999', atc_ident: 'AHY071' },
    ];
    const result = normalizeFlightAware({ flights: [candidate, ...wrong] }, 'AHY71', '2026-09-28', epoch);
    expect(result.flights).toHaveLength(1); expect(result.flights[0].id).toBe(candidate.fa_flight_id);
  });
  it('matches commercial identity and origin-local date without inventing a callsign', () => {
    const value = normalizeFlightAware({ flights: [flight, { ...flight, ident_iata: 'W69999', ident: 'WZZ9999' }, { ...flight, scheduled_out: '2026-09-27T13:05:00Z' }], links: { next: 'untrusted-next' } }, 'W64513', '2026-09-28', epoch);
    expect(value.flights).toHaveLength(1); expect(value.flights[0].callsign).toBe('WZZTEST'); expect(value.moreResults).toBe(true);
    expect(normalizeFlightAware({ flights: [{ ...flight, atc_ident: null }] }, 'W64513', '2026-09-28', epoch).flights[0].callsign).toBeNull();
    expect(normalizeFlightAware({ flights: [{ ...flight, scheduled_out: '2026-09-27T22:30:00Z' }] }, 'W64513', '2026-09-28', epoch).flights).toHaveLength(1);
  });
  it('rejects malformed responses and invalid IPC inputs', () => {
    expect(() => normalizeFlightAware({ detail: 'secret echoed by upstream' }, 'W64513', '2026-09-28', epoch)).toThrow(SituationProviderError);
    expect(situationCommandSchema.parse({ ...query, flightNumber: 'w6 4513' }).flightNumber).toBe('W64513');
    expect(situationCommandSchema.safeParse({ ...query, departureDate: '2026-02-30' }).success).toBe(false);
    expect(situationCommandSchema.safeParse({ ...query, url: 'https://example.com' }).success).toBe(false);
  });
  it('protects/removes keys with no provider request or configuration change', async () => {
    const f = await fixture(), service = f.service(), before = await f.store.get();
    const saved = await service.command({ action: 'save-flightaware-key', secret: 'isolated-secret' });
    expect(f.keys.save).toHaveBeenCalledWith('flightaware', 'isolated-secret'); expect(saved.flightAware?.credential).toBe('configured');
    expect(JSON.stringify(saved)).not.toContain('isolated-secret'); expect((await f.store.get()).config).toEqual(before.config);
    await service.command({ action: 'remove-flightaware-key' }); await service.command({ action: 'snapshot' }); expect(f.provider.read).not.toHaveBeenCalled();
  });
  it('records one explicit call, keeps response in memory and does not poll on snapshots', async () => {
    const f = await fixture(), service = f.service(), result = await service.command(query);
    expect(result.flightAware?.result?.flights).toHaveLength(1);
    const stored = await f.store.get(); expect(stored.flightAwareAccess?.count).toBe(1); expect(stored.requests[0]).toMatchObject({ provider: 'flightaware', service: 'flight-status', pricing: 'unpriced', costUSD: null, outcome: 'success' });
    expect(JSON.stringify(stored)).not.toContain('TEST-REG'); expect(stored.flights).toBeNull();
    await service.command({ action: 'snapshot' }); expect(f.provider.read).toHaveBeenCalledTimes(1);
    expect((await f.service().snapshot()).flightAware?.result).toBeNull();
    f.advance(900001); expect((await service.snapshot()).flightAware?.result).toBeNull();
  });
  it('serializes rapid clicks and retains the cap across restarts and key replacement', async () => {
    const f = await fixture(), record = await f.store.get(); record.config.flightAwareMonthlyLimitCents = 5; await f.store.put(record); const service = f.service();
    const results = await Promise.allSettled([service.command(query), service.command(query)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(f.provider.read).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 10; i++) { f.advance(); await f.service().command(query); }
    f.advance(); await service.command({ action: 'save-flightaware-key', secret: 'replacement-key' });
    await expect(f.service().command(query)).rejects.toThrow('monthly limit'); expect(f.provider.read).toHaveBeenCalledTimes(10);
  });
  it('counts failures conservatively, hides upstream errors and enforces native access/date guards', async () => {
    const f = await fixture(), service = f.service(); f.provider.read.mockRejectedValue(new Error('isolated-secret'));
    await expect(service.command(query)).rejects.toThrow('could not be checked'); expect((await f.store.get()).flightAwareAccess?.count).toBe(1);
    f.advance(); await expect(service.command({ ...query, departureDate: '2026-09-01' })).rejects.toThrow('today');
    f.block(); await expect(service.command(query)).rejects.toThrow('off for this review'); expect(f.provider.read).toHaveBeenCalledTimes(1);
  });
  it('uses only the official native endpoint and API-key header, one page, with no retry', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const provider = new NativeFlightAware(() => epoch); await provider.read('W64513', '2026-09-28', 'isolated-secret');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe('https://aeroapi.flightaware.com'); expect(url.searchParams.get('max_pages')).toBe('1'); expect(url.href).not.toContain('isolated-secret');
    expect(options).toMatchObject({ redirect: 'error', headers: { 'x-apikey': 'isolated-secret' } });
    fetcher.mockImplementation(async () => new Response('isolated-secret', { status: 401 }));
    await expect(provider.read('W64513', '2026-09-28', 'isolated-secret')).rejects.toMatchObject({ code: 'authentication', message: 'Situation source could not be read.' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
