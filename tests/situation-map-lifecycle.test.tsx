// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { emptySituationConfig, situationSnapshotSchema } from '../src/shared/situation';
const mock = vi.hoisted(() => ({ maps: [] as unknown[], markers: [] as { point: number[]; element: HTMLElement; removed: boolean }[] }));
vi.mock('maplibre-gl', () => {
  class Map {
    loaded = false; removed = false; sources = new globalThis.Map(); handlers = new globalThis.Map<string, Set<() => void>>();
    canvas = document.createElement('canvas'); center = [10, 25]; zoom = 9;
    constructor(options: { center: number[]; zoom: number }) { this.center = options.center; this.zoom = options.zoom; mock.maps.push(this); }
    on(name: string, fn: () => void) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name)!.add(fn); }
    off(name: string, fn: () => void) { this.handlers.get(name)?.delete(fn); }
    emit(name: string) { if (name === 'load') this.loaded = true; this.handlers.get(name)?.forEach(fn => fn()); }
    addControl() {} getCanvas() { return this.canvas; } areTilesLoaded() { return this.loaded; }
    getSource(id: string) { return this.sources.get(id); }
    addSource(id: string) { if (!this.loaded) throw Error('Style is not done loading.'); this.sources.set(id, { setData: vi.fn() }); }
    addLayer() { if (!this.loaded) throw Error('Style is not done loading.'); }
    getCenter() { return { toArray: () => this.center }; } getZoom() { return this.zoom; }
    flyTo(v: { center: number[]; zoom: number }) { this.center = v.center; this.zoom = v.zoom; }
    resize() {} remove() { this.removed = true; } project() { return { x: 100, y: 100 }; }
  }
  class Marker {
    point: number[] = []; removed = false; element: HTMLElement;
    constructor(options: { element: HTMLElement }) { this.element = options.element; mock.markers.push(this); }
    setLngLat(point: number[]) { this.point = point; return this; }
    setOffset() { return this; } addTo() { document.body.append(this.element); return this; }
    remove() { this.removed = true; this.element.remove(); }
  }
  return { Map, Marker, setWorkerUrl: vi.fn(), NavigationControl: class {}, AttributionControl: class {}, ScaleControl: class {} };
});

