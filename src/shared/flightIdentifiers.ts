import type { TrackedFlight } from './situation';

export interface AirlineAlias { iata: string; icao: string; name: string; source: string; }
// A small, replaceable verified registry, not a schedule/route resolver.
// ICAO STA/10-WP/6 lists Wizz Air as W6 / WZZ. Verified 2026-09-28.
export const airlineAliases: readonly AirlineAlias[] = [{ iata: 'W6', icao: 'WZZ', name: 'Wizz Air', source: 'https://www.icao.int/Meetings/STA10/Documents/Sta10_Wp006_en.pdf' }];
type Kind = TrackedFlight['kind'];
export type FlightInputMode = 'auto' | Kind;
export function normalizeFlightInput(input: string, mode: FlightInputMode = 'auto', aliases = airlineAliases): { kind: Kind; identifier: string; label: string } {
  const value = input.trim().toUpperCase().replace(/\s+/g, '');
  const invalid = () => { throw new Error('We couldn’t recognize that flight or aircraft identifier. Check it or use Advanced.'); };
  if (mode !== 'auto') {
    const valid = mode === 'icao' ? /^[A-F0-9]{6}$/.test(value) : mode === 'registration' ? /^[A-Z0-9][A-Z0-9-]{2,11}$/.test(value) : /^[A-Z0-9]{2,8}$/.test(value);
    if (!valid) return invalid();
    return { kind: mode, identifier: value, label: value };
  }
  if (/^[A-F]{2}\d{4}$/.test(value)) throw new Error('We couldn’t recognize that flight or aircraft identifier unambiguously. Use Advanced to choose a flight callsign or ICAO address.');
  if (/^[A-F0-9]{6}$/.test(value)) return { kind: 'icao', identifier: value, label: value };
  if (/^[A-Z0-9]{1,2}-[A-Z0-9]{3,5}$/.test(value) || /^N[1-9]\d{0,4}[A-HJ-NP-Z]{0,2}$/.test(value)) return { kind: 'registration', identifier: value, label: value };
  const commercial = /^([A-Z][A-Z0-9]|[0-9][A-Z])(\d{1,4}[A-Z]?)$/.exec(value);
  if (commercial) {
    const alias = aliases.find(a => a.iata === commercial[1]);
    return { kind: 'callsign', identifier: alias ? alias.icao + commercial[2] : value, label: commercial[1] + ' ' + commercial[2] };
  }
  if (/^[A-Z]{3}(?=[A-Z0-9]*\d)[A-Z0-9]{1,5}$/.test(value)) return { kind: 'callsign', identifier: value, label: value };
  return invalid();
}
export const trackedAirline = (flight: TrackedFlight) => flight.kind === 'callsign' ? airlineAliases.find(a => flight.identifier.startsWith(a.icao))?.name : undefined;
