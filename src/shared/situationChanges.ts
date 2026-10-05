import type { NearbyCondition, TrafficSnapshot, WeatherSnapshot } from './situation';
import { weatherCondition } from './situation';
import type { FlightAwareResult } from './flightAware';

export type ConditionChange = Pick<NearbyCondition, 'category' | 'title' | 'detail' | 'attention'>;
type Flight = FlightAwareResult['flights'][number];
export const conditionAlive = (condition: NearbyCondition, now: number) => Date.parse(condition.expiresAt) > now;
export function conditionEvent(source: NearbyCondition['source'], sourceId: string, sourceRevision: string, expiresAt: string, change: ConditionChange, now: number, displayOnly = false): NearbyCondition {
  return { id: crypto.randomUUID(), source, sourceId, sourceRevision, observedAt: new Date(now).toISOString(), expiresAt, ...change, ...(displayOnly ? { displayOnly: true } : {}) };
}
const weatherFamily = (code: number | null) => code === null ? null : code >= 95 ? 'thunderstorm' : code >= 85 || code >= 71 && code <= 77 ? 'snow' : code >= 80 || code >= 61 && code <= 67 ? 'rain' : code >= 51 ? 'drizzle' : code >= 45 ? 'fog' : 'dry';
/** First accepted observation is a baseline. Compare only the same location revision within one day. */
export function weatherChange(old: WeatherSnapshot | undefined, next: WeatherSnapshot, label: string): ConditionChange | null {
  if (!old || old.locationRevision !== next.locationRevision || Date.parse(next.freshness.fetchedAt) - Date.parse(old.freshness.fetchedAt) > 86400000 || next.freshness.revision === old.freshness.revision) return null;
  const previous = weatherFamily(old.code), current = weatherFamily(next.code);
  let title = '', detail = '';
  if (previous && current && current !== previous && ['rain', 'drizzle', 'snow', 'thunderstorm'].includes(current)) {
    title = `${weatherCondition(next.code)} reported near ${label}`;
    detail = `Previously ${weatherCondition(old.code).toLowerCase()}.`;
  } else if (old.precipitationMm !== null && next.precipitationMm !== null && old.precipitationMm < 0.1 && next.precipitationMm >= 1) {
    title = `Precipitation increased near ${label}`; detail = `${next.precipitationMm} mm reported, previously ${old.precipitationMm} mm.`;
  } else if (old.forecast[0]?.date === next.forecast[0]?.date && old.forecast[0]?.precipitationProbability != null && next.forecast[0]?.precipitationProbability != null && old.forecast[0].precipitationProbability < 70 && next.forecast[0].precipitationProbability >= 70) {
    title = `Rain more likely near ${label}`; detail = `${next.forecast[0].precipitationProbability}% daily chance, previously ${old.forecast[0].precipitationProbability}%. Rain arrival time is unknown.`;
  } else if (old.temperatureC !== null && next.temperatureC !== null && Math.abs(next.temperatureC - old.temperatureC) >= 5) {
    title = `Temperature changed near ${label}`; detail = `${next.temperatureC}°C, previously ${old.temperatureC}°C.`;
  }
  return title ? { category: 'weather-change', title: title.slice(0, 120), detail, attention: true } : null;
}

/** Response-only Traffic comparisons belong to the mounted Situation view, never native storage/evidence. */
export function trafficChanges(old: TrafficSnapshot | null | undefined, next: TrafficSnapshot, label: string, now: number): ConditionChange[] {
  if (!old || old.routeId !== next.routeId || old.routeRevision !== next.routeRevision || Date.parse(old.freshness.freshUntil) <= now || next.freshness.revision === old.freshness.revision) return [];
  const found: ConditionChange[] = [], delta = next.durationSeconds - old.durationSeconds;
  if (Math.abs(delta) >= 600) found.push({ category: 'commute-delay', title: `${label} is ${Math.round(Math.abs(delta) / 60)} min ${delta > 0 ? 'slower' : 'faster'}`.slice(0, 120), detail: `Now ${Math.round(next.durationSeconds / 60)} min; previous estimate ${Math.round(old.durationSeconds / 60)} min.`, attention: delta > 0 });
  const incidentKey = (incident: TrafficSnapshot['incidents'][number]) => JSON.stringify([incident.kind, incident.description, incident.position]);
  const previous = new Set(old.incidents.map(incidentKey)), current = new Set(next.incidents.map(incidentKey));
  const added = next.incidents.filter(i => !previous.has(incidentKey(i))), cleared = old.incidents.filter(i => !current.has(incidentKey(i)));
  if (added.length || cleared.length && !next.partial) found.push({ category: 'traffic-incident', title: `${label}: ${added.length ? 'new route incident' : 'route incident cleared'}`.slice(0, 120), detail: (added.length ? added : cleared).slice(0, 2).map(i => i.description).join(' · ').slice(0, 400), attention: !!added.length });
  return found;
}

/** Actual OOOI times and explicit flags outrank prose; never infer an airborne state from an ETA. */
export function flightPhase(flight: Flight): string | null {
  if (flight.cancelled) return 'cancelled';
  if (flight.diverted) return 'diverted';
  if (flight.actualIn) return 'arrived at gate';
  if (flight.actualOn) return 'landed';
  if (flight.actualOff) return 'airborne';
  if (flight.actualOut) return 'taxiing / left gate';
  const status = flight.status?.trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'diverted') return 'diverted';
  if (status === 'scheduled') return 'scheduled';
  return null;
}
export function flightChange(old: Flight, next: Flight, label: string): ConditionChange | null {
  if (old.id !== next.id) return null;
  const before = flightPhase(old), after = flightPhase(next);
  if (before && after && before !== after) return { category: 'flight-change', title: `${label} is now ${after}`.slice(0, 120), detail: `FlightAware: previously ${before}.`, attention: true };
  for (const [field, name] of [['estimatedOut', 'estimated departure'], ['estimatedIn', 'estimated arrival']] as const) {
    if (field === 'estimatedOut' && next.actualOut || field === 'estimatedIn' && next.actualIn) continue;
    const a = old[field], b = next[field];
    if (a && b && Math.abs(Date.parse(b) - Date.parse(a)) >= 600000) return { category: 'flight-change', title: `${label}: ${name} changed`.slice(0, 120), detail: `FlightAware moved the ${name} ${Math.round(Math.abs(Date.parse(b) - Date.parse(a)) / 60000)} min ${b > a ? 'later' : 'earlier'}. Open flight details for airport local times.`, attention: b > a };
  }
  for (const [field, name] of [['departureDelaySeconds', 'departure delay'], ['arrivalDelaySeconds', 'arrival delay']] as const) {
    const a = old[field], b = next[field];
    if (a != null && b != null && Math.abs(b - a) >= 600) return { category: 'flight-change', title: `${label}: ${name} changed`.slice(0, 120), detail: `FlightAware reports ${Math.round(b / 60)} min, previously ${Math.round(a / 60)} min.`, attention: b > a };
  }
  for (const [field, name] of [['gateOrigin', 'departure gate'], ['terminalOrigin', 'departure terminal'], ['gateDestination', 'arrival gate'], ['terminalDestination', 'arrival terminal']] as const) {
    if ((field === 'gateOrigin' || field === 'terminalOrigin') && next.actualOut || next.actualIn) continue;
    if (old[field] && next[field] && old[field] !== next[field]) return { category: 'flight-change', title: `${label}: ${name} changed`.slice(0, 120), detail: `FlightAware: ${old[field]} → ${next[field]}.`, attention: true };
  }
  return null;
}
