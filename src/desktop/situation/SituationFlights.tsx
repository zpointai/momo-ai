import { ArrowRight, Plane, RefreshCw } from 'lucide-react';
import type { SituationSnapshot } from '../../shared/situation';
import { commercialFlightNumber } from '../../shared/flightAware';
import { TrackedFlightSummary, FlightAttribution } from './TrackedFlight';

export function SituationFlights({ snapshot, busy, refreshing = false, now, refresh, configure, details, selectedFlightId, selectFlight, focus }: { snapshot: SituationSnapshot; busy: boolean; refreshing?: boolean; now: number; refresh(flightId?: string): void; configure(): void; details?(flightId?: string): void; selectedFlightId?: string; selectFlight?(id: string): void; focus?(icao: string): void }) {
  const enabled = snapshot.config.flightsEnabled, tracked = snapshot.config.trackedFlights;
  const blocked = busy || snapshot.reviewBlocked || !enabled;
  const flight = tracked.find(f => f.id === selectedFlightId) ?? tracked[0];
  if (enabled && flight) return <section className="situation-card situation-flights has-tracked-flight">
    <header><h2><Plane size={21}/>Flights</h2><button className="text-button" disabled={blocked || !commercialFlightNumber(flight) || snapshot.flightAware?.credential !== 'configured'} onClick={() => refresh(flight.id)}><RefreshCw size={14}/>{refreshing ? 'Refreshing…' : 'Refresh'}</button></header>
    {tracked.length > 1 && <select aria-label="Tracked flight" value={flight.id} onChange={e => selectFlight?.(e.target.value)}>{tracked.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select>}
    <TrackedFlightSummary snapshot={snapshot} flight={flight} now={now} selected={!!selectedFlightId} focus={focus} details={() => details?.(flight.id)}/>
    <FlightAttribution/>
  </section>;
  return <section className="situation-card situation-flights is-empty">
    <header><h2><Plane size={21}/>Flights</h2></header>
    <div className="situation-quiet-state"><h3>{enabled ? 'Track a flight' : 'Flight tracking is off'}</h3><p>FlightAware provides status and position when available. Refresh manually when you need an update.</p><button className="text-button" onClick={configure}>{enabled ? 'Track flight' : 'Configure flight tracking'}<ArrowRight size={14}/></button></div>
    <FlightAttribution/>
  </section>;
}
