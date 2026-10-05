// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CarrierBadge } from '../src/desktop/situation/CarrierBadge';
import { CarrierBrandingSetup } from '../src/desktop/situation/CarrierBrandingSetup';
import { RecentConditions } from '../src/desktop/situation/RecentConditions';
import { LogoDevCarrierBrandProvider } from '../electron/situation/carrierBranding';
import { emptySituationConfig, situationSnapshotSchema, type TrafficSnapshot } from '../src/shared/situation';
import { conditionEvent } from '../src/shared/situationChanges';
import { projectTrafficConditions } from '../src/desktop/situation/useSituation';
import { conditionDetailSnapshot, reconcileSituationDetail } from '../src/desktop/situation/SituationDetails';
import type { DesktopBridge } from '../src/shared/contracts';
const now = Date.parse('2026-09-29T12:00:00Z'), at = new Date(now).toISOString();
const snapshot = () => situationSnapshotSchema.parse({ config: emptySituationConfig(), selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'fixture', state: 'empty', detail: '', lastAttemptAt: null, lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: at });
afterEach(cleanup);
it('opens a Weather change for its own place through local snapshot only and retains that detail context', async () => {
  const current = snapshot(), other = snapshot(); current.selectedLocationId = 'current-place'; other.selectedLocationId = 'other-place';
  other.config.locations = [{ id: 'other-place', label: 'Other place', latitude: 0, longitude: 0, timezone: 'UTC', purpose: '', revision: 'r', updatedAt: at }];
  other.weather = { locationId: 'other-place', locationRevision: 'r' } as NonNullable<typeof other.weather>;
  const situationCommand = vi.fn(async () => ({ ok: true, value: other }));
  const condition = conditionEvent('weather', 'other-place', 'r', new Date(now + 900000).toISOString(), { category: 'weather-change', title: 'Rain at other place', detail: '', attention: true }, now);
  const target = await conditionDetailSnapshot(current, condition, { situationCommand } as unknown as DesktopBridge);
  expect(situationCommand).toHaveBeenCalledExactlyOnceWith({ action: 'snapshot', locationId: 'other-place' }); expect(target.selectedLocationId).toBe('other-place'); expect(current.selectedLocationId).toBe('current-place');
  const retained = reconcileSituationDetail({ kind: 'weather', snapshot: target }, { ...current, config: other.config }); expect(retained?.snapshot.weather?.locationId).toBe('other-place'); expect(retained?.snapshot.selectedLocationId).toBe('other-place');
});
it('shows a secondary image, preserves badge geometry on error and never retries on normal rerender', () => {
  const brand = new LogoDevCarrierBrandProvider().resolve({ icao: 'WZZ', iata: 'W6', name: 'Wizz Air', callsign: null, domain: 'wizzair.com' }, 'pk_fixture_token', now);
  const { container, rerender } = render(<CarrierBadge brand={brand} code="W6"/>); expect(container.querySelector('img')).not.toBeNull();
  fireEvent.error(container.querySelector('img')!); expect(screen.getByText('W6')).toBeTruthy(); expect(container.querySelector('img')).toBeNull();
  rerender(<CarrierBadge brand={brand} code="W6"/>); expect(container.querySelectorAll('.situation-carrier-badge')).toHaveLength(1); expect(container.querySelector('img')).toBeNull();
});
it('explains the baseline, renders only unexpired changes and opens the relevant source without refreshing', () => {
  const view = snapshot(), open = vi.fn(); const { rerender } = render(<RecentConditions snapshot={view} now={now} open={open} all={vi.fn()}/>);
  expect(screen.getByText(/first check sets a baseline/i)).toBeTruthy();
  const condition = conditionEvent('flights', 'fixture', 'r', new Date(now + 900000).toISOString(), { category: 'flight-change', title: 'W6 4513 is now airborne', detail: 'FlightAware reported takeoff.', attention: true }, now - 480000);
  view.conditions = [condition]; rerender(<RecentConditions snapshot={view} now={now} open={open} all={vi.fn()}/>);
  expect(screen.getByText('8 min ago · FlightAware')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: condition.title })); expect(open).toHaveBeenCalledWith(condition);
  rerender(<RecentConditions snapshot={view} now={now + 900001} open={open} all={vi.fn()}/>); expect(screen.getByText('No observations yet')).toBeTruthy();
});
it('requires a publishable token, saves without a request and keeps enablement an explicit staged edit', () => {
  const view = snapshot(), command = vi.fn(async () => true), change = vi.fn(); render(<CarrierBrandingSetup snapshot={view} enabled={false} change={change} busy={false} dirty={false} command={command}/>);
  fireEvent.click(screen.getByText('Manage Logo.dev token'));
  const input = screen.getByLabelText('Publishable image token'); fireEvent.change(input, { target: { value: 'sk_private_key' } }); expect((screen.getByRole('button', { name: 'Protect logo token' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'pk_fixture_token' } }); fireEvent.click(screen.getByRole('button', { name: 'Protect logo token' }));
  expect(command).toHaveBeenCalledWith({ action: 'save-carrier-logo-token', token: 'pk_fixture_token' }, expect.any(String)); expect(change).not.toHaveBeenCalled(); expect((input as HTMLInputElement).value).toBe('');
});
it('keeps Traffic changes inside the mounted view and clears them on expiry/removal/revocation', () => {
  const view = snapshot(); view.config.trafficEnabled = true;
  const traffic: TrafficSnapshot = { routeId: 'fixture-route', routeRevision: 'r', partial: false, durationSeconds: 600, delaySeconds: 0, freeFlowSeconds: 600, typicalSeconds: 600, distanceMeters: 10000, congestion: 'light', geometry: [], incidents: [], displayOnly: true, freshness: { provider: 'tomtom', fetchedAt: at, observedAt: null, freshUntil: new Date(now + 300000).toISOString(), revision: 'a', attribution: 'TomTom' } };
  view.traffic = traffic; const next = { ...view, traffic: { ...traffic, durationSeconds: 1500, freshness: { ...traffic.freshness, revision: 'b' } } };
  const changed = projectTrafficConditions(view, next, now); expect(changed.conditions[0]).toMatchObject({ category: 'commute-delay', displayOnly: true });
  expect(projectTrafficConditions(changed, { ...next, traffic: { ...next.traffic, durationSeconds: 1560, freshness: { ...traffic.freshness, revision: 'c' } } }, now).conditions[0].id).toBe(changed.conditions[0].id);
  expect(projectTrafficConditions(changed, { ...next, traffic: null }, now).conditions).toEqual([]);
  expect(projectTrafficConditions(changed, { ...next, reviewBlocked: true }, now).conditions).toEqual([]);
  expect(projectTrafficConditions(changed, { ...next, traffic: { ...next.traffic, routeRevision: 'edited-route' } }, now).conditions).toEqual([]);
  expect(projectTrafficConditions(changed, next, now + 300001).conditions).toEqual([]);
});
