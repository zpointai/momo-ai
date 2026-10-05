import { z } from 'zod';
import type { SituationConfig, TrackedFlight } from './situation';
import { carrierIdentitySchema } from './carrierBranding';

export const flightNumberSchema = z.string().trim().toUpperCase().transform(v => v.replace(/\s+/g, '')).pipe(z.string().regex(/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/));
export const flightDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const nullableText = z.string().max(160).nullable(), instant = z.string().datetime().nullable();
export const flightAwareResultSchema = z.object({
  flightNumber: flightNumberSchema, departureDate: flightDateSchema, checkedAt: z.string().datetime(),
  returnedCount: z.number().int().min(0).max(15), moreResults: z.boolean(),
  flights: z.array(z.object({
    id: z.string().max(160), flightNumber: nullableText, status: nullableText,
    origin: nullableText, destination: nullableText, originCode: nullableText.optional(), destinationCode: nullableText.optional(), originTimezone: nullableText, destinationTimezone: nullableText,
    registration: nullableText, callsign: nullableText, equipment: nullableText,
    carrier: carrierIdentitySchema.optional(), cancelled: z.boolean().nullable().optional(), diverted: z.boolean().nullable().optional(),
    departureDelaySeconds: z.number().finite().nullable().optional(), arrivalDelaySeconds: z.number().finite().nullable().optional(),
    gateOrigin: nullableText.optional(), gateDestination: nullableText.optional(), terminalOrigin: nullableText.optional(), terminalDestination: nullableText.optional(),
    scheduledOut: instant, estimatedOut: instant, actualOut: instant, actualOff: instant,
    scheduledIn: instant, estimatedIn: instant, actualIn: instant, actualOn: instant,
  }).strict()).max(15),
}).strict();
export type FlightAwareResult = z.infer<typeof flightAwareResultSchema>;
export const flightAwarePositionSchema = z.object({
  flightId: z.string().min(1).max(160), checkedAt: z.string().datetime(),
  position: z.object({ latitude: z.number().min(-85).max(85), longitude: z.number().min(-180).max(180), observedAt: z.string().datetime(),
    altitudeFeet: z.number().finite().nullable(), groundSpeedKnots: z.number().nonnegative().nullable(), headingDegrees: z.number().min(0).max(360).nullable(),
    projected: z.boolean(),
  }).strict().nullable(),
}).strict();
export type FlightAwarePosition = z.infer<typeof flightAwarePositionSchema>;
export const flightAwareAccessSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), count: z.number().int().nonnegative(), lastAttemptAt: z.string().datetime(), estimatedMilliUSD: z.number().int().nonnegative().optional(), lastPositionAttemptAt: z.string().datetime().optional() }).strict();
export const flightAwareStateSchema = z.object({
  credential: z.enum(['missing', 'configured', 'error']), result: flightAwareResultSchema.nullable(),
  month: z.string(), requests: z.number().int().nonnegative(), limit: z.number().int().min(0).max(800),
  estimatedMilliUSD: z.number().int().nonnegative().optional(), limitMilliUSD: z.number().int().nonnegative().optional(),
  position: flightAwarePositionSchema.nullable().optional(), positionError: z.string().max(300).nullable().optional(),
  error: z.object({ flightNumber: flightNumberSchema, departureDate: flightDateSchema, detail: z.string().max(300), at: z.string().datetime() }).strict().nullable().optional(),
}).strict();
export type FlightAwareState = z.infer<typeof flightAwareStateSchema>;
/** Compare numeric designators without inventing an airline alias or ATC callsign. */
export function flightDesignator(value: string): string | null {
  const match = /^([A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])(\d{1,4})([A-Z]?)$/.exec(value.trim().toUpperCase().replace(/\s+/g, ''));
  return match ? match[1] + String(Number(match[2])) + match[3] : null;
}
export function commercialFlightNumber(flight: TrackedFlight): string | null {
  if (flight.flightNumber) return flightDesignator(flight.flightNumber);
  // Migrate only the previously saved W6 commercial input. A general label is not an aircraft identity.
  const label = flight.label.replace(/\s+/g, '').toUpperCase();
  if (flight.kind !== 'callsign') return null;
  if (/^W6\d{1,4}[A-Z]?$/.test(label) && flight.identifier === 'WZZ' + label.slice(2)) return flightDesignator(label);
  // Existing generic entries need no profile migration. Use the entered identity, never its display label.
  return flightDesignator(flight.identifier);
}
export function departureDateFor(config: SituationConfig, flight: TrackedFlight, now: number): string {
  return flight.departureDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: config.locations.find(p => p.id === config.defaultLocationId)?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
// Owner requested staying within the $5 credit; reserve $1 for usage elsewhere.
export const flightAwareLimitMilliUSD = (config: SituationConfig) => (config.flightAwareMonthlyLimitCents ?? 400) * 10;
export const flightAwareRequestLimit = (config: SituationConfig) => flightAwareLimitMilliUSD(config) / 5;
export const flightAwareSpent = (access: z.infer<typeof flightAwareAccessSchema> | undefined, month: string) => access?.month === month ? access.estimatedMilliUSD ?? access.count * 5 : 0;
export function airportTime(value: string | null, zone: string | null): string {
  if (!value) return 'Not supplied';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone ?? 'UTC', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value)); }
  catch { return new Date(value).toISOString(); }
}
