import { ArrowRight, LocateFixed } from 'lucide-react';
import type { AircraftPosition, SituationSnapshot, TrackedFlight as Tracking } from '../../shared/situation';
import { aircraftIdentity, aircraftMetrics, flightTrackingView, mappedAircraft, positionLabel, lastSeen, type FlightScheduleStatus } from '../../shared/flightTracking';
import { airportTime, commercialFlightNumber } from '../../shared/flightAware';
import { CarrierBadge } from './CarrierBadge';

export function AircraftMetrics({ aircraft }: { aircraft: AircraftPosition }) {
  return <dl className="situation-flight-metrics">{aircraftMetrics(aircraft).filter(m => m.value !== null).map(m => <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>)}</dl>;
}
export function FlightAttribution() {
  return <small className="situation-flight-attribution"><a href="https://www.flightaware.com/" target="_blank" rel="noreferrer">FlightAware</a> · refresh on demand</small>;
}
const scheduleMessage = (s: FlightScheduleStatus) => s.state === 'unsupported' ? 'Stop tracking this entry and add an IATA or ICAO flight number, such as KL897 or AHY071.' : s.state === 'error' ? s.detail : s.state === 'empty' ? 'No matching flight returned for this departure date.' : s.state === 'ambiguous' ? 'Multiple flight records returned; no flight instance selected.' : s.state === 'not-checked' ? 'FlightAware connected · refresh for status and position.' : 'Connect FlightAware in Settings for flight status.';
function PositionNote({ snapshot, flight, now }: { snapshot: SituationSnapshot; flight: Tracking; now: number }) {
  const view = flightTrackingView(snapshot, flight, now), a = view.position, fa = view.scheduleStatus.state === 'connected';
  const text = a ? positionLabel(snapshot, a, now) + ' · ' + lastSeen(a, now) : fa ? snapshot.flightAware?.positionError ?? (snapshot.flightAware?.position ? 'Position not supplied by FlightAware' : 'Position not checked yet · use Refresh') : 'Not currently observed';
  return <p className={'situation-flight-status' + (view.livePosition ? ' is-live' : '')}><span aria-hidden="true"/>{text}</p>;
}
export function TrackedFlightSummary({ snapshot, flight, now, selected, focus, details }: { snapshot: SituationSnapshot; flight: Tracking; now: number; selected: boolean; focus?(id: string): void; details?(): void }) {
  const view = flightTrackingView(snapshot, flight, now), a = view.position, schedule = view.scheduleStatus, f = schedule.state === 'connected' ? schedule.flight : null;
  const carrier = f?.carrier, brand = carrier?.icao ? snapshot.carrierBranding?.brands.find(value => value.carrier.icao === carrier.icao && value.carrier.iata === carrier.iata && value.carrier.domain === carrier.domain) : undefined;
  const code = carrier?.iata ?? carrier?.icao ?? commercialFlightNumber(flight)?.match(/^([A-Z0-9]{2})\d/)?.[1];
  return <div className={'situation-flight-summary' + (selected ? ' is-selected' : '')} data-flight-id={flight.id}>
    <div className="situation-flight-identity"><div className="situation-flight-carrier"><CarrierBadge brand={brand} code={code}/><div><h3>{flight.label}</h3><p>{[view.airline, schedule.state === 'connected' ? schedule.departureDate : null].filter(Boolean).join(' · ')}</p></div></div>{f && <span className="situation-flight-reported-status">{schedule.state === 'connected' && schedule.stale ? 'Stale · ' : ''}{f.status ?? 'Status unavailable'}</span>}</div>
    {f ? <div className="situation-flight-journey">
      <div><strong title={f.origin ?? undefined}>{f.originCode ?? f.origin ?? 'Origin unavailable'}</strong><span>{f.actualOut ? 'Departed gate' : f.estimatedOut ? 'Est. departure' : 'Scheduled departure'}</span><b>{airportTime(f.actualOut ?? f.estimatedOut ?? f.scheduledOut, f.originTimezone)}</b></div>
      <ArrowRight size={18} aria-label="to"/>
      <div><strong title={f.destination ?? undefined}>{f.destinationCode ?? f.destination ?? 'Destination unavailable'}</strong><span>{f.actualIn ? 'Arrived gate' : f.estimatedIn ? 'Est. arrival' : 'Scheduled arrival'}</span><b>{airportTime(f.actualIn ?? f.estimatedIn ?? f.scheduledIn, f.destinationTimezone)}</b></div>
    </div> : <p className="situation-flight-explanation">{scheduleMessage(schedule)}</p>}
    <PositionNote snapshot={snapshot} flight={flight} now={now}/>
    {a && !f && <AircraftMetrics aircraft={a}/>}
    <div className="situation-flight-footer">{view.lastCheckedAt && <p className="situation-flight-time">Last checked {new Date(view.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{f ? ' · airport local times' : ''}{brand?.availability === 'ready' && <> · <a href="https://www.logo.dev/" target="_blank" rel="noreferrer">Logos by Logo.dev</a></>}</p>}
      <div className="situation-flight-actions">{a && focus && <button className="text-button" onClick={() => focus(aircraftIdentity(a))}><LocateFixed size={14}/>Focus on map</button>}<button className="text-button" onClick={details}>Flight details<ArrowRight size={14}/></button></div>
    </div>
  </div>;
}
export function FlightDetailsContent({ snapshot, flightId, aircraftId, now, focus }: { snapshot: SituationSnapshot; flightId?: string; aircraftId?: string; now: number; focus?(id: string): void }) {
  const flight = snapshot.config.trackedFlights.find(f => f.id === flightId) ?? (aircraftId ? undefined : snapshot.config.trackedFlights[0]);
  const view = flight ? flightTrackingView(snapshot, flight, now) : null;
  const a = view?.position ?? mappedAircraft(snapshot, now).find(a => aircraftIdentity(a) === aircraftId);
  const schedule = view?.scheduleStatus, f = schedule?.state === 'connected' ? schedule.flight : null;
  const fa = !!flight && !!commercialFlightNumber(flight) && snapshot.flightAware?.credential === 'configured';
  return <>
    <div className="situation-flight-detail-identity"><h3>{flight?.label ?? a?.callsign ?? a?.registration ?? 'Aircraft'}</h3>{view?.airline && <p>{view.airline}</p>}</div>
    <section><h3>Schedule &amp; status</h3>{f && schedule?.state === 'connected' ? <>
      <strong>{schedule.stale ? 'Stale · ' : ''}{f.status ?? 'Status not supplied'}</strong><p>{f.origin ?? 'Origin unavailable'} → {f.destination ?? 'Destination unavailable'}</p>
      <p>Departure date {schedule.departureDate} · airport local times</p><dl>
        <dt>Scheduled departure</dt><dd>{airportTime(f.scheduledOut, f.originTimezone)}</dd>
        <dt>Estimated departure</dt><dd>{airportTime(f.estimatedOut, f.originTimezone)}</dd>
        <dt>Left gate</dt><dd>{airportTime(f.actualOut, f.originTimezone)}</dd><dt>Takeoff</dt><dd>{airportTime(f.actualOff, f.originTimezone)}</dd>
        <dt>Scheduled arrival</dt><dd>{airportTime(f.scheduledIn, f.destinationTimezone)}</dd><dt>Estimated arrival</dt><dd>{airportTime(f.estimatedIn, f.destinationTimezone)}</dd>
        <dt>Landed</dt><dd>{airportTime(f.actualOn, f.destinationTimezone)}</dd><dt>Arrived at gate</dt><dd>{airportTime(f.actualIn, f.destinationTimezone)}</dd>
        <dt>Aircraft</dt><dd>{f.equipment ?? 'Not supplied'}</dd>
      </dl><p>Checked {new Date(schedule.fetchedAt).toLocaleString()}</p><FlightAttribution/>
    </> : <><strong>{schedule?.state === 'unsupported' ? 'Flight number needed' : schedule?.state === 'not-connected' ? 'Not connected' : 'Awaiting flight status'}</strong><p>{schedule ? scheduleMessage(schedule) : 'Track a commercial flight to see its schedule.'}</p></>}</section>
    <section><h3>Position</h3>{flight && <PositionNote snapshot={snapshot} flight={flight} now={now}/>}
      {a ? <><AircraftMetrics aircraft={a}/><dl>
        {a.callsign && <><dt>ATC callsign</dt><dd>{a.callsign}</dd></>}{a.registration && <><dt>Registration</dt><dd>{a.registration}</dd></>}
        {a.icao && <><dt>Aircraft address</dt><dd>{a.icao.toUpperCase()}</dd></>}
        {(a.aircraftDescription || a.aircraftType) && <><dt>Aircraft</dt><dd>{[a.aircraftDescription, a.aircraftType].filter(Boolean).join(' · ')}</dd></>}
        <dt>Last reported coordinates</dt><dd>{a.position.latitude.toFixed(4)}, {a.position.longitude.toFixed(4)}</dd>
        <dt>Last reported</dt><dd>{new Date(a.observedAt).toLocaleString()} · {lastSeen(a, now)}</dd>
      </dl>{focus && <button className="text-button" onClick={() => focus(aircraftIdentity(a))}><LocateFixed size={15}/>Focus on map</button>}</> : <p>{fa ? 'The position endpoint is checked separately from status. No coordinates are inferred from the schedule.' : 'Live position will appear when this aircraft is available through the connected coverage.'}</p>}
      {a && <p>Map movement estimates up to five minutes from the reported speed and heading, then pauses for Refresh. Coordinates above remain the reported observation. Reduced motion keeps that point still.</p>}
      <FlightAttribution/>
    </section>
    {!flight && !aircraftId && mappedAircraft(snapshot, now).map(a => <section key={aircraftIdentity(a)}><h3>{a.callsign ?? a.registration ?? a.icao.toUpperCase()}</h3><AircraftMetrics aircraft={a}/><p>{positionLabel(snapshot, a, now)} · {lastSeen(a, now)}</p>{focus && <button className="text-button" onClick={() => focus(aircraftIdentity(a))}>Focus on map</button>}</section>)}
  </>;
}
