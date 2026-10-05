import type { BriefingEntry, BriefingSnapshot } from '../../src/shared/daily-intelligence';
import { freshnessState, weatherCondition, type SituationSnapshot } from '../../src/shared/situation';
import type { ResourceRef } from '../../src/shared/modules';
import { situationHash } from './providers';

/** Native, bounded cache projection. Never fetches, infers travel, or copies coordinates/geometry. */
export function situationEvidence(snapshot: SituationSnapshot | undefined, accountId: string | null, now: number): { entries: BriefingEntry[]; connectors: BriefingSnapshot['connectors'] } {
  const entries: BriefingEntry[] = [], connectors: BriefingSnapshot['connectors'] = { weather: 'not-configured', traffic: 'not-configured' };
  if (!snapshot?.config.includeInBriefing) return { entries, connectors };
  const { config, weather, traffic } = snapshot;
  for (const source of ['weather', 'traffic'] as const) connectors[source] = snapshot.statuses.find(s => s.source === source)!.state;
  const add = (id: string, type: ResourceRef['type'], title: string, summary: string, revision: string, fetchedAt: string, expiresAt: string, category?: string, attention = false) => {
    const detail = JSON.stringify({ summary, ...(category ? { category, attention } : {}) });
    entries.push({ id: 'situation:' + situationHash([type, id]).slice(0, 24), kind: 'situation', section: attention ? 'attention' : 'today', title: title.slice(0, 240), detail, freshness: 'retained', sensitivity: 'private', sharing: config.shareWithAI ? 'workflow-permitted' : 'local-only', estimatedTokens: Math.ceil((title.length + detail.length) / 4),
      ref: { module: 'situation', connector: 'situation', type, id, accountId, profile: 'local', revision: situationHash([config.revision, revision]), label: title.slice(0, 240), provenance: { kind: 'connector', runId: null, fetchedAt }, access: 'read', retention: { kind: 'transient', expiresAt } } });
  };
  if (weather && ['available', 'partial'].includes(connectors.weather) && freshnessState(weather.freshness, now) === 'current') {
    const label = config.locations.find(p => p.id === weather.locationId)!.label;
    add(weather.locationId, 'weather', 'Weather · ' + label, `${weather.temperatureC === null ? 'Temperature unknown' : weather.temperatureC + '°C'}; ${weatherCondition(weather.code)}. Daily precipitation probability: ${weather.forecast[0]?.precipitationProbability ?? 'unknown'}%. Source: ${weather.freshness.attribution}. This is a cached report, not a travel commitment.`, weather.freshness.revision, weather.freshness.fetchedAt, weather.freshness.freshUntil);
  }
  if (traffic && !traffic.displayOnly && ['available', 'partial'].includes(connectors.traffic) && freshnessState(traffic.freshness, now) === 'current') {
    const label = config.routes.find(r => r.id === traffic.routeId)!.label;
    add(traffic.routeId, 'traffic', 'Commute · ' + label, `Current route estimate ${Math.round(traffic.durationSeconds / 60)} min; delay ${traffic.delaySeconds === null ? 'unknown' : Math.round(traffic.delaySeconds / 60) + ' min'}. Distance ${(traffic.distanceMeters / 1000).toFixed(1)} km. Source: ${traffic.freshness.attribution}. No journey or departure is assumed.`, traffic.freshness.revision, traffic.freshness.fetchedAt, traffic.freshness.freshUntil);
  }
  for (const c of snapshot.conditions.filter(c => !c.displayOnly && Date.parse(c.expiresAt) > now && !(traffic?.displayOnly && c.source === 'traffic')).slice(0, 4)) {
    add(c.sourceId, c.source === 'weather' ? 'weather' : c.source === 'traffic' ? 'traffic' : 'aircraft', c.title, c.detail, c.sourceRevision, c.observedAt, c.expiresAt, c.category, c.attention);
  }
  // Distinct conditions share a source but must have distinct context identities.
  for (const entry of entries) if (JSON.parse(entry.detail).category) { entry.ref.id += ':' + situationHash([entry.title, JSON.parse(entry.detail).category]).slice(0, 16); entry.id += ':' + situationHash(entry.title).slice(0, 12); }
  return { entries: entries.slice(0, 6), connectors };
}
