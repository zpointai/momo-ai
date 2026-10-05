import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { SituationSnapshot } from '../../shared/situation';
import { conditionAlive, conditionEvent, trafficChanges } from '../../shared/situationChanges';
type Selection = { locationId?: string | null; routeId?: string | null };
export const situationChanged = (selection?: Selection) => window.dispatchEvent(new CustomEvent('momo:situation-changed', { detail: selection }));
/** Keep display-only traffic in this mounted view until its original expiry, never in storage. */
export function retainCurrentTraffic(previous: SituationSnapshot | undefined, next: SituationSnapshot, now = Date.now()): SituationSnapshot {
  const traffic = previous?.traffic, status = next.statuses.find(s => s.source === 'traffic');
  if (!previous || next.traffic || !traffic?.displayOnly || next.reviewBlocked || !next.config.trafficEnabled || next.trafficCredential !== 'configured'
    || next.selectedRouteId !== traffic.routeId
    || !next.config.routes.some(r => r.id === traffic.routeId && r.revision === traffic.routeRevision)
    || Date.parse(traffic.freshness.freshUntil) <= now || status?.state !== 'empty') return next;
  return { ...next, traffic, statuses: next.statuses.map(s => s.source === 'traffic' ? { ...s, state: traffic.partial ? 'partial' : 'available', detail: 'Current route response. Refresh for a new estimate.' } : s) };
}
export function projectTrafficConditions(previous: SituationSnapshot | undefined, next: SituationSnapshot, now = Date.now()): SituationSnapshot {
  const native = next.conditions.filter(condition => !condition.displayOnly);
  const traffic = next.traffic;
  if (!traffic?.displayOnly || !next.config.trafficEnabled || next.reviewBlocked || Date.parse(traffic.freshness.freshUntil) <= now) return { ...next, conditions: native };
  let retained = (previous?.traffic?.routeRevision === traffic.routeRevision ? previous.conditions : []).filter(condition => condition.displayOnly && condition.sourceId === traffic.routeId && conditionAlive(condition, now));
  const changes = trafficChanges(previous?.traffic, traffic, next.config.routes.find(route => route.id === traffic.routeId)?.label ?? 'Your route', now);
  for (const change of changes) {
    retained = retained.filter(condition => condition.category !== change.category);
    retained.push(conditionEvent('traffic', traffic.routeId, traffic.freshness.revision, traffic.freshness.freshUntil, change, now, true));
  }
  return { ...next, conditions: [...native, ...retained].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 24) };
}
export function useSituation(bridge: DesktopBridge, active: boolean) {
  const [snapshot, setSnapshot] = useState<SituationSnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState<'weather' | 'traffic' | 'flights' | null>(null);
  const sequence = useRef(0), loading = useRef(false), selection = useRef<{ locationId?: string | null; routeId?: string | null }>({});
  async function load(source?: 'weather' | 'traffic' | 'flights', change?: { locationId?: string | null; routeId?: string | null }, flightId?: string) {
    if (source && loading.current) return;
    if (change) selection.current = { ...selection.current, ...change };
    const token = ++sequence.current; loading.current = true; setBusy(true); setRefreshing(source ?? null); setError('');
    try {
      const result = await bridge.situationCommand?.({ ...(source ? { action: 'refresh' as const, source, ...(flightId ? { flightId } : {}) } : { action: 'snapshot' as const }), ...selection.current });
      if (token !== sequence.current) return;
      if (result?.ok) {
        // Retire deleted selections; do not silently infer another saved place or route.
        if (selection.current.locationId && !result.value.config.locations.some(p => p.id === selection.current.locationId)) selection.current.locationId = null;
        if (selection.current.routeId && !result.value.config.routes.some(r => r.id === selection.current.routeId)) selection.current.routeId = null;
        setSnapshot(previous => projectTrafficConditions(previous, retainCurrentTraffic(previous, result.value)));
      } else setError(result?.error.message ?? 'Situation View service is unavailable. Restart the desktop app.');
    } catch { if (token === sequence.current) setError('Situation View could not reach its local service. Try again.'); }
    finally { if (token === sequence.current) { loading.current = false; setBusy(false); setRefreshing(null); } }
  }
  useEffect(() => { if (!active) return; void load(); const timer = setInterval(() => { if (!document.hidden && !loading.current) void load(); }, 60000); const changed = (event: Event) => { void load(undefined, (event as CustomEvent<Selection | undefined>).detail); }; window.addEventListener('momo:situation-changed', changed); return () => { clearInterval(timer); window.removeEventListener('momo:situation-changed', changed); sequence.current++; }; }, [active, bridge]);
  useEffect(() => {
    if (!snapshot?.traffic?.displayOnly) return;
    if (!active) { setSnapshot(v => v ? { ...v, traffic: null, conditions: v.conditions.filter(c => !c.displayOnly) } : v); return; }
    const timer = setTimeout(() => setSnapshot(v => v?.traffic ? { ...v, traffic: null, conditions: v.conditions.filter(c => !c.displayOnly), statuses: v.statuses.map(s => s.source === 'traffic' ? { ...s, state: 'empty', detail: 'Estimate expired. Refresh for a new route estimate.' } : s) } : v), Math.max(0, Date.parse(snapshot.traffic.freshness.freshUntil) - Date.now()));
    return () => clearTimeout(timer);
  }, [active, snapshot?.traffic]);
  return { snapshot, setSnapshot, error, busy, refreshing, load };
}
