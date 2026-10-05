// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { emptySituationConfig, situationSnapshotSchema } from '../src/shared/situation';
import { flightTrackingView, freshAircraft } from '../src/shared/flightTracking';
import { normalizeAircraft, AvioAircraft } from '../electron/situation/providers';
import type { SituationTransport } from '../electron/situation/providers';
import { SituationFlights } from '../src/desktop/situation/SituationFlights';
import { FlightDetailsContent } from '../src/desktop/situation/TrackedFlight';
import { normalizeFlightAware, normalizeFlightAwarePosition } from '../electron/situation/flightAware';
import { aircraftMarker } from '../src/desktop/situation/aircraftMarker';

const now = Date.now(), flight = { id: crypto.randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513' };
const raw = { hex: '4ca123', flight: 'WZZ4513', lat: 51.8, lon: 4.6, alt_baro: 34000, gs: 438, track: 287, seen_pos: 18, r: 'HA-LXH', t: 'A321', desc: 'AIRBUS A-321' };
function fixture(ac: unknown[] = [raw]) {
  const flights = { ...normalizeAircraft({ ac, now }, [flight], now, 'avioadsb'), queriedFlightId: flight.id };
  const item = ac[0] as typeof raw | undefined;
  const flightAware = { credential: 'configured', month: '2026-09', requests: 2, limit: 800,
    result: normalizeFlightAware({ flights: item ? [{ fa_flight_id: 'fixture-flight', ident_iata: 'W64513', scheduled_out: new Date(now).toISOString(), origin: { timezone: 'UTC' }, registration: item.r, aircraft_type: item.t }] : [] }, 'W64513', new Date(now).toISOString().slice(0, 10), now),
    position: normalizeFlightAwarePosition({ fa_flight_id: 'fixture-flight', last_position: item ? { latitude: item.lat, longitude: item.lon, altitude: item.alt_baro / 100, groundspeed: item.gs, heading: item.track, timestamp: new Date(now - 18000).toISOString(), update_type: 'A' } : null }, 'fixture-flight', now) };
  return situationSnapshotSchema.parse({ flightAware, config: { ...emptySituationConfig(), flightsEnabled: true, trackedFlights: [flight] }, selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'available', detail: '', lastAttemptAt: new Date(now).toISOString(), lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: new Date(now).toISOString() });
}
afterEach(cleanup);
it('groups the real available metrics and coordinates focus/details without requesting another observation', () => {
  const focus = vi.fn(), details = vi.fn(), refresh = vi.fn(), snapshot = fixture();
  render(<SituationFlights snapshot={snapshot} now={now} busy={false} configure={vi.fn()} focus={focus} details={details} refresh={refresh} selectedFlightId={flight.id}/>);
  expect(screen.getByRole('heading', { name: 'W6 4513' })).toBeTruthy();
  expect(screen.getByText('Live position · 18 sec ago')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Focus on map' })); expect(focus).toHaveBeenCalledWith('fixture-flight');
  fireEvent.click(screen.getByRole('button', { name: 'Flight details' })); expect(details).toHaveBeenCalledWith(flight.id);
  expect(refresh).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/Varna|Eindhoven|On time|ETA/);
});
it('retains absent tracking with a last-checked time, then removes a stale live position without inventing schedule status', () => {
  const snapshot = fixture([]), model = flightTrackingView(snapshot, flight, now);
  expect(model.livePosition).toBeNull(); expect(model.scheduleStatus).toEqual({ state: 'empty' }); expect(model.lastCheckedAt).toBe(new Date(now).toISOString());
  render(<SituationFlights snapshot={snapshot} now={now} busy={false} configure={vi.fn()} refresh={vi.fn()}/>);
  expect(screen.getByText('Not currently observed')).toBeTruthy(); expect(screen.getByText(/^Last checked/)).toBeTruthy();
  expect(freshAircraft(fixture(), now + 120000)).toEqual([]); expect(flightTrackingView(fixture(), flight, now + 120000).livePosition).toBeNull();
  expect(snapshot.config.trackedFlights).toEqual([flight]);
  snapshot.flightChecks = [{ flightId: flight.id, at: snapshot.flights!.freshness.fetchedAt }]; snapshot.flights = null;
  expect(flightTrackingView(snapshot, flight, now + 120000).lastCheckedAt).toBe(new Date(now).toISOString());
});
it.each([287, null])('rotates the crisp selected marker using heading %s, supports focus, and opens the existing detail action', heading => {
  const a = fixture().flights!.aircraft[0], select = vi.fn(); a.headingDegrees = heading;
  const marker = aircraftMarker(a, flight.label, true, select); document.body.append(marker);
  expect(marker.querySelector('svg')!.style.transform).toBe(`rotate(${heading ?? 0}deg)`);
  expect(marker.getAttribute('aria-pressed')).toBe('true'); expect(marker.classList.contains('selected')).toBe(true);
  expect(marker.textContent).toContain('34,000 ft · 438 kt'); expect(marker.textContent).toContain('WZZ4513');
  marker.focus(); expect(document.activeElement).toBe(marker); marker.click(); expect(select).toHaveBeenCalledTimes(1); marker.remove();
});
it.each([true, false])('shows registration and aircraft type only when reported (%s)', present => {
  const snapshot = fixture([{ ...raw, r: present ? raw.r : undefined, t: present ? raw.t : undefined, desc: present ? raw.desc : undefined }]);
  render(<FlightDetailsContent snapshot={snapshot} flightId={flight.id} now={now}/>);
  expect(!!screen.queryByText('HA-LXH')).toBe(present); expect(screen.queryAllByText('A321').length > 0).toBe(present);
  expect(screen.getByText('Schedule & status')).toBeTruthy(); for (const value of ['34,000 ft', '438 kt', '287°']) expect(screen.getByText(value)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Varna|Eindhoven|On time|ETA/);
});
it('labels the queried tracking identity even for an empty native provider response', async () => {
  const transport = { get: vi.fn(async () => ({ ac: [], now })) };
  const result = await new AvioAircraft(transport as unknown as SituationTransport, () => now).read(undefined, [flight], flight.id);
  expect(result.queriedFlightId).toBe(flight.id); expect(result.aircraft).toEqual([]);
  expect(transport.get).toHaveBeenCalledTimes(1);
});
