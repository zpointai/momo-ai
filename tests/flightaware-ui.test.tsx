// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FlightAwareSetup } from '../src/desktop/situation/FlightAwareSetup';
import { emptySituationConfig, situationSnapshotSchema } from '../src/shared/situation';
import { SituationFlights } from '../src/desktop/situation/SituationFlights';
import { normalizeFlightAware, normalizeFlightAwarePosition } from '../electron/situation/flightAware';
import { flightTrackingView } from '../src/shared/flightTracking';
afterEach(cleanup);
function fixture() {
  return situationSnapshotSchema.parse({ config: emptySituationConfig(), selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'empty', detail: '', lastAttemptAt: null, lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: new Date().toISOString(), flightAware: { credential: 'missing', result: null, month: '2026-09', requests: 0, limit: 10 } });
}
it('shows the connected provider for an existing ICAO flight before lookup, and an honest empty result afterward', () => {
  const snapshot = fixture(), now = Date.parse('2026-09-29T09:00:00Z'), refresh = vi.fn();
  const flight = { id: crypto.randomUUID(), label: 'AHY071', kind: 'callsign' as const, identifier: 'AHY071' };
  snapshot.config.flightsEnabled = true; snapshot.config.trackedFlights = [flight]; snapshot.flightAware!.credential = 'configured';
  const view = render(<SituationFlights snapshot={snapshot} now={now} busy={false} refresh={refresh} configure={vi.fn()}/>);
  expect(screen.getByText('FlightAware connected · refresh for status and position.')).toBeTruthy();
  expect(screen.queryByText(/Connect FlightAware in Settings/)).toBeNull(); expect(screen.queryByText(/AvioADSB/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); expect(refresh).toHaveBeenCalledWith(flight.id);
  snapshot.flightAware!.result = normalizeFlightAware({ flights: [] }, 'AHY71', '2026-09-29', now);
  view.rerender(<SituationFlights snapshot={snapshot} now={now} busy={false} refresh={refresh} configure={vi.fn()}/>);
  expect(screen.getByText('No matching flight returned for this departure date.')).toBeTruthy();
  expect(flightTrackingView(snapshot, flight, now).lastCheckedAt).toBe(new Date(now).toISOString());
  snapshot.config.trackedFlights = [{ ...flight, kind: 'registration', identifier: 'N123AB' }];
  view.rerender(<SituationFlights snapshot={snapshot} now={now} busy={false} refresh={refresh} configure={vi.fn()}/>);
  expect(screen.getByText(/Stop tracking this entry and add an IATA or ICAO flight number/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
});
it('keeps the key write-only and requires a separate explicit lookup', () => {
  const command = vi.fn(async () => true), snapshot = fixture();
  const view = render(<FlightAwareSetup snapshot={snapshot} busy={false} dirty={false} command={command}/>);
  expect(command).not.toHaveBeenCalled();
  const input = screen.getByLabelText('FlightAware API key') as HTMLInputElement;
  expect(input.type).toBe('password'); fireEvent.change(input, { target: { value: 'isolated-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Protect FlightAware key' })); expect(input.value).toBe(''); expect(command).toHaveBeenCalledTimes(1);
  snapshot.flightAware!.credential = 'configured';
  expect((screen.getByRole('button', { name: 'Check flight · 1 request' }) as HTMLButtonElement).disabled).toBe(true);
  snapshot.config.flightsEnabled = true; view.rerender(<FlightAwareSetup snapshot={snapshot} busy={false} dirty={false} command={command}/>);
  fireEvent.change(screen.getByLabelText('FlightAware flight number'), { target: { value: 'W6 4513' } }); fireEvent.change(screen.getByLabelText('FlightAware departure date'), { target: { value: '2026-09-28' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check flight · 1 request' })); expect(command).toHaveBeenLastCalledWith({ action: 'check-flightaware', flightNumber: 'W64513', departureDate: '2026-09-28' }, expect.any(String));
  view.rerender(<FlightAwareSetup snapshot={snapshot} busy={false} dirty command={command}/>);
  expect((screen.getByRole('button', { name: 'Check flight · 1 request' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows status without inventing a position, and focuses a projected point without labeling it live', () => {
  const snapshot = fixture(), now = Date.parse('2026-09-28T15:00:00Z'), focus = vi.fn(), refresh = vi.fn();
  const flight = { id: crypto.randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513' };
  snapshot.config.flightsEnabled = true; snapshot.config.trackedFlights = [flight];
  snapshot.flightAware!.credential = 'configured';
  snapshot.flightAware!.result = normalizeFlightAware({ flights: [{ fa_flight_id: 'isolated-instance', ident_iata: 'W64513', status: 'En Route', scheduled_out: '2026-09-28T13:05:00Z', actual_out: '2026-09-28T13:00:00Z', estimated_in: '2026-09-28T15:50:00Z', origin: { code_iata: 'VAR', timezone: 'Europe/Sofia' }, destination: { code_iata: 'EIN', timezone: 'Europe/Amsterdam' } }] }, 'W64513', '2026-09-28', now);
  snapshot.flightAware!.position = normalizeFlightAwarePosition({ fa_flight_id: 'isolated-instance', last_position: null }, 'isolated-instance', now);
  const view = render(<SituationFlights snapshot={snapshot} now={now} busy={false} refresh={refresh} configure={vi.fn()} focus={focus}/>);
  expect(screen.getByText('VAR')).toBeTruthy(); expect(screen.getByText('EIN')).toBeTruthy(); expect(screen.getByText('En Route')).toBeTruthy();
  expect(screen.getByText('Position not supplied by FlightAware')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Focus on map' })).toBeNull();
  expect(document.querySelector('.is-live')).toBeNull(); expect(refresh).not.toHaveBeenCalled();
  snapshot.flightAware!.position = normalizeFlightAwarePosition({ fa_flight_id: 'isolated-instance', last_position: { latitude: 51, longitude: 6, altitude: 330, groundspeed: 450, heading: 300, timestamp: '2026-09-28T14:59:45Z', update_type: 'P' } }, 'isolated-instance', now);
  view.rerender(<SituationFlights snapshot={snapshot} now={now} busy={false} refresh={refresh} configure={vi.fn()} focus={focus}/>);
  expect(screen.getByText(/Projected position/)).toBeTruthy(); expect(document.querySelector('.is-live')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Focus on map' })); expect(focus).toHaveBeenCalledWith('isolated-instance'); expect(refresh).not.toHaveBeenCalled();
});
