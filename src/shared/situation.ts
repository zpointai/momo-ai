import { z } from 'zod';
import { timezoneSchema } from './google';
import { flightAwareStateSchema, flightNumberSchema, flightDateSchema } from './flightAware';
import { carrierBrandStateSchema, logoTokenSchema } from './carrierBranding';

const id = z.string().uuid(), at = z.string().datetime(), label = z.string().trim().min(1).max(80);
export const coordinatesSchema = z.object({ latitude: z.number().min(-85).max(85), longitude: z.number().min(-180).max(180) }).strict();
export const resolvedLocalitySchema = z.object({ name: label, country: label, countryCode: z.string().regex(/^[A-Z]{2}$/), provider: z.literal('open-meteo'), providerId: z.string().regex(/^\d{1,12}$/), resolvedAt: at, attribution: z.literal('Open-Meteo · GeoNames') }).strict();
export const placeResultSchema = z.object({ ...coordinatesSchema.shape, timezone: timezoneSchema, locality: resolvedLocalitySchema }).strict();
export type PlaceResult = z.infer<typeof placeResultSchema>;
export const situationLocationSchema = z.object({ id, label, ...coordinatesSchema.shape, timezone: timezoneSchema.nullable(), purpose: z.string().trim().max(40), revision: z.string().max(64), updatedAt: at, locality: resolvedLocalitySchema.optional() }).strict();
export type SituationLocation = z.infer<typeof situationLocationSchema>;
export const commuteRouteSchema = z.object({ id, label, originId: id, destinationId: id, revision: z.string().max(64), updatedAt: at }).strict();
export type CommuteRoute = z.infer<typeof commuteRouteSchema>;
export const timeZoneEntrySchema = z.object({ id, label, timezone: timezoneSchema }).strict();
export type TimeZoneEntry = z.infer<typeof timeZoneEntrySchema>;
export const trackedFlightSchema = z.object({ id, label, kind: z.enum(['icao', 'callsign', 'registration']), identifier: z.string().trim().min(2).max(12).regex(/^[A-Z0-9-]+$/), flightNumber: flightNumberSchema.optional(), departureDate: flightDateSchema.optional() }).strict().refine(v => v.kind === 'icao' ? /^[A-F0-9]{6}$/.test(v.identifier) : v.kind === 'callsign' ? /^[A-Z0-9]{2,8}$/.test(v.identifier) : /^[A-Z0-9][A-Z0-9-]{2,11}$/.test(v.identifier), 'Check the aircraft identifier.');
export type TrackedFlight = z.infer<typeof trackedFlightSchema>;
export const situationConfigSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  locations: z.array(situationLocationSchema).max(12), routes: z.array(commuteRouteSchema).max(8),
  timezones: z.array(timeZoneEntrySchema).max(8), trackedFlights: z.array(trackedFlightSchema).max(8),
  defaultLocationId: id.nullable(), defaultRouteId: id.nullable(),
  mapEnabled: z.boolean(), weatherEnabled: z.boolean(), trafficEnabled: z.boolean(), flightsEnabled: z.boolean(),
  includeInBriefing: z.boolean(), shareWithAI: z.boolean(),
  flightAwareMonthlyLimitCents: z.number().int().min(0).max(400).optional(),
  carrierLogosEnabled: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  const places = new Set(v.locations.map(p => p.id));
  for (const list of [v.locations, v.routes, v.timezones, v.trackedFlights]) if (new Set(list.map(p => p.id)).size !== list.length) ctx.addIssue({ code: 'custom', message: 'Duplicate identity.' });
  if (v.defaultLocationId && !places.has(v.defaultLocationId)) ctx.addIssue({ code: 'custom', message: 'Choose an existing default location.' });
  if (v.defaultRouteId && !v.routes.some(r => r.id === v.defaultRouteId)) ctx.addIssue({ code: 'custom', message: 'Choose an existing default route.' });
  if (v.routes.some(r => !places.has(r.originId) || !places.has(r.destinationId) || r.originId === r.destinationId)) ctx.addIssue({ code: 'custom', message: 'Routes need two different saved endpoints.' });
});
export type SituationConfig = z.infer<typeof situationConfigSchema>;
export const emptySituationConfig = (): SituationConfig => ({ version: 1, revision: 0, locations: [], routes: [], timezones: [], trackedFlights: [], defaultLocationId: null, defaultRouteId: null, mapEnabled: true, weatherEnabled: true, trafficEnabled: false, flightsEnabled: false, includeInBriefing: false, shareWithAI: false });

