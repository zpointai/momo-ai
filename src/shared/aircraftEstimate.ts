import type { AircraftPosition, SituationSnapshot } from './situation';

export type AircraftPoint = [number, number];
export const aircraftEstimateHorizonMs = 5 * 60000;
export interface AircraftDisplayPosition { point: AircraftPoint; mode: 'reported' | 'estimated' | 'paused' }

/** Eligibility comes from the same verified airborne instance, never a route or timetable. */
export function canEstimateAircraft(snapshot: SituationSnapshot, aircraft: AircraftPosition): boolean {
  const state = snapshot.flightAware;
  const flight = state?.result?.flights.find(f => f.id === aircraft.flightAwareId);
  return snapshot.config.flightsEnabled && !snapshot.reviewBlocked && state?.credential === 'configured'
    && state.position?.flightId === aircraft.flightAwareId && state.position?.position?.projected === false
    && !state.error && !state.positionError && !!flight && !flight.cancelled && !flight.actualOn && !flight.actualIn && !/landed|arrived|taxi|cancel/i.test(flight.status ?? '')
    && (/^En Route\b/i.test(flight.status ?? '') || !!flight.actualOff);
}

/** A bounded visual estimate; the source observation, history, status and accounting are never changed. */
export function aircraftDisplayPosition(aircraft: AircraftPosition, now: number, enabled: boolean): AircraftDisplayPosition {
  const reported: AircraftDisplayPosition = { point: [aircraft.position.longitude, aircraft.position.latitude], mode: 'reported' };
  const age = now - Date.parse(aircraft.observedAt), speed = aircraft.groundSpeedKnots, heading = aircraft.headingDegrees;
  if (!enabled || !Number.isFinite(age) || age < 0 || speed === null || !Number.isFinite(speed) || speed <= 0 || speed > 1200
    || heading === null || !Number.isFinite(heading) || heading < 0 || heading > 360) return reported;
  const elapsed = Math.min(age, aircraftEstimateHorizonMs) / 1000;
  const angle = speed * 1852 / 3600 * elapsed / 6371008.8;
  const radians = Math.PI / 180, lat = aircraft.position.latitude * radians, lon = aircraft.position.longitude * radians, bearing = heading * radians;
  const latitude = Math.asin(Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(bearing));
  const longitude = lon + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(lat), Math.cos(angle) - Math.sin(lat) * Math.sin(latitude));
  if (Math.abs(latitude / radians) > 85) return reported;
  return { point: [((longitude / radians + 540) % 360) - 180, latitude / radians], mode: age >= aircraftEstimateHorizonMs ? 'paused' : 'estimated' };
}
export const aircraftEstimateLabel = (mode: AircraftDisplayPosition['mode'], reported: string) => mode === 'estimated' ? 'Estimated position' : mode === 'paused' ? 'Estimate paused · refresh' : reported;
