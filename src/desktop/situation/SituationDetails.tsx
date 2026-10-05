import { useEffect, useState } from 'react';
import type { NearbyCondition, SituationSnapshot } from '../../shared/situation';
import { weatherCondition, zonedClock } from '../../shared/situation';
import { FlightDetailsContent } from './TrackedFlight';
import type { DesktopBridge } from '../../shared/contracts';

export type SituationDetailKind = 'weather' | 'traffic' | 'zones' | 'flights' | 'conditions';
export interface SituationDetailRequest { kind: SituationDetailKind; snapshot: SituationSnapshot; flightId?: string; aircraftId?: string; openCondition?(condition: NearbyCondition): void; focusAircraft?(icao: string): void; refreshFlight?(id: string): Promise<void>; }
/** A feed item may refer to a different saved place. Read its local snapshot, never Refresh. */
export async function conditionDetailSnapshot(snapshot: SituationSnapshot, condition: NearbyCondition, bridge: DesktopBridge): Promise<SituationSnapshot> {
  if (condition.source !== 'weather' || condition.sourceId === snapshot.selectedLocationId) return snapshot;
  const empty = { ...snapshot, selectedLocationId: condition.sourceId, weather: null, traffic: null };
  try {
    const result = await bridge.situationCommand?.({ action: 'snapshot', locationId: condition.sourceId });
    return result?.ok ? { ...result.value, traffic: null } : empty;
  } catch { return empty; }
}
export function reconcileSituationDetail(current: SituationDetailRequest, next: SituationSnapshot): SituationDetailRequest | null {
  const old = current.snapshot;
  if (current.kind === 'flights' && current.flightId && !next.config.trackedFlights.some(f => f.id === current.flightId)) return null;
  if (current.kind === 'traffic' && old.selectedRouteId && !next.config.routes.some(r => r.id === old.selectedRouteId)) return null;
  if (current.kind === 'weather' && old.selectedLocationId && !next.config.locations.some(p => p.id === old.selectedLocationId)) return null;
  const weather = current.kind === 'weather' && old.selectedLocationId !== next.selectedLocationId
    ? { selectedLocationId: old.selectedLocationId, weather: next.config.weatherEnabled && next.config.locations.some(p => p.id === old.selectedLocationId && p.revision === old.weather?.locationRevision) ? old.weather : null } : {};
  return { ...current, snapshot: { ...next, ...weather, traffic: current.kind === 'traffic' || current.kind === 'conditions' ? next.traffic : null } };
}
const titles: Record<SituationDetailKind, string> = { weather: 'Weather details', traffic: 'Route details', zones: 'World clocks', flights: 'Flight details', conditions: 'Recent conditions' };
/** A retained source snapshot, never a refresh. Expanded content belongs in the scrollable workpane. */
export function SituationDetails({ request, configure, bridge }: { request: SituationDetailRequest; configure(): void; bridge: DesktopBridge }) {
  const [now, setNow] = useState(Date.now());
  const [response, setResponse] = useState<SituationSnapshot>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setResponse(undefined); setError(''); }, [request]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const { kind } = request, snapshot = response ?? request.snapshot, weather = snapshot.weather;
  async function lookup(flightId: string) {
    setBusy(true); setError('');
    try { if (request.refreshFlight) { await request.refreshFlight(flightId); return; } const result = await bridge.situationCommand?.({ action: 'refresh', source: 'flights', flightId }); if (result?.ok) setResponse(result.value); else setError(result?.error.message ?? 'Aircraft service is unavailable. Restart the app.'); }
    catch { setError('Aircraft could not be refreshed. Try again.'); } finally { setBusy(false); }
  }
  const traffic = snapshot.traffic && Date.parse(snapshot.traffic.freshness.freshUntil) > now ? snapshot.traffic : null;
  return <div className="situation-details"><header><h2>{titles[kind]}</h2><p>More from your selected source.</p></header>{error && <p role="alert">{error}</p>}
    {kind === 'weather' && (weather ? <>
      <h3>{snapshot.config.locations.find(p => p.id === weather.locationId)?.label}</h3><p>{weatherCondition(weather.code)} · {weather.temperatureC ?? '—'}°C</p>
      <dl><dt>Feels like</dt><dd>{weather.apparentC ?? '—'}°C</dd><dt>Humidity</dt><dd>{weather.humidityPercent ?? '—'}%</dd><dt>Precipitation</dt><dd>{weather.precipitationMm ?? '—'} mm</dd><dt>Wind</dt><dd>{weather.windKph ?? '—'} km/h</dd><dt>Source time</dt><dd>{weather.freshness.observedAt ? new Date(weather.freshness.observedAt).toLocaleString() : 'Not supplied'}</dd><dt>Fetched</dt><dd>{new Date(weather.freshness.fetchedAt).toLocaleString()}</dd><dt>Fresh until</dt><dd>{new Date(weather.freshness.freshUntil).toLocaleString()}</dd></dl>
      <h3>Five-day forecast</h3>{weather.forecast.map(day => <section key={day.date}><h4>{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day.date + 'T12:00:00Z'))}</h4><p>{weatherCondition(day.code)} · High {day.highC ?? '—'}° / Low {day.lowC ?? '—'}°</p><p>Rain chance {day.precipitationProbability ?? '—'}% · UV maximum {day.uvIndex ?? '—'}</p></section>)}
      {weather.partial && <p>Some measurements were not supplied.</p>}<p className="situation-detail-attribution"><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · normalized by MoMo</p>
    </> : <p>No weather loaded for this selection.</p>)}
    {kind === 'traffic' && (traffic ? <><h3>{snapshot.config.routes.find(r => r.id === traffic.routeId)?.label}</h3><dl><dt>Journey</dt><dd>{Math.round(traffic.durationSeconds / 60)} min</dd><dt>Distance</dt><dd>{(traffic.distanceMeters / 1000).toFixed(1)} km</dd><dt>Free flow</dt><dd>{traffic.freeFlowSeconds === null ? 'Unknown' : Math.round(traffic.freeFlowSeconds / 60) + ' min'}</dd><dt>Typical traffic</dt><dd>{traffic.typicalSeconds === null ? 'Unknown' : Math.round(traffic.typicalSeconds / 60) + ' min'}</dd><dt>Delay</dt><dd>{traffic.delaySeconds === null ? 'Unknown' : Math.round(traffic.delaySeconds / 60) + ' min'}</dd></dl>{traffic.incidents.map(i => <section key={i.id}><p>{i.description}</p></section>)}<p>{traffic.freshness.attribution}</p></> : <p>No current route response. Close this pane and refresh your configured route when needed.</p>)}
    {kind === 'zones' && snapshot.config.timezones.map(zone => { const clock = zonedClock(zone.timezone, now); return <section key={zone.id}><h3>{zone.label}</h3><p className="situation-detail-clock">{clock.time}</p><p>{clock.date} · {clock.offset}</p><small>{zone.timezone}</small></section>; })}
    {kind === 'flights' && <><FlightDetailsContent snapshot={snapshot} flightId={request.flightId} aircraftId={request.aircraftId} now={now} focus={request.focusAircraft}/>{snapshot.config.trackedFlights.map(flight => <section key={flight.id}><button className="text-button" disabled={busy || !snapshot.config.flightsEnabled || snapshot.reviewBlocked} onClick={() => void lookup(flight.id)}>{busy ? 'Refreshing…' : 'Refresh ' + flight.label}</button></section>)}<button className="text-button" onClick={configure}>Manage tracked flights</button></>}
    {kind === 'conditions' && (snapshot.conditions.some(condition => Date.parse(condition.expiresAt) > now) ? snapshot.conditions.filter(condition => Date.parse(condition.expiresAt) > now).map(condition => <section key={condition.id}><h3>{condition.title}</h3><p>{condition.detail}</p><small>{new Date(condition.observedAt).toLocaleString()} · {condition.source}</small>{request.openCondition && <button className="text-button" onClick={() => request.openCondition?.(condition)}>Open {condition.source === 'flights' ? 'flight' : condition.source === 'traffic' ? 'route' : 'weather'} details</button>}</section>) : <p>No qualifying source-backed changes yet.</p>)}
  </div>;
}