export const sourceStateSchema = z.enum(['available', 'empty', 'not-configured', 'disabled', 'unavailable', 'stale', 'partial', 'error']);
export type SituationSourceState = z.infer<typeof sourceStateSchema>;
export const freshnessSchema = z.object({ provider: z.string().max(40), fetchedAt: at, observedAt: at.nullable(), freshUntil: at, revision: z.string().max(64), attribution: z.string().max(180) }).strict();
export type SituationFreshness = z.infer<typeof freshnessSchema>;
const measurement = z.number().finite().nullable();
export const weatherForecastSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), code: measurement, highC: measurement, lowC: measurement, precipitationProbability: measurement, uvIndex: measurement }).strict();
export type WeatherForecast = z.infer<typeof weatherForecastSchema>;
export const weatherSnapshotSchema = z.object({
  locationId: id, locationRevision: z.string().max(64), freshness: freshnessSchema, partial: z.boolean(),
  temperatureC: measurement, apparentC: measurement, code: measurement, humidityPercent: measurement,
  precipitationMm: measurement, windKph: measurement, windDegrees: measurement,
  forecast: z.array(weatherForecastSchema).max(5),
}).strict();
export type WeatherSnapshot = z.infer<typeof weatherSnapshotSchema>;
export const trafficIncidentSchema = z.object({ id: z.string().max(128), kind: z.enum(['congestion', 'roadworks', 'closure', 'other']), description: z.string().max(240), delaySeconds: measurement, position: coordinatesSchema.nullable(), startIndex: z.number().int().nonnegative().nullable(), endIndex: z.number().int().nonnegative().nullable() }).strict();
export type TrafficIncident = z.infer<typeof trafficIncidentSchema>;
export const trafficSnapshotSchema = z.object({
  routeId: id, routeRevision: z.string().max(64), freshness: freshnessSchema, partial: z.boolean(),
  durationSeconds: z.number().nonnegative(), freeFlowSeconds: measurement, typicalSeconds: measurement, delaySeconds: measurement, distanceMeters: z.number().nonnegative(),
  congestion: z.enum(['light', 'moderate', 'heavy', 'unknown']),
  geometry: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-85).max(85)])).max(12000), incidents: z.array(trafficIncidentSchema).max(30),
  // Restricted providers are displayed only until this instant and never enter durable evidence.
  displayOnly: z.boolean().optional(),
}).strict();
export type TrafficSnapshot = z.infer<typeof trafficSnapshotSchema>;
export const aircraftPositionSchema = z.object({
  icao: z.string().max(12), callsign: z.string().max(20).nullable(), registration: z.string().max(20).nullable(),
  flightAwareId: z.string().max(160).optional(),
  aircraftType: z.string().max(20).nullable().optional(), aircraftDescription: z.string().max(100).nullable().optional(),
  position: coordinatesSchema, altitudeFeet: measurement, groundSpeedKnots: measurement, headingDegrees: measurement, observedAt: at,
  origin: z.string().max(80).nullable(), destination: z.string().max(80).nullable(),
  trackedId: id.nullable(),
}).strict();
export type AircraftPosition = z.infer<typeof aircraftPositionSchema>;
export const flightSnapshotSchema = z.object({ freshness: freshnessSchema, partial: z.boolean(), aircraft: z.array(aircraftPositionSchema).max(100), queryRevision: z.string().max(64), queriedFlightId: id.nullable().optional() }).strict();
export type FlightSnapshot = z.infer<typeof flightSnapshotSchema>;
export const conditionCategorySchema = z.enum(['weather-change', 'commute-delay', 'traffic-incident', 'flight-change', 'situation-source-unavailable']);
export const nearbyConditionSchema = z.object({
  id: z.string().max(64), category: conditionCategorySchema, title: z.string().max(120), detail: z.string().max(400),
  source: z.enum(['weather', 'traffic', 'flights']), sourceId: z.string().max(128), sourceRevision: z.string().max(64),
  observedAt: at, expiresAt: at, attention: z.boolean(),
  displayOnly: z.boolean().optional(),
}).strict();
export type NearbyCondition = z.infer<typeof nearbyConditionSchema>;
export const providerStatusSchema = z.object({ source: z.enum(['weather', 'traffic', 'flights']), provider: z.string().max(40), state: sourceStateSchema, detail: z.string().max(240), selectionRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), lastAttemptAt: at.nullable(), lastError: z.enum(['network', 'rate-limit', 'authentication', 'response', 'review']).nullable() }).strict();
export type SituationProviderStatus = z.infer<typeof providerStatusSchema>;
export const requestRecordSchema = z.object({ id, provider: z.enum(['open-meteo', 'tomtom', 'airplanes-live', 'avioadsb', 'flightaware']), service: z.enum(['geocoding', 'weather', 'route', 'attribution', 'aircraft', 'flight-status', 'operator']), at, outcome: z.enum(['success', 'error', 'pending']), costUSD: z.string().nullable(), pricing: z.enum(['free-personal', 'unpriced']), durationMs: z.number().nonnegative().nullable() }).strict();
export type SituationRequestRecord = z.infer<typeof requestRecordSchema>;
export const situationSnapshotSchema = z.object({
  config: situationConfigSchema, selectedLocationId: id.nullable(), selectedRouteId: id.nullable(),
  weather: weatherSnapshotSchema.nullable(), traffic: trafficSnapshotSchema.nullable(), flights: flightSnapshotSchema.nullable(),
  statuses: z.array(providerStatusSchema).length(3), conditions: z.array(nearbyConditionSchema).max(24),
  trafficCredential: z.enum(['missing', 'configured', 'error']), protectionAvailable: z.boolean(), reviewBlocked: z.boolean(),
  usage: z.array(requestRecordSchema).max(40), checkedAt: at,
  placeResults: z.array(placeResultSchema).max(5).optional(),
  flightAware: flightAwareStateSchema.optional(),
  carrierBranding: carrierBrandStateSchema.optional(),
  flightChecks: z.array(z.object({ flightId: id, at }).strict()).max(20).optional(),
}).strict();
export type SituationSnapshot = z.infer<typeof situationSnapshotSchema>;
export const situationCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot'), locationId: id.nullable().optional(), routeId: id.nullable().optional() }).strict(),
  z.object({ action: z.literal('refresh'), source: z.enum(['weather', 'traffic', 'flights']), locationId: id.nullable().optional(), routeId: id.nullable().optional(), flightId: id.optional() }).strict(),
  z.object({ action: z.literal('search-places'), query: z.string().trim().min(3).max(100), countryCode: z.string().regex(/^[A-Z]{2}$/).optional() }).strict(),
  z.object({ action: z.literal('configure'), config: situationConfigSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('save-traffic-key'), secret: z.string().regex(/^[\x21-\x7e]{8,2048}$/) }).strict(),
  z.object({ action: z.literal('remove-traffic-key') }).strict(),
  z.object({ action: z.literal('import-traffic-key') }).strict(),
  z.object({ action: z.literal('save-flightaware-key'), secret: z.string().regex(/^[\x21-\x7e]{8,2048}$/) }).strict(),
  z.object({ action: z.literal('remove-flightaware-key') }).strict(),
  z.object({ action: z.literal('save-carrier-logo-token'), token: logoTokenSchema }).strict(),
  z.object({ action: z.literal('remove-carrier-logo-token') }).strict(),
  z.object({ action: z.literal('check-flightaware'), flightNumber: flightNumberSchema, departureDate: flightDateSchema }).strict(),
]);
export type SituationCommand = z.infer<typeof situationCommandSchema>;
export const freshnessState = (freshness: SituationFreshness, now = Date.now()) => Date.parse(freshness.freshUntil) <= now || Date.parse(freshness.fetchedAt) > now + 60000 ? 'stale' : 'current';
export const sourceStateLabel = (state: SituationSourceState) => ({ available: 'Available', empty: 'No observations', 'not-configured': 'Not configured', disabled: 'Off', unavailable: 'Unavailable', stale: 'Stale', partial: 'Partial', error: 'Could not refresh' }[state]);
export const situationMapFocus = (place?: SituationLocation) => place ? { center: [place.longitude, place.latitude] as [number, number], zoom: 9 } : { center: [10, 25] as [number, number], zoom: 1.5 };
export function weatherCondition(code: number | null): string {
  if (code === null) return 'Condition unavailable';
  if (code === 0) return 'Clear sky'; if (code <= 2) return 'Partly cloudy'; if (code === 3) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog'; if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain'; if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain showers'; if (code >= 85 && code <= 86) return 'Snow showers';
  if (code >= 95 && code <= 99) return 'Thunderstorm'; return 'Condition unavailable';
}
/** IANA/DST calculations only. No network or invented solar sunrise/sunset. */
export function zonedClock(timezone: string, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')!.value), minute = Number(parts.find(p => p.type === 'minute')!.value);
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, hour, minute,
    date: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(now),
    offset: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(now).find(p => p.type === 'timeZoneName')!.value.replace('GMT', 'UTC'),
    period: hour >= 6 && hour < 18 ? 'Daytime hours' : 'Evening / night hours' };
}
export function situationLayers(snapshot: SituationSnapshot, now = Date.now()) {
  const available = (source: string) => snapshot.statuses.some(s => s.source === source && ['available', 'partial', 'stale'].includes(s.state));
  return {
    places: snapshot.config.locations.length > 0,
    weather: !!snapshot.weather && available('weather') && snapshot.weather.temperatureC !== null,
    traffic: !!snapshot.traffic?.geometry.length && available('traffic'),
    roads: !!snapshot.traffic?.incidents.some(i => i.position) && available('traffic'),
    flights: !!snapshot.flights?.aircraft.some(a => now - Date.parse(a.observedAt) < 120000) && available('flights'),
    satellite: false, radar: false,
  };
}
