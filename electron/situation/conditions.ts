import { conditionAlive, conditionEvent, flightChange, flightPhase, weatherChange } from '../../src/shared/situationChanges';
import { freshnessState, type NearbyCondition, type TrackedFlight } from '../../src/shared/situation';
import type { FlightAwareResult } from '../../src/shared/flightAware';
import type { SituationRecord } from './store';
import { situationHash } from './providers';

/** Durable producer: Weather only. Commercial and response-only facts never enter this record. */
export function deriveSituationConditions(previous: SituationRecord, next: SituationRecord, now: number): NearbyCondition[] {
  let conditions = previous.conditions.filter(c => c.source === 'weather' && conditionAlive(c, now) && next.config.weatherEnabled && next.config.locations.some(p => p.id === c.sourceId));
  for (const weather of next.weather) {
    if (freshnessState(weather.freshness, now) !== 'current') continue;
    const old = previous.weather.find(w => w.locationId === weather.locationId && w.locationRevision === weather.locationRevision);
    const change = weatherChange(old, weather, next.config.locations.find(p => p.id === weather.locationId)?.label ?? 'your place');
    if (change) {
      conditions = conditions.filter(c => c.sourceId !== weather.locationId || c.category !== 'weather-change');
      conditions.push(conditionEvent('weather', weather.locationId, weather.freshness.revision, weather.freshness.freshUntil, change, now));
    } else conditions = conditions.map(c => c.sourceId === weather.locationId && c.category === 'weather-change' ? { ...c, sourceRevision: weather.freshness.revision } : c);
  }
  for (const status of next.statuses.filter(s => s.source === 'weather')) {
    const place = next.config.locations.find(p => p.revision === status.selectionRevision); if (!place) continue;
    if (status.state === 'available') { conditions = conditions.filter(c => c.sourceId !== place.id || c.category !== 'situation-source-unavailable'); continue; }
    const hadBaseline = previous.weather.some(w => w.locationId === place.id && w.locationRevision === place.revision);
    if (!hadBaseline || status.state !== 'error' || !['network', 'authentication', 'response'].includes(status.lastError ?? '') || previous.statuses.some(s => s.source === status.source && s.selectionRevision === status.selectionRevision && s.state === status.state && s.lastError === status.lastError)) continue;
    conditions = conditions.filter(c => c.sourceId !== place.id || c.category !== 'situation-source-unavailable');
    conditions.push(conditionEvent('weather', place.id, place.revision, new Date(now + 1800000).toISOString(), { category: 'situation-source-unavailable', title: `Weather unavailable for ${place.label}`.slice(0, 120), detail: status.detail, attention: false }, now));
  }
  return conditions.sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 24);
}

type Baseline = { trackingRevision: string; flight: FlightAwareResult['flights'][number]; at: number; failures: number };
/** One bounded baseline per tracked flight, held in memory only. A restart deliberately starts fresh. */
export class FlightChangeFeed {
  private baselines = new Map<string, Baseline>();
  private conditions: NearbyCondition[] = [];
  reset() { this.baselines.clear(); this.conditions = []; }
  prune(tracked: TrackedFlight[], enabled: boolean, now: number) {
    for (const [id, base] of this.baselines) if (!enabled || !tracked.some(f => f.id === id && situationHash(f) === base.trackingRevision) || now - base.at > 86400000) this.baselines.delete(id);
    this.conditions = this.conditions.filter(c => this.baselines.has(c.sourceId) && conditionAlive(c, now));
    return this.conditions;
  }
  accept(tracking: TrackedFlight, result: FlightAwareResult, now: number) {
    const flight = !result.moreResults && result.flights.length === 1 ? result.flights[0] : null;
    if (!flight) { this.unavailable(tracking, now); return; }
    const base = this.baselines.get(tracking.id), same = base && base.trackingRevision === situationHash(tracking) && base.flight.id === flight.id && now - base.at <= 86400000;
    this.conditions = this.conditions.filter(c => conditionAlive(c, now) && (c.sourceId !== tracking.id || same && c.category !== 'situation-source-unavailable'));
    const change = same ? flightChange(base.flight, flight, tracking.label) : null;
    if (change) {
      this.conditions = this.conditions.filter(c => c.sourceId !== tracking.id || c.category !== change.category);
      this.conditions.push(conditionEvent('flights', tracking.id, situationHash([flight.id, flightPhase(flight), flight.status]), new Date(now + 900000).toISOString(), change, now));
    }
    this.baselines.set(tracking.id, { trackingRevision: situationHash(tracking), flight, at: now, failures: 0 });
  }
  unavailable(tracking: TrackedFlight, now: number) {
    const base = this.baselines.get(tracking.id);
    if (!base || base.trackingRevision !== situationHash(tracking) || now - base.at > 86400000 || ['arrived at gate', 'cancelled'].includes(flightPhase(base.flight) ?? '')) return;
    base.failures++;
    if (base.failures !== 2) return;
    this.conditions = this.conditions.filter(c => c.sourceId !== tracking.id);
    this.conditions.push(conditionEvent('flights', tracking.id, situationHash([tracking.id, 'unavailable']), new Date(now + 900000).toISOString(), { category: 'situation-source-unavailable', title: `${tracking.label}: status unavailable`.slice(0, 120), detail: 'Two checks could not return a usable FlightAware status after an earlier successful check. This does not mean the flight was cancelled.', attention: false }, now));
  }
}
