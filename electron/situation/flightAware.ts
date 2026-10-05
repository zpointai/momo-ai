import { flightAwareResultSchema, flightAwarePositionSchema, flightDesignator, type FlightAwareResult, type FlightAwarePosition } from '../../src/shared/flightAware';
import { SituationProviderError } from './providers';
import { carrierDomain, carrierIdentitySchema, type CarrierIdentity } from '../../src/shared/carrierBranding';

export interface FlightAwareProvider {
  read(flightNumber: string, departureDate: string, key: string): Promise<FlightAwareResult>;
  position(flightId: string, key: string): Promise<FlightAwarePosition>;
  operator?(icao: string, key: string): Promise<CarrierIdentity>;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : null;
const instant = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const identity = (v: unknown) => text(v)?.replace(/\s+/g, '').toUpperCase();
const carrierCode = (v: unknown, pattern: RegExp) => { const code = identity(v); return code && pattern.test(code) ? code : null; };
export function normalizeFlightAwareOperator(raw: unknown, expected: CarrierIdentity): CarrierIdentity {
  const body = object(raw), candidates = [body, ...(Array.isArray(body.alternatives) ? body.alternatives.map(object) : [])];
  const matches = candidates.filter(candidate => expected.icao && carrierCode(candidate.icao, /^[A-Z]{3}$/) === expected.icao && (!expected.iata || carrierCode(candidate.iata, /^[A-Z0-9]{2}$/) === expected.iata));
  if (matches.length !== 1) throw new SituationProviderError('response');
  const operator = matches[0];
  return carrierIdentitySchema.parse({ icao: expected.icao, iata: carrierCode(operator.iata, /^[A-Z0-9]{2}$/), name: text(operator.shortname) ?? text(operator.name), callsign: text(operator.callsign), domain: carrierDomain(operator.url) });
}
export function normalizeFlightAware(raw: unknown, flightNumber: string, departureDate: string, now: number): FlightAwareResult {
  const body = object(raw);
  if (!Array.isArray(body.flights) || body.flights.length > 15) throw new SituationProviderError('response');
  const flights = body.flights.flatMap(rawFlight => {
    const f = object(rawFlight), origin = object(f.origin), destination = object(f.destination);
    const identifiers = [f.ident, f.ident_iata, f.ident_icao, ...(Array.isArray(f.codeshares_iata) ? f.codeshares_iata : [])];
    if (!identifiers.some(v => { const value = identity(v); return value === flightNumber || value && flightDesignator(value) !== null && flightDesignator(value) === flightDesignator(flightNumber); }) || !text(f.fa_flight_id)) return [];
    const departure = instant(f.scheduled_out) ?? instant(f.scheduled_off), zone = text(origin.timezone);
    // Match the scheduled departure day at the origin, never silently substitute a different day's flight.
    if (!departure || !zone) return [];
    try { if (new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(departure)) !== departureDate) return []; }
    catch { return []; }
    const airport = (a: Record<string, unknown>) => [text(a.name), text(a.code_iata) ?? text(a.code)].filter(Boolean).join(' · ') || null;
    return [{ id: text(f.fa_flight_id)!, flightNumber: text(f.ident_iata) ?? text(f.ident), status: text(f.status),
      origin: airport(origin)?.slice(0, 160) ?? null, destination: airport(destination)?.slice(0, 160) ?? null,
      originCode: text(origin.code_iata) ?? text(origin.code), destinationCode: text(destination.code_iata) ?? text(destination.code),
      originTimezone: zone, destinationTimezone: text(destination.timezone), registration: text(f.registration),
      // ident_icao is a flight designator, not evidence of the transmitted ATC callsign.
      callsign: text(f.atc_ident), equipment: text(f.aircraft_type),
      carrier: { icao: carrierCode(f.operator_icao ?? f.operator, /^[A-Z]{3}$/), iata: carrierCode(f.operator_iata, /^[A-Z0-9]{2}$/), name: null, callsign: null, domain: null },
      cancelled: typeof f.cancelled === 'boolean' ? f.cancelled : null, diverted: typeof f.diverted === 'boolean' ? f.diverted : null,
      departureDelaySeconds: typeof f.departure_delay === 'number' && Number.isFinite(f.departure_delay) ? f.departure_delay : null,
      arrivalDelaySeconds: typeof f.arrival_delay === 'number' && Number.isFinite(f.arrival_delay) ? f.arrival_delay : null,
      gateOrigin: text(f.gate_origin), gateDestination: text(f.gate_destination), terminalOrigin: text(f.terminal_origin), terminalDestination: text(f.terminal_destination),
      scheduledOut: instant(f.scheduled_out), estimatedOut: instant(f.estimated_out), actualOut: instant(f.actual_out), actualOff: instant(f.actual_off),
      scheduledIn: instant(f.scheduled_in), estimatedIn: instant(f.estimated_in), actualIn: instant(f.actual_in), actualOn: instant(f.actual_on),
    }];
  });
  return flightAwareResultSchema.parse({ flightNumber, departureDate, checkedAt: new Date(now).toISOString(), returnedCount: body.flights.length, moreResults: !!object(body.links).next, flights });
}

