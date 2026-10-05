// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect, it, vi } from 'vitest';
import { emptySituationConfig } from '../src/shared/situation';
import { SituationService } from '../electron/situation/service';
import { SituationStore } from '../electron/situation/store';
import { TomTomTraffic } from '../electron/situation/providers';
// Isolated provider responses; never owner-profile or capture data.
async function setup() {
  const at = new Date().toISOString(), store = new SituationStore();
  const locations = [0, 1].map(n => ({ id: crypto.randomUUID(), label: 'Test ' + n, latitude: 51 + n, longitude: 4, timezone: null, purpose: '', revision: '', updatedAt: at }));
  const route = { id: crypto.randomUUID(), label: 'Test route', originId: locations[0].id, destinationId: locations[1].id, revision: '', updatedAt: at };
  const transport = { get: vi.fn(async () => ({ copyrightsCaption: '©TomTom' })), response: vi.fn(async () => ({ body: { routes: [{ summary: { travelTimeInSeconds: 900, lengthInMeters: 12000, noTrafficTravelTimeInSeconds: 800, trafficDelayInSeconds: 100 } }] }, cacheControl: 'no-store', age: 0, receivedAt: Date.now() })) };
  const keys = { available: () => true, status: async () => 'configured' as const, read: async () => 'isolated-key', save: async () => {}, remove: async () => {} };
  const service = new SituationService(store, keys, async () => ({ enabled: true, network: true }), Date.now, { traffic: new TomTomTraffic(transport) });
  await service.command({ action: 'configure', expectedRevision: 0, config: { ...emptySituationConfig(), locations, routes: [route], defaultRouteId: route.id, trafficEnabled: true } });
  return { service, transport, store };
}
it('makes the next explicit refresh work after the previous ephemeral route has been discarded', async () => {
  const { service, transport, store } = await setup();
  expect((await service.command({ action: 'refresh', source: 'traffic' })).traffic).not.toBeNull();
  expect((await service.snapshot()).traffic).toBeNull();
  expect((await service.command({ action: 'refresh', source: 'traffic' })).traffic).not.toBeNull();
  expect(transport.get).toHaveBeenCalledTimes(2); expect(transport.response).toHaveBeenCalledTimes(2);
  expect((await store.get()).traffic).toEqual([]);
});
it('reports one attribution failure and admits a new explicit attempt without a silent cooldown', async () => {
  const { service, transport } = await setup();
  transport.get.mockResolvedValueOnce({ copyrightsCaption: '' });
  const failed = await service.command({ action: 'refresh', source: 'traffic' });
  expect(failed.statuses[1]).toMatchObject({ state: 'error', lastError: 'response' });
  expect(transport.response).not.toHaveBeenCalled();
  expect((await service.command({ action: 'refresh', source: 'traffic' })).traffic).not.toBeNull();
  expect(transport.get).toHaveBeenCalledTimes(2); expect(transport.response).toHaveBeenCalledTimes(1);
});
