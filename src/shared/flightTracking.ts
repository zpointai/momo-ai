import type { AircraftPosition, SituationSnapshot, TrackedFlight } from './situation';
import { trackedAirline } from './flightIdentifiers';
import { commercialFlightNumber, departureDateFor, type FlightAwareResult } from './flightAware';

export type FlightScheduleStatus = { state: 'unsupported' | 'not-connected' | 'not-checked' | 'empty' | 'ambiguous' | 'error'; detail?: string } | {
  state: 'connected'; flight: FlightAwareResult['flights'][number]; fetchedAt: string; departureDate: string; stale: boolean;
};
export const aircraftIdentity = (a: AircraftPosition) => a.flightAwareId ?? a.icao;
export function scheduleStatus(snapshot: SituationSnapshot, flight: TrackedFlight, now: number): FlightScheduleStatus {
  const number = commercialFlightNumber(flight), state = snapshot.flightAware;
  if (!number) return { state: 'unsupported' };
  if (state?.credential !== 'configured') return { state: 'not-connected' };
  if (!snapshot.config.flightsEnabled || snapshot.reviewBlocked) return { state: 'not-checked' };
  const date = departureDateFor(snapshot.config, flight, now), result = state.result;
  if (state.error?.flightNumber === number && state.error.departureDate === date) return { state: 'error', detail: state.error.detail };
  if (!result || result.flightNumber !== number || result.departureDate !== date || now - Date.parse(result.checkedAt) > 900000) return { state: 'not-checked' };
  if (!result.flights.length) return { state: 'empty' };
  if (result.flights.length !== 1 || result.moreResults) return { state: 'ambiguous' };
  return { state: 'connected', flight: result.flights[0], fetchedAt: result.checkedAt, departureDate: date, stale: now - Date.parse(result.checkedAt) >= 300000 };
}
/** The last provider position is inspectable; only recent, non-projected points count as live. */
export function flightAwareAircraft(snapshot: SituationSnapshot, now: number): AircraftPosition | null {
  const state = snapshot.flightAware, latest = state?.position, p = latest?.position;
  if (!state || !p || state.positionError || now - Date.parse(latest.checkedAt) > 900000) return null;
  const tracking = snapshot.config.trackedFlights.find(f => { const status = scheduleStatus(snapshot, f, now); return status.state === 'connected' && status.flight.id === latest.flightId; });
  if (!tracking) return null;
  const f = state.result!.flights[0];
  return { icao: '', flightAwareId: latest.flightId, callsign: f.callsign, registration: f.registration, aircraftType: f.equipment,
    position: { latitude: p.latitude, longitude: p.longitude }, altitudeFeet: p.altitudeFeet, groundSpeedKnots: p.groundSpeedKnots, headingDegrees: p.headingDegrees,
    observedAt: p.observedAt, origin: f.originCode ?? null, destination: f.destinationCode ?? null, trackedId: tracking.id };
}
export function freshAircraft(snapshot: SituationSnapshot, now = Date.now()): AircraftPosition[] {
  if (!snapshot.config.flightsEnabled || snapshot.reviewBlocked) return [];
  const fa = flightAwareAircraft(snapshot, now);
  return (fa && !snapshot.flightAware?.position?.position?.projected ? [fa] : [])
    .filter(a => now - Date.parse(a.observedAt) < 120000 && now - Date.parse(a.observedAt) >= -60000);
}
export function mappedAircraft(snapshot: SituationSnapshot, now = Date.now()): AircraftPosition[] {
  const fresh = freshAircraft(snapshot, now), fa = flightAwareAircraft(snapshot, now);
  return fa ? [...fresh.filter(a => a.trackedId !== fa.trackedId), fa] : fresh;
}
export function positionLabel(snapshot: SituationSnapshot, aircraft: AircraftPosition, now: number): string {
  if (aircraft.flightAwareId && snapshot.flightAware?.position?.position?.projected) return 'Projected position';
  return now - Date.parse(aircraft.observedAt) >= 120000 ? 'Last known position' : 'Live position';
}
export function flightTrackingView(snapshot: SituationSnapshot, flight: TrackedFlight, now = Date.now()) {
  const schedule = scheduleStatus(snapshot, flight, now);
  const number = commercialFlightNumber(flight), date = departureDateFor(snapshot.config, flight, now), state = snapshot.flightAware;
  const statusCheckedAt = number && state?.credential === 'configured' ? state.error?.flightNumber === number && state.error.departureDate === date ? state.error.at : state.result?.flightNumber === number && state.result.departureDate === date ? state.result.checkedAt : null : null;
  return { tracking: flight, airline: schedule.state === 'connected' ? schedule.flight.carrier?.name ?? (schedule.flight.carrier?.icao ? schedule.flight.carrier.iata ?? schedule.flight.carrier.icao : trackedAirline(flight) ?? null) : trackedAirline(flight) ?? null, livePosition: freshAircraft(snapshot, now).find(a => a.trackedId === flight.id) ?? null,
    position: mappedAircraft(snapshot, now).find(a => a.trackedId === flight.id) ?? null, scheduleStatus: schedule,
    lastCheckedAt: statusCheckedAt };
}
export const aircraftMetrics = (a: AircraftPosition) => [
  { label: 'Altitude', value: a.altitudeFeet === null ? null : Math.round(a.altitudeFeet).toLocaleString() + ' ft' },
  { label: 'Speed', value: a.groundSpeedKnots === null ? null : Math.round(a.groundSpeedKnots) + ' kt' },
  { label: 'Heading', value: a.headingDegrees === null ? null : Math.round(a.headingDegrees) % 360 + '°' },
];
export const lastSeen = (a: AircraftPosition, now: number) => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(a.observedAt)) / 1000));
  return seconds < 120 ? seconds + ' sec ago' : seconds < 3600 ? Math.floor(seconds / 60) + ' min ago' : Math.floor(seconds / 3600) + ' hr ago';
};
