// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrafficCondition } from '../src/desktop/situation/TrafficCondition';
import { normalizeTraffic } from '../electron/situation/providers';
import { emptySituationConfig, situationSnapshotSchema } from '../src/shared/situation';
import { mapPlaceLabels } from '../src/desktop/situation/mapLabels';
afterEach(cleanup);
it.each([[0, 'light'], [150, 'light'], [151, 'moderate'], [400, 'moderate'], [401, 'heavy'], [null, 'unknown']] as const)('uses source delay %s and free-flow time for the %s route condition', (delay, level) => {
  const route = { id: crypto.randomUUID(), label: 'Test', originId: crypto.randomUUID(), destinationId: crypto.randomUUID(), revision: 'a', updatedAt: new Date().toISOString() };
  const traffic = normalizeTraffic({ routes: [{ summary: { travelTimeInSeconds: 1500, lengthInMeters: 12000, noTrafficTravelTimeInSeconds: 1000, trafficDelayInSeconds: delay } }] }, route, Date.now());
  expect(traffic.congestion).toBe(level); render(<TrafficCondition traffic={traffic}/>);
  if (level === 'unknown') { expect(screen.queryByRole('img')).toBeNull(); expect(screen.getByText('Traffic severity unavailable')).toBeTruthy(); }
  else expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Route-level traffic condition: ' + level);
});
it('groups only a nearby locality with an explicitly configured endpoint and preserves all identities and selection', () => {
  const at = new Date().toISOString(), basic = { latitude: 51.8, longitude: 4.6, timezone: 'Europe/Amsterdam', purpose: '', revision: 'a', updatedAt: at };
  const town = { ...basic, id: crypto.randomUUID(), label: 'Locality', locality: { name: 'Locality', country: 'NL', countryCode: 'NL', provider: 'open-meteo', providerId: '1', resolvedAt: at, attribution: 'Open-Meteo · GeoNames' } };
  const home = { ...basic, id: crypto.randomUUID(), label: 'Home', purpose: 'home', latitude: 51.801 };
  const work = { ...basic, id: crypto.randomUUID(), label: 'Work', purpose: 'work', longitude: 4.7 };
  const route = { id: crypto.randomUUID(), label: 'Commute', originId: home.id, destinationId: work.id, revision: 'a', updatedAt: at };
  const snapshot = situationSnapshotSchema.parse({ config: { ...emptySituationConfig(), locations: [town, home, work], routes: [route] }, selectedLocationId: town.id, selectedRouteId: route.id, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'empty', detail: '', lastAttemptAt: null, lastError: null })), trafficCredential: 'configured', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: at });
  const groups = mapPlaceLabels(snapshot, () => ({ x: 100, y: 100 }));
  expect(groups).toHaveLength(2); expect(groups[0]).toMatchObject({ place: { id: home.id }, selected: true, role: 'origin', nearby: [{ id: town.id }] });
  expect(groups[1]).toMatchObject({ place: { id: work.id }, role: 'destination' }); expect(snapshot.config.locations).toHaveLength(3);
  expect(mapPlaceLabels(snapshot, p => ({ x: p.id === town.id ? 1000 : 0, y: 100 }))).toHaveLength(3);
});