export function normalizeFlightAwarePosition(raw: unknown, flightId: string, now: number): FlightAwarePosition {
  const body = object(raw), p = object(body.last_position);
  if (body.fa_flight_id !== flightId || !Object.hasOwn(body, 'last_position')) throw new SituationProviderError('response');
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const result = flightAwarePositionSchema.safeParse({ flightId, checkedAt: new Date(now).toISOString(), position: body.last_position === null ? null : {
    latitude: p.latitude, longitude: p.longitude, observedAt: instant(p.timestamp),
    altitudeFeet: number(p.altitude) === null ? null : (p.altitude as number) * 100,
    groundSpeedKnots: number(p.groundspeed), headingDegrees: number(p.heading), projected: p.update_type === 'P',
  } });
  if (!result.success || result.data.position && Date.parse(result.data.position.observedAt) > now + 60000) throw new SituationProviderError('response');
  return result.data;
}

/** Native GETs, bounded responses, no retries, redirects, raw-response logs or renderer credentials. */
export class NativeFlightAware implements FlightAwareProvider {
  constructor(private now = Date.now) {}
  async read(flightNumber: string, departureDate: string, key: string) {
    const day = Date.parse(departureDate + 'T00:00:00Z');
    const url = new URL('https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(flightNumber));
    // Include every origin's local day, then verify each returned flight in its own time zone.
    url.search = new URLSearchParams({ ident_type: 'designator', start: new Date(day - 14 * 3600000).toISOString(), end: new Date(day + 36 * 3600000).toISOString(), max_pages: '1' }).toString();
    return normalizeFlightAware(await this.get(url, key), flightNumber, departureDate, this.now());
  }
  async position(flightId: string, key: string) {
    const url = new URL('https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(flightId) + '/position');
    return normalizeFlightAwarePosition(await this.get(url, key), flightId, this.now());
  }
  async operator(icao: string, key: string) {
    if (!/^[A-Z]{3}$/.test(icao)) throw new SituationProviderError('response');
    return normalizeFlightAwareOperator(await this.get(new URL('https://aeroapi.flightaware.com/aeroapi/operators/' + icao), key), { icao, iata: null, name: null, callsign: null, domain: null });
  }
  private async get(url: URL, key: string): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', 'x-apikey': key }, redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new SituationProviderError(response.status === 429 ? 'rate-limit' : [401, 403].includes(response.status) ? 'authentication' : 'network'); }
      if (!response.body) throw new SituationProviderError('response');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 262144) { await reader.cancel(); throw new SituationProviderError('response'); } chunks.push(next.value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) { throw e instanceof SituationProviderError ? e : new SituationProviderError('response'); }
    finally { clearTimeout(timer); }
  }
}
