import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type * as GeoJSON from 'geojson';
import { type GeoJSONSource, type Map as LibreMap } from 'maplibre-gl';
import { Globe2, Layers, LocateFixed, MapPin, RefreshCw } from 'lucide-react';
import { situationLayers, situationMapFocus, freshnessState, type SituationSnapshot, type AircraftPosition } from '../../shared/situation';
import { openFreeMap, type MapProvider } from './MapProvider';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapPlaceLabels } from './mapLabels';
import { aircraftMarker } from './aircraftMarker';
import { animateAircraftEstimate } from './aircraftMotion';
import { aircraftDisplayPosition, aircraftEstimateLabel, canEstimateAircraft } from '../../shared/aircraftEstimate';
import { mappedAircraft, aircraftIdentity, positionLabel } from '../../shared/flightTracking';
import { commercialFlightNumber } from '../../shared/flightAware';

type Layer = keyof ReturnType<typeof situationLayers>;
const layerNames: Record<Layer, string> = { places: 'Saved places', weather: 'Weather', traffic: 'Traffic', roads: 'Road incidents', flights: 'Flights', satellite: 'Satellite', radar: 'Weather radar' };
export function SituationMap({ snapshot, active, reducedMotion, select, settings, refresh, busy = false, now = Date.now(), aircraftFocus, selectedFlightId, chooseAircraft, provider = openFreeMap }: { snapshot: SituationSnapshot; active: boolean; reducedMotion: boolean; select(id: string): void; settings(): void; refresh?(source: 'weather' | 'traffic' | 'flights'): void; busy?: boolean; provider?: MapProvider; now?: number; aircraftFocus?: { icao: string; sequence: number }; selectedFlightId?: string; chooseAircraft?(aircraft: AircraftPosition): void }) {
  const host = useRef<HTMLDivElement>(null), map = useRef<LibreMap | null>(null), loadedMap = useRef<LibreMap | null>(null), markers = useRef<maplibregl.Marker[]>([]);
  const camera = useRef<{ center: [number, number]; zoom: number; placeKey: string } | null>(null), focusedPlace = useRef('');
  const aircraftPositions = useRef(new Map<string, { point: [number, number]; observedAt: string }>());
  const [state, setState] = useState<'loading' | 'available' | 'error' | 'partial'>('loading'), [generation, setGeneration] = useState(0), [ready, setReady] = useState(false);
  const [chosen, setChosen] = useState<Partial<Record<Layer, boolean>>>({});
  const [layerFlightFocus, setLayerFlightFocus] = useState<{ id: string; response: string } | null>(null);
  const flightResponse = JSON.stringify([snapshot.flightAware?.requests, snapshot.flightAware?.result?.checkedAt, snapshot.flightAware?.error?.at, snapshot.flightAware?.positionError]);
  const available = { ...situationLayers(snapshot), flights: mappedAircraft(snapshot, now).length > 0 }, place = snapshot.config.locations.find(p => p.id === snapshot.selectedLocationId);
  const layers = { ...available, ...chosen, roads: chosen.traffic ?? available.traffic };
  const canRefresh = (source: 'weather' | 'traffic' | 'flights') => !!refresh && !snapshot.reviewBlocked && snapshot.statuses.find(s => s.source === source)?.state !== 'disabled' && (source === 'traffic'
    ? snapshot.config.trafficEnabled && snapshot.trafficCredential === 'configured' && !!snapshot.selectedRouteId
    : source === 'weather' ? !!place && snapshot.config.weatherEnabled
    : snapshot.config.flightsEnabled && snapshot.flightAware?.credential === 'configured' && !!commercialFlightNumber(snapshot.config.trackedFlights.find(f => f.id === selectedFlightId) ?? snapshot.config.trackedFlights[0] ?? { id: '', kind: 'callsign', identifier: '', label: '' }));
  const enabled = { ...available, weather: available.weather || canRefresh('weather'), traffic: available.traffic || canRefresh('traffic'), flights: available.flights || canRefresh('flights') };
  const toggle = (key: Layer, checked: boolean) => {
    setChosen(v => ({ ...v, [key]: checked }));
    if (key === 'flights') {
      const id = selectedFlightId ?? snapshot.config.trackedFlights[0]?.id;
      setLayerFlightFocus(checked && id ? { id, response: flightResponse } : null);
    }
    if (checked && (key === 'weather' || key === 'traffic' || key === 'flights') && !available[key] && canRefresh(key)) refresh?.(key);
  };
  const selectRef = useRef(select); selectRef.current = select;
  useEffect(() => {
    if (!host.current || !active || !snapshot.config.mapEnabled) return;
    setState('loading'); setReady(false); let alive = true, loaded = false;
    const timeout = window.setTimeout(() => { if (alive && !loaded) setState('error'); }, 20000);
    try {
      maplibregl.setWorkerUrl(new URL('assets/maplibre-worker.js', document.baseURI).href);
      const placeKey = place ? `${place.id}:${place.latitude}:${place.longitude}` : '', savedCamera = camera.current?.placeKey === placeKey ? camera.current : null;
      const m = new maplibregl.Map({ container: host.current, style: provider.style, ...(savedCamera ? { center: savedCamera.center, zoom: savedCamera.zoom } : situationMapFocus(place)), maxZoom: 18, attributionControl: false,
        transformRequest: url => { if (!provider.requestAllowed(url)) throw Error('Unsupported map resource.'); return { url, credentials: 'same-origin' }; } });
      map.current = m; loadedMap.current = null; focusedPlace.current = placeKey;
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
      m.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-right');
      m.on('load', () => { if (!alive) return; loaded = true; loadedMap.current = m; window.clearTimeout(timeout); setReady(true); setState('available'); m.getCanvas().setAttribute('aria-label', 'Interactive world map. Use arrow keys to pan and plus or minus to zoom.'); });
      m.on('error', () => { if (alive) setState(loaded ? 'partial' : 'error'); });
      m.on('idle', () => { if (alive && loaded && m.areTilesLoaded()) setState('available'); });
      const resize = new ResizeObserver(() => m.resize()); resize.observe(host.current);
      return () => { alive = false; camera.current = { center: m.getCenter().toArray() as [number, number], zoom: m.getZoom(), placeKey: focusedPlace.current }; loadedMap.current = null; window.clearTimeout(timeout); resize.disconnect(); markers.current.forEach(m => m.remove()); markers.current = []; m.remove(); map.current = null; };
    } catch { setState('error'); window.clearTimeout(timeout); }
  }, [active, snapshot.config.mapEnabled, generation, provider]);
  useEffect(() => {
    const m = map.current; if (!m || !ready || loadedMap.current !== m) return;
    const key = place ? `${place.id}:${place.latitude}:${place.longitude}` : '';
    if (key !== focusedPlace.current) { focusedPlace.current = key; m.flyTo({ ...situationMapFocus(place), duration: reducedMotion ? 0 : 500, essential: false }); }
  }, [place?.id, place?.latitude, place?.longitude, ready, reducedMotion]);
  useEffect(() => {
    const m = map.current; if (!m || !ready || loadedMap.current !== m || !aircraftFocus) return;
    const a = mappedAircraft(snapshot).find(a => aircraftIdentity(a) === aircraftFocus.icao); if (!a) return;
    setChosen(v => ({ ...v, flights: true }));
    const center = aircraftPositions.current.get(aircraftIdentity(a))?.point ?? aircraftDisplayPosition(a, Date.now(), canEstimateAircraft(snapshot, a) && !reducedMotion).point;
    m.flyTo({ center, zoom: Math.max(m.getZoom(), 7), duration: reducedMotion ? 0 : 500, essential: false });
  }, [aircraftFocus, ready]);
  useEffect(() => {
    if (!layerFlightFocus) return;
    const selected = selectedFlightId ?? snapshot.config.trackedFlights[0]?.id;
    if (!active || !layers.flights || selected !== layerFlightFocus.id) { setLayerFlightFocus(null); return; }
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m || busy) return;
    const aircraft = mappedAircraft(snapshot, now).find(a => a.trackedId === layerFlightFocus.id);
    if (aircraft) {
      const reduced = reducedMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      const center = aircraftDisplayPosition(aircraft, Math.max(now, Date.now()), canEstimateAircraft(snapshot, aircraft) && !reduced).point;
      m.flyTo({ center, zoom: Math.max(m.getZoom(), 7), duration: reduced ? 0 : 500, essential: false });
      setLayerFlightFocus(null);
    } else {
      // An empty/error response completes this intent. Later unrelated refreshes must not steal the camera.
      if (flightResponse !== layerFlightFocus.response) setLayerFlightFocus(null);
    }
  }, [layerFlightFocus, flightResponse, snapshot, selectedFlightId, active, layers.flights, ready, busy, now, reducedMotion]);
  useEffect(() => {
    const m = map.current; if (!m || !ready || !active || loadedMap.current !== m) return;
    let cancelAnimations: (() => void)[] = [];
    const drawLabels = () => {
      cancelAnimations.forEach(cancel => cancel()); cancelAnimations = [];
      if (!layers.flights) aircraftPositions.current.clear();
      const aircraftIds = new Set(mappedAircraft(snapshot, now).map(aircraftIdentity));
      for (const id of aircraftPositions.current.keys()) if (!aircraftIds.has(id)) aircraftPositions.current.delete(id);
      const focusedAircraft = (document.activeElement as HTMLElement | null)?.dataset.aircraft;
      markers.current.forEach(marker => marker.remove()); markers.current = [];
      const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
      const labels = mapPlaceLabels(snapshot, p => m.project([p.longitude, p.latitude]));
      for (const group of labels) {
        const p = group.place, weatherPlace = [p, ...group.nearby].find(v => v.id === snapshot.weather?.locationId);
        if (!layers.places && !(layers.weather && weatherPlace)) continue;
        const button = document.createElement('button');
        button.className = 'situation-place-marker' + (group.selected ? ' selected' : '') + (group.role ? ' route-' + group.role : '');
        button.setAttribute('aria-label', 'Focus ' + [p.label, ...group.nearby.map(v => v.label)].join(', nearby '));
        button.title = [p.label, group.role === 'origin' ? 'Route start' : group.role === 'destination' ? 'Route destination' : '', ...group.nearby.map(v => 'Nearby: ' + v.label)].filter(Boolean).join(' · ');
        const dot = document.createElement('span'); dot.className = 'situation-place-dot'; dot.setAttribute('aria-hidden', 'true'); button.append(dot);
        const text = document.createElement('span'); text.className = 'situation-marker-label';
        const name = document.createElement('strong'); name.textContent = p.label; text.append(name);
        for (const nearby of group.nearby) { const sub = document.createElement('small'); sub.textContent = 'Nearby: ' + nearby.label; text.append(sub); }
        if (layers.weather && weatherPlace && snapshot.weather?.temperatureC !== null && snapshot.weather) {
          const value = document.createElement('small'); value.textContent = Math.round(snapshot.weather.temperatureC) + '°C' + (freshnessState(snapshot.weather.freshness) === 'stale' ? ' · stale' : ''); text.append(value);
        }
        button.append(text); button.onclick = () => selectRef.current(p.id);
        const marker = new maplibregl.Marker({ element: button, anchor: 'bottom-left', offset: [12, -12] }).setLngLat([p.longitude, p.latitude]).addTo(m);
        const point = m.project([p.longitude, p.latitude]), width = button.offsetWidth, height = button.offsetHeight;
        const candidates = [[12, -12], [-width - 12, -12], [12, height + 12], [-width - 12, height + 12], [12, -height - 28], [-width - 12, height * 2 + 28]];
        let best = candidates[0], bestScore = Infinity;
        for (const offset of candidates) {
          const box = { left: point.x + offset[0], right: point.x + offset[0] + width, top: point.y + offset[1] - height, bottom: point.y + offset[1] };
          const overlap = occupied.reduce((sum, b) => sum + Math.max(0, Math.min(box.right, b.right) - Math.max(box.left, b.left)) * Math.max(0, Math.min(box.bottom, b.bottom) - Math.max(box.top, b.top)), 0);
          const outside = box.left < 0 || box.top < 0 || box.right > m.getCanvas().clientWidth || box.bottom > m.getCanvas().clientHeight;
          const score = overlap + (outside ? 100000 : 0); if (score < bestScore) { bestScore = score; best = offset; }
        }
        marker.setOffset(best as [number, number]);
        occupied.push({ left: point.x + best[0], right: point.x + best[0] + width, top: point.y + best[1] - height, bottom: point.y + best[1] });
        markers.current.push(marker);
      }
      if (layers.flights) for (const a of mappedAircraft(snapshot, now).filter(a => a.trackedId)) {
        const tracking = snapshot.config.trackedFlights.find(f => f.id === a.trackedId);
        const button = aircraftMarker(a, tracking?.label ?? a.callsign ?? a.icao, a.trackedId === selectedFlightId, () => chooseAircraft?.(a), positionLabel(snapshot, a, now));
        const marker = new maplibregl.Marker({ element: button, anchor: 'center' }).setLngLat([a.position.longitude, a.position.latitude]).addTo(m);
        const identity = aircraftIdentity(a), prior = aircraftPositions.current.get(identity), estimating = canEstimateAircraft(snapshot, a);
        const status = button.querySelector<HTMLElement>('.situation-aircraft-position-status')!;
        cancelAnimations.push(animateAircraftEstimate(a, display => {
          marker.setLngLat(display.point);
          aircraftPositions.current.set(identity, { point: display.point, observedAt: a.observedAt });
          const label = aircraftEstimateLabel(display.mode, positionLabel(snapshot, a, Math.max(now, Date.now())));
          if (status.textContent !== label) status.textContent = label;
          button.classList.toggle('is-last-known', label !== 'Live position');
          button.setAttribute('aria-description', display.mode === 'reported' ? label : label + ' from the last reported speed and heading; at most five minutes.');
          button.dataset.positionMode = display.mode;
        }, { enabled: estimating, reducedMotion, prior: prior?.point, clock: () => Math.max(now, Date.now()) }));
        if (aircraftIdentity(a) === focusedAircraft) button.focus({ preventScroll: true });
        const callout = button.querySelector<HTMLElement>('.situation-aircraft-callout')!, point = m.project([a.position.longitude, a.position.latitude]);
        const width = callout.offsetWidth, height = callout.offsetHeight;
        const candidates = [[22, -height / 2], [-width - 22, -height / 2], [-width / 2, 24], [-width / 2, -height - 24]];
        let best = candidates[0], score = Infinity;
        for (const offset of candidates) {
          const box = { left: point.x + offset[0], right: point.x + offset[0] + width, top: point.y + offset[1], bottom: point.y + offset[1] + height };
          const overlap = occupied.reduce((sum, b) => sum + Math.max(0, Math.min(box.right, b.right) - Math.max(box.left, b.left)) * Math.max(0, Math.min(box.bottom, b.bottom) - Math.max(box.top, b.top)), 0);
          const outside = box.left < 0 || box.top < 0 || box.right > m.getCanvas().clientWidth || box.bottom > m.getCanvas().clientHeight;
          const next = overlap + (outside ? 100000 : 0); if (next < score) { best = offset; score = next; }
        }
        callout.style.left = best[0] + 18 + 'px'; callout.style.top = best[1] + 18 + 'px';
        occupied.push({ left: point.x + best[0], right: point.x + best[0] + width, top: point.y + best[1], bottom: point.y + best[1] + height });
        markers.current.push(marker);
      }
    };
    drawLabels(); m.on('moveend', drawLabels); m.on('resize', drawLabels);
    const line = snapshot.traffic && layers.traffic ? snapshot.traffic.geometry : [];
    const trafficData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: line.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }] : [] };
    if (m.getSource('momo-route')) (m.getSource('momo-route') as GeoJSONSource).setData(trafficData);
    else { m.addSource('momo-route', { type: 'geojson', data: trafficData }); m.addLayer({ id: 'momo-route', type: 'line', source: 'momo-route', paint: { 'line-color': '#e8a860', 'line-width': 4, 'line-opacity': 0.9 } }); }
    const incidents: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: snapshot.traffic && layers.roads ? snapshot.traffic.incidents.flatMap(i => i.position ? [{ type: 'Feature' as const, properties: { title: i.description }, geometry: { type: 'Point' as const, coordinates: [i.position.longitude, i.position.latitude] } }] : []) : [] };
    if (m.getSource('momo-incidents')) (m.getSource('momo-incidents') as GeoJSONSource).setData(incidents);
    else { m.addSource('momo-incidents', { type: 'geojson', data: incidents }); m.addLayer({ id: 'momo-incidents', type: 'circle', source: 'momo-incidents', paint: { 'circle-radius': 6, 'circle-color': '#efa264', 'circle-stroke-width': 2, 'circle-stroke-color': '#211a13' } }); }
    const aircraft: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: layers.flights ? mappedAircraft(snapshot, now).filter(a => !a.trackedId).map(a => ({ type: 'Feature' as const, properties: { title: a.callsign ?? a.icao }, geometry: { type: 'Point' as const, coordinates: [a.position.longitude, a.position.latitude] } })) : [] };
    if (m.getSource('momo-aircraft')) (m.getSource('momo-aircraft') as GeoJSONSource).setData(aircraft);
    else { m.addSource('momo-aircraft', { type: 'geojson', data: aircraft, cluster: true, clusterRadius: 45 }); m.addLayer({ id: 'momo-aircraft', type: 'circle', source: 'momo-aircraft', paint: { 'circle-radius': ['case', ['has', 'point_count'], 12, 5], 'circle-color': '#f0e7db', 'circle-stroke-width': 2, 'circle-stroke-color': '#9b6a37' } }); }
    return () => { cancelAnimations.forEach(cancel => cancel()); m.off('moveend', drawLabels); m.off('resize', drawLabels); };
  }, [snapshot, layers, ready, now, selectedFlightId, chooseAircraft, reducedMotion, active]);
  const focus = () => { const m = map.current; if (!m) return; if (place) m.flyTo({ ...situationMapFocus(place), duration: reducedMotion ? 0 : 400 }); else m.flyTo({ center: [10, 25], zoom: 1.5, duration: reducedMotion ? 0 : 400 }); };
  return <section className="situation-map" aria-label="Spatial map">
    <div className="situation-map-canvas" ref={host}/>
    <div className="situation-map-toolbar"><label><MapPin size={17}/><select aria-label="Map location" value={snapshot.selectedLocationId ?? ''} onChange={e => select(e.target.value)}><option value="">Explore the world</option>{snapshot.config.locations.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><button className="icon-button" aria-label={place ? 'Focus selected place' : 'Reset world view'} onClick={focus} disabled={!ready}><LocateFixed size={18}/></button></div>
    <details className="situation-layer-control" open><summary><Layers size={17}/>Map layers</summary><div>{(['places','weather','traffic','flights'] as Layer[]).map(key => <label key={key} title={!enabled[key] ? 'Connect this source in Configure view' : key === 'traffic' ? 'Show your saved route and its traffic estimate' : undefined}><span>{layerNames[key]}{layers[key] && !available[key] && enabled[key] && <small role="status">{busy ? 'Loading…' : snapshot.statuses.find(s => s.source === key)?.state === 'error' ? 'Could not load · use Refresh' : 'No current data · use Refresh'}</small>}</span><input type="checkbox" aria-label={layerNames[key]} disabled={busy || !enabled[key]} checked={enabled[key] && layers[key]} onChange={e => toggle(key, e.target.checked)}/></label>)}<button className="text-button" onClick={settings}>More layers →</button></div></details>
    {!snapshot.config.mapEnabled ? <div className="situation-map-message"><Globe2 size={38}/><h3>Map is off</h3><p>Enable the basemap in Situation View settings.</p><button className="secondary" onClick={settings}>Map settings</button></div> : state === 'loading' ? <div className="situation-map-message" role="status"><Globe2 size={36}/><h3>Opening the map…</h3><p>Loading the public basemap.</p></div> : state === 'error' ? <div className="situation-map-message" role="status"><Globe2 size={36}/><h3>Map unavailable</h3><p>Check your connection and try loading the map again.</p><button className="secondary" onClick={() => setGeneration(v => v + 1)}><RefreshCw size={15}/>Retry map</button></div> : null}
    <div className="situation-map-caption"><Globe2 size={15}/><span>{state === 'partial' ? 'Some map tiles unavailable' : 'World basemap'}<small>{place ? place.label : 'No saved location · pan and zoom to explore'}</small></span>{!place && <button onClick={settings}>Add a place</button>}</div>
  </section>;
}
