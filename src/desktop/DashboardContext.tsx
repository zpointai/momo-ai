import { useEffect, useState } from 'react';
import { Cloud, CloudRain, CloudSun, Sun } from 'lucide-react';
import type { DesktopBridge } from '../shared/contracts';
import { freshnessState, weatherCondition, zonedClock, type SituationSnapshot } from '../shared/situation';

export type DashboardSituationSelection = { locationId?: string | null; routeId?: string | null };
export type DashboardSituationOpen = (kind: 'weather' | 'traffic', snapshot: SituationSnapshot) => void;

/** Local snapshot reads only. Restricted route responses keep their existing view lifetime. */
export function useDashboardSituation(bridge: DesktopBridge, active: boolean, selection?: DashboardSituationSelection) {
  const [snapshot, setSnapshot] = useState<SituationSnapshot>();
  const locationId = selection?.locationId, routeId = selection?.routeId;
  useEffect(() => {
    if (!active) return;
    let current = true, reading = false;
    setSnapshot(undefined);
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await bridge.situationCommand?.({ action: 'snapshot', ...(locationId !== undefined ? { locationId } : {}), ...(routeId !== undefined ? { routeId } : {}) });
        if (current) setSnapshot(result?.ok ? result.value : undefined);
      } catch { if (current) setSnapshot(undefined); }
      finally { reading = false; }
    };
    void read();
    const changed = () => { void read(); };
    const timer = setInterval(changed, 60000);
    window.addEventListener('momo:situation-changed', changed);
    return () => { current = false; clearInterval(timer); window.removeEventListener('momo:situation-changed', changed); };
  }, [bridge, active, locationId, routeId]);
  return active ? snapshot : undefined;
}

export function DashboardContext({ timezone, snapshot, open }: { timezone: string; snapshot?: SituationSnapshot; open: DashboardSituationOpen }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now()), timer = setInterval(tick, 10000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const clock = zonedClock(timezone, now);
  const place = snapshot?.config.locations.find(p => p.id === snapshot.selectedLocationId);
  const weather = snapshot?.config.weatherEnabled && snapshot.weather?.locationId === place?.id && snapshot.weather?.locationRevision === place?.revision ? snapshot.weather : null;
  const weatherStale = weather && (freshnessState(weather.freshness, now) === 'stale' || snapshot?.statuses.some(s => s.source === 'weather' && ['stale', 'error'].includes(s.state)));
  const WeatherIcon = weather?.code === 0 ? Sun : weather?.code === 3 ? Cloud : weather?.code != null && weather.code >= 51 ? CloudRain : CloudSun;
  const age = weather ? Math.max(0, Math.floor((now - Date.parse(weather.freshness.fetchedAt)) / 60000)) : 0;
  return <div className="dashboard-context" aria-label="Local time and Situation context">
    <div className="dashboard-clock"><time dateTime={new Date(now).toISOString()}>{clock.time}</time><small>{timezone.replaceAll('_', ' ')}</small></div>
    {weather && weather.temperatureC !== null && snapshot && <button className="dashboard-weather dashboard-signal" onClick={() => open('weather', snapshot)} aria-label="Open Weather in Situation View">
      <WeatherIcon size={30} strokeWidth={1.5}/><span><strong>{Math.round(weather.temperatureC)}°C <span>{weatherCondition(weather.code)}</span></strong><small>{place?.label}</small><small>{weatherStale ? 'Stale · ' : ''}Fetched {age ? `${age} min ago` : 'just now'} · Open-Meteo</small></span>
    </button>}
  </div>;
}