function layerFixture(withPosition: boolean) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const now = Date.now(), at = new Date(now).toISOString();
  const flight = { id: crypto.randomUUID(), kind: 'callsign' as const, identifier: 'AHY071', label: 'AHY071' };
  const snapshot = situationSnapshotSchema.parse({ config: { ...emptySituationConfig(), flightsEnabled: true, trackedFlights: [flight] },
    selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'empty', detail: '', lastAttemptAt: null, lastError: null })),
    trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: at,
    flightAware: { credential: 'configured', month: at.slice(0, 7), requests: 0, limit: 800,
      result: withPosition ? normalizeFlightAware({ flights: [{ fa_flight_id: 'layer-flight', ident_icao: 'AHY71', scheduled_out: at, origin: { timezone: 'UTC' } }] }, 'AHY71', at.slice(0, 10), now) : null,
      position: withPosition ? normalizeFlightAwarePosition({ fa_flight_id: 'layer-flight', last_position: { latitude: 46.9, longitude: 20.5, timestamp: at, heading: 297, update_type: 'A' } }, 'layer-flight', now) : null } });
  return { snapshot, now, active: true, reducedMotion: true, select: vi.fn(), settings: vi.fn(), refresh: vi.fn(), selectedFlightId: flight.id };
}
type LayerMap = { emit(name: string): void; center: number[]; zoom: number };
it('focuses the selected cached aircraft when Flights is enabled, then preserves manual camera changes', () => {
  const props = layerFixture(true), view = render(<SituationMap {...props}/>);
  const map = mock.maps.at(-1) as LayerMap; act(() => map.emit('load'));
  map.center = [4.5, 51.8];
  const layer = view.getByRole('checkbox', { name: 'Flights' });
  fireEvent.click(layer); fireEvent.click(layer);
  expect(map.center).toEqual([20.5, 46.9]); expect(props.refresh).not.toHaveBeenCalled();
  map.center = [19, 47]; map.zoom = 8;
  view.rerender(<SituationMap {...props} snapshot={{ ...props.snapshot }} now={props.now + 1000}/>);
  expect(map.center).toEqual([19, 47]); expect(map.zoom).toBe(8); expect(mock.maps).toHaveLength(1);
});
it('enables Flights with one refresh and focuses after its position arrives', () => {
  const props = layerFixture(false), view = render(<SituationMap {...props}/>);
  const map = mock.maps.at(-1) as LayerMap; act(() => map.emit('load')); map.center = [4.5, 51.8];
  fireEvent.click(view.getByRole('checkbox', { name: 'Flights' }));
  expect(props.refresh).toHaveBeenCalledExactlyOnceWith('flights'); expect(map.center).toEqual([4.5, 51.8]);
  view.rerender(<SituationMap {...props} busy/>);
  const snapshot = { ...props.snapshot, flightAware: layerFixture(true).snapshot.flightAware };
  view.rerender(<SituationMap {...props} snapshot={snapshot}/>);
  expect(map.center).toEqual([20.5, 46.9]); expect(props.refresh).toHaveBeenCalledTimes(1);
  map.center = [19, 47]; view.rerender(<SituationMap {...props} snapshot={{ ...snapshot }}/>);
  expect(map.center).toEqual([19, 47]);
});
it.each(['disabled', 'selection-changed', 'empty'] as const)('cancels pending layer focus after %s without another request', reason => {
  const props = layerFixture(false), view = render(<SituationMap {...props}/>);
  const map = mock.maps.at(-1) as LayerMap; act(() => map.emit('load')); map.center = [4.5, 51.8];
  fireEvent.click(view.getByRole('checkbox', { name: 'Flights' }));
  if (reason === 'disabled') fireEvent.click(view.getByRole('checkbox', { name: 'Flights' }));
  if (reason === 'selection-changed') view.rerender(<SituationMap {...props} selectedFlightId="another-flight"/>);
  if (reason === 'empty') view.rerender(<SituationMap {...props} snapshot={{ ...props.snapshot, flightAware: { ...props.snapshot.flightAware!, result: normalizeFlightAware({ flights: [] }, 'AHY71', new Date(props.now).toISOString().slice(0, 10), props.now + 10) } }}/>);
  view.rerender(<SituationMap {...props} snapshot={{ ...props.snapshot, flightAware: layerFixture(true).snapshot.flightAware }}/>);
  expect(map.center).toEqual([4.5, 51.8]); expect(props.refresh).toHaveBeenCalledTimes(1);
});
import { SituationMap } from '../src/desktop/situation/SituationMap';
import { normalizeFlightAware, normalizeFlightAwarePosition } from '../electron/situation/flightAware';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mock.maps.length = 0; mock.markers.forEach(m => m.element.remove()); mock.markers.length = 0; });
it('survives 20 loaded-map departure/return cycles and full remounts without using a previous map readiness flag', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const snapshot = situationSnapshotSchema.parse({ config: emptySituationConfig(), selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'empty', detail: '', lastAttemptAt: null, lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: new Date().toISOString() });
  const props = { snapshot, reducedMotion: true, select: vi.fn(), settings: vi.fn(), refresh: vi.fn() };
  const view = render(<SituationMap {...props} active/>);
  type TestMap = { loaded: boolean; removed: boolean; sources: Map<string, unknown>; handlers: Map<string, Set<unknown>>; emit(name: string): void; center: number[]; zoom: number };
  let current = mock.maps.at(-1) as TestMap;
  act(() => current.emit('load')); current.center = [4.5, 51.8]; current.zoom = 12;
  for (let i = 0; i < 20; i++) {
    view.rerender(<SituationMap {...props} active={false}/>);
    expect(current.removed).toBe(true);
    view.rerender(<SituationMap {...props} snapshot={{ ...snapshot }} active/>);
    current = mock.maps.at(-1) as TestMap;
    expect(current.loaded).toBe(false); expect(current.sources.size).toBe(0);
    act(() => current.emit('load'));
    expect(current.sources.size).toBe(3); expect(current.center).toEqual([4.5, 51.8]); expect(current.zoom).toBe(12);
    expect(current.handlers.get('resize')?.size).toBe(1);
  }
  view.unmount();
  for (let i = 0; i < 20; i++) { const mounted = render(<SituationMap {...props} active/>); current = mock.maps.at(-1) as TestMap; act(() => current.emit('load')); mounted.unmount(); expect(current.removed).toBe(true); }
  expect(props.refresh).not.toHaveBeenCalled();
});
it('places the tracked glyph at its real coordinates, focuses once without a request, and removes stale markers without replacing the map', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const now = Date.now(), flight = { id: crypto.randomUUID(), kind: 'callsign' as const, identifier: 'WZZ4513', label: 'W6 4513' };
  const at = new Date(now).toISOString();
  const flightAware = { credential: 'configured', month: at.slice(0, 7), requests: 2, limit: 800,
    result: normalizeFlightAware({ flights: [{ fa_flight_id: 'fixture-flight', ident_iata: 'W64513', scheduled_out: at, origin: { timezone: 'UTC' } }] }, 'W64513', at.slice(0, 10), now),
    position: normalizeFlightAwarePosition({ fa_flight_id: 'fixture-flight', last_position: { latitude: 51.8, longitude: 4.6, timestamp: at, heading: 287, update_type: 'A' } }, 'fixture-flight', now) };
  const snapshot = situationSnapshotSchema.parse({ config: { ...emptySituationConfig(), flightsEnabled: true, trackedFlights: [flight] }, selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, flightAware, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'available', detail: '', lastAttemptAt: null, lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: new Date(now).toISOString() });
  const props = { snapshot, active: true, reducedMotion: true, select: vi.fn(), settings: vi.fn(), refresh: vi.fn(), chooseAircraft: vi.fn(), selectedFlightId: flight.id, now };
  const view = render(<SituationMap {...props}/>);
  const map = mock.maps.at(-1) as { emit(name: string): void; center: number[]; zoom: number };
  act(() => map.emit('load'));
  const marker = mock.markers.find(m => !m.removed)!;
  expect(marker.point).toEqual([4.6, 51.8]); expect(marker.element.getAttribute('aria-pressed')).toBe('true');
  marker.element.click(); expect(props.chooseAircraft).toHaveBeenCalledWith(expect.objectContaining({ flightAwareId: 'fixture-flight' }));
  const focus = { icao: 'fixture-flight', sequence: 1 };
  view.rerender(<SituationMap {...props} aircraftFocus={focus}/>); expect(map.center).toEqual([4.6, 51.8]);
  map.center = [4.2, 51.2]; map.zoom = 10;
  view.rerender(<SituationMap {...props} snapshot={{ ...snapshot }} aircraftFocus={focus}/>);
  expect(map.center).toEqual([4.2, 51.2]); expect(map.zoom).toBe(10); expect(mock.maps).toHaveLength(1);
  view.rerender(<SituationMap {...props} now={now + 900001} aircraftFocus={focus}/>);
  expect(mock.markers.filter(m => !m.removed)).toHaveLength(0); expect(snapshot.config.trackedFlights).toHaveLength(1);
  expect(props.refresh).not.toHaveBeenCalled(); expect(props.select).not.toHaveBeenCalled();
  // Return to a current sample, then remove its tracking configuration explicitly.
  view.rerender(<SituationMap {...props} aircraftFocus={focus}/>);
  expect(mock.markers.filter(m => !m.removed)).toHaveLength(1);
  view.rerender(<SituationMap {...props} snapshot={{ ...snapshot, config: { ...snapshot.config, trackedFlights: [] }, flights: null }} aircraftFocus={focus}/>);
  expect(mock.markers.filter(m => !m.removed)).toHaveLength(0); expect(document.querySelector('.situation-aircraft-marker.selected')).toBeNull();
  expect(map.center).toEqual([4.2, 51.2]); expect(map.zoom).toBe(10); expect(mock.maps).toHaveLength(1);
  expect(props.refresh).not.toHaveBeenCalled();
});
