// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { DesktopBridge } from '../src/shared/contracts';
import { emptySituationConfig, situationSnapshotSchema } from '../src/shared/situation';
vi.mock('../src/desktop/situation/SituationMap', () => ({ SituationMap: () => <div aria-label="Isolated map contract stub"/> }));
import { SituationView } from '../src/desktop/situation/SituationView';
import { SituationSettings } from '../src/desktop/situation/SituationSettings';
import { SituationConfigure } from '../src/desktop/situation/SituationConfigure';
import { SituationDetails } from '../src/desktop/situation/SituationDetails';
import { retainCurrentTraffic, useSituation } from '../src/desktop/situation/useSituation';
afterEach(() => { cleanup(); vi.useRealTimers(); });
function fixture() {
  const snapshot = situationSnapshotSchema.parse({ config: emptySituationConfig(), selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: source === 'flights' ? 'unavailable' : 'not-configured', detail: 'Source not configured for this isolated test.', lastAttemptAt: null, lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: new Date().toISOString() });
  const command = vi.fn(async (input: unknown) => { const v = input as { action: string; config?: typeof snapshot.config }; if (v.action === 'configure') snapshot.config = { ...v.config!, revision: snapshot.config.revision + 1 }; return { ok: true as const, value: structuredClone(snapshot) }; });
  return { snapshot, command, bridge: { situationCommand: command } as unknown as DesktopBridge };
}
it('renders truthful empty panels with no weather, route or flight request on open', async () => {
  const f = fixture(); render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByRole('heading', { name: 'Weather' });
  for (const title of ['Commute & Traffic', 'Time Zones', 'Flights', 'Recent Conditions']) expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(f.command.mock.calls.every(([c]) => (c as { action: string }).action === 'snapshot')).toBe(true);
  expect(screen.queryByText('18°C')).toBeNull();
});
it('directs a disabled Weather source to configuration and gives the last route an explicit empty state', async () => {
  const f = fixture(), id = crypto.randomUUID();
  f.snapshot.config.locations = [{ id, label: 'Fixture place', latitude: 51, longitude: 4, purpose: '', timezone: null, revision: 'a', updatedAt: new Date().toISOString() }];
  f.snapshot.selectedLocationId = id; f.snapshot.config.weatherEnabled = false; f.snapshot.statuses[0].state = 'disabled';
  render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByRole('heading', { name: 'Weather is off' });
  expect(screen.queryByRole('button', { name: 'Load weather' })).toBeNull(); expect(screen.getByRole('heading', { name: 'No saved commute route' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add route', exact: true })).toBeTruthy(); expect(f.command.mock.calls.every(([c]) => (c as { action: string }).action === 'snapshot')).toBe(true);
});
it('stages and cancels a configured place without native writes, then explicitly applies a validated revision', async () => {
  const f = fixture(); render(<SituationSettings bridge={f.bridge} active/>);
  await screen.findByText('Your view of the world');
  fireEvent.click(screen.getByText('Add a location', { selector: 'summary' }));
  fireEvent.change(screen.getByLabelText('New place label'), { target: { value: 'Isolated test place' } });
  fireEvent.change(screen.getByLabelText('New place latitude'), { target: { value: '52.1' } }); fireEvent.change(screen.getByLabelText('New place longitude'), { target: { value: '4.2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add to changes' }));
  expect(f.command).toHaveBeenCalledTimes(1); expect((screen.getByRole('button', { name: 'Apply changes' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true })); expect(f.command).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText('Online basemap')); fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'configure', expectedRevision: 0, config: expect.objectContaining({ mapEnabled: false, locations: [] }) })));
});
it('keeps traffic disabled and clears a write-only key after explicit protection', async () => {
  const f = fixture(); render(<SituationSettings bridge={f.bridge} active/>); await screen.findByText('Your view of the world');
  expect((screen.getByLabelText('Allow traffic requests') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Manage protected traffic key', { selector: 'summary' })); const input = screen.getByLabelText('TomTom API key') as HTMLInputElement;
  expect(input.value).toBe(''); fireEvent.change(input, { target: { value: 'isolated-canary' } }); fireEvent.click(screen.getByRole('button', { name: 'Protect key' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith({ action: 'save-traffic-key', secret: 'isolated-canary' })); expect(input.value).toBe('');
  expect(f.command.mock.calls.some(([c]) => (c as { action: string }).action === 'refresh')).toBe(false);
});
it('shows populated weather and four IANA clocks while keeping empty supporting cards compact', async () => {
  const f = fixture(), id = crypto.randomUUID(), now = new Date().toISOString();
  f.snapshot.config.locations = [{ id, label: 'Hendrik-Ido-Ambacht', latitude: 51.84, longitude: 4.64, timezone: 'Europe/Amsterdam', purpose: '', revision: 'a'.repeat(64), updatedAt: now }];
  f.snapshot.config.defaultLocationId = id; f.snapshot.selectedLocationId = id;
  f.snapshot.config.timezones = [['Hendrik-Ido-Ambacht', 'Europe/Amsterdam'], ['New York', 'America/New_York'], ['San Francisco', 'America/Los_Angeles'], ['Tokyo', 'Asia/Tokyo']].map(([label, timezone]) => ({ id: crypto.randomUUID(), label, timezone }));
  f.snapshot.weather = { locationId: id, locationRevision: 'a'.repeat(64), freshness: { provider: 'open-meteo', fetchedAt: now, observedAt: now, freshUntil: new Date(Date.now() + 1800000).toISOString(), revision: 'b'.repeat(64), attribution: 'Open-Meteo' }, partial: false, temperatureC: 18, apparentC: 17, code: 2, humidityPercent: 68, precipitationMm: 0, windKph: 14, windDegrees: 225, forecast: [{ date: '2026-09-27', code: 2, highC: 20, lowC: 12, precipitationProbability: 10, uvIndex: 3 }] };
  f.snapshot.statuses[0].state = 'available';
  const { container } = render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByText('Feels like 17° · High 20° / Low 12°');
  expect(screen.getByText('14 km/h SW')).toBeTruthy(); expect(screen.getByText('68%')).toBeTruthy();
  expect(container.querySelectorAll('.situation-world-clock')).toHaveLength(4);
  expect(container.querySelector('.situation-flights.is-empty')).toBeTruthy(); expect(container.querySelector('.situation-conditions.is-empty')).toBeTruthy();
  expect(screen.getByText('Add another place to create a commute route.')).toBeTruthy();
  expect(container.textContent).not.toMatch(/cache-control|Copyright API|licens|provider terms/i);
});
it('offers locality search and explicit route setup in the configuration workpane', async () => {
  const f = fixture(), settings = vi.fn();
  const { container } = render(<SituationConfigure bridge={f.bridge} active settings={settings}/>);
  await screen.findByRole('heading', { name: 'Configure Situation View' });
  for (const name of ['Places', 'Commute', 'Time zones', 'Flights', 'Data sources']) expect(screen.getByRole('heading', { name: new RegExp(`^${name}( |$)`) })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add route', exact: true }));
  expect(screen.getByText('Add another place to create a commute route.')).toBeTruthy();
  expect(f.command.mock.calls.every(([c]) => (c as { action: string }).action === 'snapshot')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add place', exact: true, expanded: false }));
  fireEvent.change(screen.getByLabelText('Find a locality'), { target: { value: 'Hendrik-Ido-Ambacht, Netherlands' } });
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(f.command).toHaveBeenCalledWith({ action: 'search-places', query: 'Hendrik-Ido-Ambacht, Netherlands' }));
  await screen.findByText('No matching locality. Try the city and country.');
  fireEvent.click(screen.getByRole('button', { name: 'Provider settings' })); expect(settings).toHaveBeenCalledOnce();
});
it('keeps exactly four primary layer controls and puts future layers behind configuration', async () => {
  const { SituationMap } = await vi.importActual<typeof import('../src/desktop/situation/SituationMap')>('../src/desktop/situation/SituationMap');
  const f = fixture(), configure = vi.fn();
  render(<SituationMap snapshot={f.snapshot} active={false} reducedMotion select={vi.fn()} settings={configure}/>);
  expect(screen.getAllByRole('checkbox').map(c => c.getAttribute('aria-label'))).toEqual(['Saved places', 'Weather', 'Traffic', 'Flights']);
  expect(screen.getAllByRole('checkbox').every(c => (c as HTMLInputElement).disabled)).toBe(true);
  expect(screen.queryByText('Satellite')).toBeNull(); expect(screen.queryByText('No data')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More layers →' })); expect(configure).toHaveBeenCalledOnce();
});
it('does not display retired nearby-aircraft data', async () => {
  const f = fixture(), now = new Date().toISOString(); f.snapshot.config.flightsEnabled = true;
  f.snapshot.statuses[2].state = 'available';
  f.snapshot.flights = { freshness: { provider: 'avioadsb', fetchedAt: now, observedAt: now, freshUntil: new Date(Date.now() + 60000).toISOString(), revision: 'c', attribution: 'Data: AvioADSB (CC BY 4.0)' }, partial: false, queryRevision: 'd', aircraft: [{ icao: 'abcdef', callsign: 'TEST123', registration: null, position: { latitude: 51.8, longitude: 4.6 }, altitudeFeet: 18000, groundSpeedKnots: 270, headingDegrees: 10, observedAt: now, origin: null, destination: null, trackedId: null }] };
  render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByRole('heading', { name: 'Track a flight' }); expect(screen.queryByText('TEST123')).toBeNull(); expect(screen.queryByText(/AvioADSB/)).toBeNull();
});
it('suppresses retired aircraft in overview and detail surfaces without requesting updates', async () => {
  const f = fixture(), now = new Date().toISOString(), details = vi.fn(); f.snapshot.config.flightsEnabled = true;
  f.snapshot.flights = { freshness: { provider: 'avioadsb', fetchedAt: now, observedAt: now, freshUntil: new Date(Date.now() + 60000).toISOString(), revision: 'c', attribution: 'Data: AvioADSB (CC BY 4.0)' }, partial: false, queryRevision: 'd', aircraft: Array.from({ length: 8 }, (_, index) => ({ icao: index.toString(16).padStart(6, '0'), callsign: 'TEST' + index, registration: null, position: { latitude: 51.8, longitude: 4.6 }, altitudeFeet: 18000, groundSpeedKnots: 270, headingDegrees: 10, observedAt: now, origin: null, destination: null, trackedId: null })) };
  const view = render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()} details={details}/>);
  await screen.findByRole('heading', { name: 'Track a flight' }); expect(screen.queryByText('TEST0')).toBeNull(); expect(screen.queryByRole('button', { name: 'View all aircraft' })).toBeNull();
  view.unmount(); f.command.mockClear();
  const request = { kind: 'flights' as const, snapshot: f.snapshot };
  const pane = render(<SituationDetails bridge={f.bridge} request={request} configure={vi.fn()}/>);
  expect(screen.queryByText('TEST7')).toBeNull(); expect(screen.getByText('Schedule & status')).toBeTruthy();
  fireEvent(window, new Event('resize')); pane.rerender(<SituationDetails bridge={f.bridge} request={request} configure={vi.fn()}/>);
  expect(screen.queryByText('TEST7')).toBeNull(); expect(f.command).not.toHaveBeenCalled();
});
it('retains a Configure draft across resize without searching or saving', async () => {
  const f = fixture(), settings = vi.fn(), pane = render(<SituationConfigure bridge={f.bridge} active settings={settings}/>);
  await screen.findByRole('heading', { name: 'Configure Situation View' });
  fireEvent.click(screen.getByRole('button', { name: 'Add place', expanded: false }));
  fireEvent.change(screen.getByLabelText('Find a locality'), { target: { value: 'Unsaved locality query' } });
  fireEvent(window, new Event('resize')); pane.rerender(<SituationConfigure bridge={f.bridge} active settings={settings}/>);
  expect((screen.getByLabelText('Find a locality') as HTMLInputElement).value).toBe('Unsaved locality query');
  expect(f.command.mock.calls.every(([c]) => (c as { action: string }).action === 'snapshot')).toBe(true);
});

function configuredCommute() {
  const f = fixture(), now = new Date().toISOString();
  const places = ['Origin', 'Destination'].map((label, i) => ({ id: crypto.randomUUID(), label, latitude: 51.8 + i / 10, longitude: 4.6, timezone: 'Europe/Amsterdam', purpose: '', revision: String(i).repeat(64), updatedAt: now }));
  const route = { id: crypto.randomUUID(), label: 'Saved commute', originId: places[0].id, destinationId: places[1].id, revision: 'c'.repeat(64), updatedAt: now };
  Object.assign(f.snapshot.config, { locations: places, routes: [route], defaultLocationId: places[0].id, defaultRouteId: route.id, trafficEnabled: true, flightsEnabled: true });
  Object.assign(f.snapshot, { selectedLocationId: places[0].id, selectedRouteId: route.id, trafficCredential: 'configured' });
  f.snapshot.statuses.forEach(status => { status.state = 'empty'; status.detail = 'Refresh for current observations.'; });
  const traffic = { routeId: route.id, routeRevision: route.revision, freshness: { provider: 'tomtom', fetchedAt: now, observedAt: now, freshUntil: new Date(Date.now() + 300000).toISOString(), revision: 'd', attribution: 'TomTom' }, partial: false, durationSeconds: 600, freeFlowSeconds: 500, typicalSeconds: 550, delaySeconds: 100, distanceMeters: 10000, congestion: 'light' as const, geometry: [[4.6, 51.8], [4.6, 51.9]] as [number, number][], incidents: [], displayOnly: true };
  return { ...f, traffic };
}

it('lets configured empty layers be checked to load once, keeps an empty selection checked, and hides without requests', async () => {
  const { SituationMap } = await vi.importActual<typeof import('../src/desktop/situation/SituationMap')>('../src/desktop/situation/SituationMap');
  const f = configuredCommute(), refresh = vi.fn(); f.snapshot.config.trackedFlights = [{ id: crypto.randomUUID(), kind: 'callsign', identifier: 'AHY071', label: 'AHY071' }]; f.snapshot.flightAware = { credential: 'configured', result: null, month: '2026-09', requests: 0, limit: 800 };
  const props = { snapshot: f.snapshot, active: false, reducedMotion: true, select: vi.fn(), settings: vi.fn(), refresh };
  const view = render(<SituationMap {...props}/>);
  for (const name of ['Traffic', 'Flights']) {
    const control = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(control.disabled).toBe(false); expect(control.checked).toBe(false);
    fireEvent.click(control); expect(control.checked).toBe(true);
    expect(refresh).toHaveBeenLastCalledWith(name.toLowerCase());
  }
  expect(refresh).toHaveBeenCalledTimes(2);
  view.rerender(<SituationMap {...props} snapshot={{ ...f.snapshot, statuses: f.snapshot.statuses.map(s => s.source === 'flights' ? { ...s, state: 'error' } : s) }}/>);
  expect((screen.getByRole('checkbox', { name: 'Flights' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Could not load · use Refresh')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Flights' }));
  expect(refresh).toHaveBeenCalledTimes(2);
  view.rerender(<SituationMap {...props} snapshot={{ ...f.snapshot, reviewBlocked: true }}/>);
  expect((screen.getByRole('checkbox', { name: 'Traffic' }) as HTMLInputElement).disabled).toBe(true);
});

it('describes a configured commute as ready to refresh, without asking to set it up again', async () => {
  const f = configuredCommute();
  render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByRole('heading', { name: 'Saved commute' });
  expect(screen.queryByText('Your commute is ready to set up')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Set up commute' })).toBeNull();
});

it('retains display-only traffic across the minute poll and other sources, then clears at its original expiry without traffic polling', async () => {
  vi.useFakeTimers();
  const f = configuredCommute();
  f.command.mockImplementation(async input => ({ ok: true, value: structuredClone((input as { source?: string }).source === 'traffic' ? { ...f.snapshot, traffic: f.traffic } : f.snapshot) }));
  const view = renderHook(() => useSituation(f.bridge, true));
  await act(async () => {});
  await act(async () => { await view.result.current.load('traffic'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
  expect(view.result.current.snapshot?.traffic).toEqual(f.traffic);
  expect(view.result.current.snapshot?.statuses.find(s => s.source === 'traffic')?.state).toBe('available');
  await act(async () => { await view.result.current.load('flights'); await view.result.current.load('weather'); });
  expect(view.result.current.snapshot?.traffic).toEqual(f.traffic);
  await act(async () => { await vi.advanceTimersByTimeAsync(239001); });
  expect(view.result.current.snapshot?.traffic).toBeNull();
  expect(view.result.current.snapshot?.statuses.find(s => s.source === 'traffic')?.state).toBe('empty');
  expect(f.command.mock.calls.filter(([input]) => (input as { source?: string }).source === 'traffic')).toHaveLength(1);
});

it.each(['permission', 'disabled', 'credential', 'configuration', 'route', 'failure', 'expired'] as const)('drops retained traffic on %s changes', reason => {
  const f = configuredCommute(), previous = { ...f.snapshot, traffic: f.traffic }, next = structuredClone(f.snapshot);
  if (reason === 'permission') next.reviewBlocked = true;
  if (reason === 'disabled') next.config.trafficEnabled = false;
  if (reason === 'credential') next.trafficCredential = 'missing';
  if (reason === 'configuration') next.config.routes[0].revision = 'changed';
  if (reason === 'route') next.selectedRouteId = null;
  if (reason === 'failure') next.statuses[1].state = 'error';
  expect(retainCurrentTraffic(previous, next, reason === 'expired' ? Date.parse(f.traffic.freshness.freshUntil) : Date.now()).traffic).toBeNull();
});

it('does not let the minute poll supersede an in-flight manual refresh and clears traffic when the workspace closes', async () => {
  vi.useFakeTimers();
  const f = configuredCommute();
  const view = renderHook(({ active }) => useSituation(f.bridge, active), { initialProps: { active: true } });
  await act(async () => {});
  let finish!: (value: { ok: true; value: typeof f.snapshot }) => void;
  f.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.load('traffic'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
  expect(f.command).toHaveBeenCalledTimes(2);
  await act(async () => { finish({ ok: true, value: { ...f.snapshot, traffic: f.traffic } }); await pending; });
  expect(view.result.current.snapshot?.traffic).toEqual(f.traffic);
  view.rerender({ active: false });
  expect(view.result.current.snapshot?.traffic).toBeNull();
});

it('shows first-click Traffic loading, prevents duplicate submissions and publishes the completed route once', async () => {
  const f = configuredCommute();
  const { container } = render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByRole('heading', { name: 'Saved commute' });
  let finish!: (value: { ok: true; value: typeof f.snapshot }) => void;
  f.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refresh = container.querySelector('.situation-traffic header button') as HTMLButtonElement;
  fireEvent.click(refresh);
  expect(refresh.textContent).toBe('Refreshing…'); expect(refresh.disabled).toBe(true);
  fireEvent.click(refresh); expect(f.command.mock.calls.filter(([input]) => (input as { action: string }).action === 'refresh')).toHaveLength(1);
  await act(async () => finish({ ok: true, value: { ...f.snapshot, traffic: f.traffic } }));
  expect(container.querySelectorAll('.situation-commute-summary')).toHaveLength(1);
  expect(refresh.disabled).toBe(false); expect(refresh.textContent).toBe('Refresh');
});

it('retains a saved flight when not observed, exposes one tracked refresh and never invents scheduled status', async () => {
  const f = configuredCommute(), flight = { id: crypto.randomUUID(), kind: 'callsign' as const, identifier: 'WZZ4513', label: 'W6 4513' };
  f.snapshot.config.trackedFlights = [flight]; f.snapshot.flightAware = { credential: 'configured', result: null, month: '2026-09', requests: 0, limit: 800 };
  const { container } = render(<SituationView bridge={f.bridge} active reducedMotion timezone="Europe/Amsterdam" settings={vi.fn()}/>);
  await screen.findByText('W6 4513'); expect(screen.getByText('Wizz Air')).toBeTruthy(); expect(screen.getByText('Not currently observed')).toBeTruthy();
  fireEvent.click(container.querySelector('.situation-flights header button')!);
  await waitFor(() => expect(f.command).toHaveBeenCalledWith({ action: 'refresh', source: 'flights', flightId: flight.id }));
  expect(screen.getByText('W6 4513')).toBeTruthy(); expect(container.textContent).not.toMatch(/Varna|Eindhoven|On time|Scheduled departure|gate/i);
});
