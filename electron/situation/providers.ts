import { createHash } from 'node:crypto';
import { coordinatesSchema, placeResultSchema, flightSnapshotSchema, trafficSnapshotSchema, weatherSnapshotSchema, type PlaceResult, type CommuteRoute, type FlightSnapshot, type SituationFreshness, type SituationLocation, type TrackedFlight, type TrafficSnapshot, type WeatherSnapshot } from '../../src/shared/situation';

export const situationHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const freshnessMinutes = { weather: 30, traffic: 5, flights: 1 } as const;
export interface WeatherProvider { id: string; read(location: SituationLocation): Promise<WeatherSnapshot> }
export type RecordRequest = <T>(service: 'route' | 'attribution', read: () => Promise<T>) => Promise<T>;
export interface TrafficProvider { id: string; read(route: CommuteRoute, origin: SituationLocation, destination: SituationLocation, key: string, request?: RecordRequest): Promise<TrafficSnapshot> }
export interface FlightProvider { id: string; read(location: SituationLocation | undefined, tracked: TrackedFlight[], flightId?: string): Promise<FlightSnapshot> }
export interface GeocodingProvider { search(query: string, countryCode?: string): Promise<PlaceResult[]> }
export interface WeatherLayerProvider { id: string; kind: 'historical-radar' | 'forecast'; supported: boolean }
export class SituationProviderError extends Error {
  constructor(public code: 'network' | 'rate-limit' | 'authentication' | 'response', public retryAfterMs = 0) { super('Situation source could not be read.'); }
}
export interface SituationResponse { body: unknown; cacheControl: string | null; age: number; receivedAt: number }
export interface SituationTransport { get(url: URL, maxBytes?: number): Promise<unknown>; response?(url: URL, maxBytes?: number): Promise<SituationResponse> }
/** Native-only bounded GETs. URLs and upstream bodies never appear in errors or diagnostics. */
export class NativeSituationTransport implements SituationTransport {
  async get(url: URL, maxBytes = 524288): Promise<unknown> {
    return (await this.response(url, maxBytes)).body;
  }
  async response(url: URL, maxBytes = 524288): Promise<SituationResponse> {
    if (url.protocol !== 'https:' || !['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'api.tomtom.com'].includes(url.hostname) || url.username || url.password || url.port) throw new SituationProviderError('response');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); const retry = response.headers.get('retry-after'); const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0; throw new SituationProviderError(response.status === 429 ? 'rate-limit' : [401, 403].includes(response.status) ? 'authentication' : 'network', Number.isFinite(delay) ? Math.max(0, delay) : 0); }
      if (!response.body) throw new SituationProviderError('response');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > maxBytes) { await reader.cancel(); throw new SituationProviderError('response'); } chunks.push(next.value); }
      try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), cacheControl: response.headers.get('cache-control'), age: Math.max(0, Number(response.headers.get('age')) || 0), receivedAt: Date.now() }; } catch { throw new SituationProviderError('response'); }
    } catch (e) { throw e instanceof SituationProviderError ? e : new SituationProviderError('network'); }
    finally { clearTimeout(timer); }
  }
}
const number = (v: unknown, min = -Infinity, max = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const timestamp = (seconds: unknown) => { const value = number(seconds, 0, 253402300799); return value === null ? null : new Date(value * 1000).toISOString(); };
export function normalizePlaces(raw: unknown, now: number): PlaceResult[] {
  const body = record(raw); if (body.error) throw new SituationProviderError('response');
  return array(body.results).slice(0, 20).flatMap(raw => {
    const p = record(raw); if (typeof p.feature_code !== 'string' || !/^PPL/.test(p.feature_code)) return [];
    const result = placeResultSchema.safeParse({ latitude: p.latitude, longitude: p.longitude, timezone: p.timezone, locality: { name: p.name, country: p.country, countryCode: p.country_code, provider: 'open-meteo', providerId: String(p.id), resolvedAt: new Date(now).toISOString(), attribution: 'Open-Meteo · GeoNames' } });
    return result.success ? [result.data] : [];
  }).slice(0, 5);
}
export class OpenMeteoGeocoding implements GeocodingProvider {
  constructor(private transport: SituationTransport, private now = Date.now) {}
  async search(query: string, countryCode?: string) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name: query, count: '5', language: 'en', format: 'json', ...(countryCode ? { countryCode } : {}) }).toString();
    return normalizePlaces(await this.transport.get(url, 65536), this.now());
  }
}
/** Cache metadata is consumed conservatively. TomTom results are never cached even when permitted. */
export function permittedCacheUntil(response: SituationResponse): number | null {
  if (!response.cacheControl || /\b(no-store|no-cache)\b/i.test(response.cacheControl)) return null;
  const age = response.cacheControl.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?:\s*,|\s*$)/i);
  return age ? response.receivedAt + Math.max(0, Number(age[1]) - response.age) * 1000 : null;
}
function freshness(provider: string, minutes: number, now: number, observedAt: string | null, body: unknown, attribution: string): SituationFreshness {
  // Old observations do not become fresh just because a request succeeded now.
  const until = Math.min(now + minutes * 60000, observedAt ? Date.parse(observedAt) + Math.max(minutes * 60000, provider === 'open-meteo' ? 3600000 : 120000) : Infinity);
  return { provider, fetchedAt: new Date(now).toISOString(), observedAt, freshUntil: new Date(until).toISOString(), revision: situationHash(body), attribution };
}
export function normalizeWeather(raw: unknown, location: SituationLocation, now: number): WeatherSnapshot {
  const body = record(raw), current = record(body.current), daily = record(body.daily);
  if (body.error || !Object.keys(current).length) throw new SituationProviderError('response');
  const observedAt = timestamp(current.time);
  if (observedAt && Date.parse(observedAt) > now + 3600000) throw new SituationProviderError('response');
  const zone = typeof body.timezone === 'string' ? body.timezone : 'UTC';
  const value = {
    locationId: location.id, locationRevision: location.revision,
    temperatureC: number(current.temperature_2m, -100, 70), apparentC: number(current.apparent_temperature, -120, 100), code: number(current.weather_code, 0, 99),
    humidityPercent: number(current.relative_humidity_2m, 0, 100), precipitationMm: number(current.precipitation, 0, 2000), windKph: number(current.wind_speed_10m, 0, 500), windDegrees: number(current.wind_direction_10m, 0, 360),
    forecast: array(daily.time).slice(0, 5).flatMap((time, i) => {
      const instant = timestamp(time); if (!instant) return [];
      let date: string; try { date = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant)); } catch { return []; }
      return [{ date, code: number(array(daily.weather_code)[i], 0, 99), highC: number(array(daily.temperature_2m_max)[i], -100, 70), lowC: number(array(daily.temperature_2m_min)[i], -100, 70), precipitationProbability: number(array(daily.precipitation_probability_max)[i], 0, 100), uvIndex: number(array(daily.uv_index_max)[i], 0, 40) }];
    }),
  };
  if (value.temperatureC === null && value.code === null) throw new SituationProviderError('response');
  return weatherSnapshotSchema.parse({ ...value, partial: observedAt === null || Object.values(value).some(v => v === null) || value.forecast.length < 5 || value.forecast.some(d => Object.values(d).some(v => v === null)), freshness: freshness('open-meteo', freshnessMinutes.weather, now, observedAt, value, 'Weather data by Open-Meteo · CC BY 4.0 · normalized by MoMo') });
}
export class OpenMeteoWeather implements WeatherProvider {
  id = 'open-meteo';
  constructor(private transport: SituationTransport, private now = Date.now) {}
  async read(location: SituationLocation) {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), current: 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max', timezone: 'auto', forecast_days: '5', timeformat: 'unixtime', temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' }).toString();
    return normalizeWeather(await this.transport.get(url), location, this.now());
  }
}
export function normalizeTraffic(raw: unknown, route: CommuteRoute, now: number): TrafficSnapshot {
  const first = record(array(record(raw).routes)[0]), summary = record(first.summary);
  const duration = number(summary.travelTimeInSeconds, 0), distance = number(summary.lengthInMeters, 0);
  if (duration === null || distance === null) throw new SituationProviderError('response');
  const points = array(first.legs).flatMap(l => array(record(l).points)).map(p => { const v = record(p); return coordinatesSchema.safeParse({ latitude: v.latitude, longitude: v.longitude }); });
  const allPoints = points.filter(p => p.success).map(p => [p.data!.longitude, p.data!.latitude] as [number, number]);
  const truncated = allPoints.length > 12000;
  // Preserve point indices for incident binding; oversized geometry is unavailable, never silently misindexed.
  const geometry = truncated ? [] : allPoints;
  const invalidGeometry = points.some(p => !p.success);
  const incidents = array(first.sections).filter(s => record(s).sectionType === 'TRAFFIC').slice(0, 30).map((raw, i) => {
    const s = record(raw), kind = ({ JAM: 'congestion', ROAD_WORK: 'roadworks', ROAD_CLOSURE: 'closure' } as const)[String(s.simpleCategory) as 'JAM'] ?? 'other';
    const startIndex = number(s.startPointIndex, 0), endIndex = number(s.endPointIndex, 0);
    const point = !invalidGeometry && startIndex !== null && Number.isInteger(startIndex) ? geometry[startIndex] : undefined;
    return { id: string(s.eventId, 128) ?? situationHash([route.id, kind, i]), kind, description: ({ congestion: 'Congestion on the configured route', roadworks: 'Roadworks on the configured route', closure: 'Road closure on the configured route', other: 'Traffic incident on the configured route' })[kind], delaySeconds: number(s.delayInSeconds, 0), position: point ? { longitude: point[0], latitude: point[1] } : null, startIndex: Number.isInteger(startIndex) ? startIndex : null, endIndex: Number.isInteger(endIndex) ? endIndex : null };
  });
  const free = number(summary.noTrafficTravelTimeInSeconds, 0), delay = number(summary.trafficDelayInSeconds, 0);
  const value = { routeId: route.id, routeRevision: route.revision, durationSeconds: duration, distanceMeters: distance, freeFlowSeconds: free, typicalSeconds: number(summary.historicTrafficTravelTimeInSeconds, 0), delaySeconds: delay, geometry: invalidGeometry ? [] : geometry, incidents,
    congestion: delay === null || !free ? 'unknown' : delay / free > 0.4 ? 'heavy' : delay / free > 0.15 ? 'moderate' : 'light' };
  return trafficSnapshotSchema.parse({ ...value, partial: free === null || delay === null || truncated || invalidGeometry || !geometry.length, freshness: freshness('tomtom', freshnessMinutes.traffic, now, null, value, 'Traffic and routing © TomTom') });
}
export class TomTomTraffic implements TrafficProvider {
  id = 'tomtom';
  constructor(private transport: SituationTransport, private now = Date.now) {}
  async read(route: CommuteRoute, origin: SituationLocation, destination: SituationLocation, key: string, request: RecordRequest = (_service, read) => read()) {
    const copyright = new URL('https://api.tomtom.com/map/2/copyrights/caption.json'); copyright.searchParams.set('key', key);
    const caption = await request('attribution', async () => {
      const body = record(await this.transport.get(copyright, 16384));
      if (typeof body.copyrightsCaption !== 'string' || body.copyrightsCaption.length > 180) throw new SituationProviderError('response');
      const value = string(body.copyrightsCaption, 180); if (!value || !/TomTom/i.test(value)) throw new SituationProviderError('response'); return value;
    });
    const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${origin.latitude},${origin.longitude}:${destination.latitude},${destination.longitude}/json`);
    url.search = new URLSearchParams({ key, traffic: 'true', departAt: 'now', travelMode: 'car', computeTravelTimeFor: 'all', sectionType: 'traffic', routeRepresentation: 'polyline', maxAlternatives: '0' }).toString();
    return request('route', async () => {
      if (!this.transport.response) throw new SituationProviderError('response');
      const response = await this.transport.response(url, 2097152), result = normalizeTraffic(response.body, route, this.now());
      const until = permittedCacheUntil(response);
      // A no-cache response is delivered once to the requesting view, never reused by snapshot or Briefing.
      // The visible response ages out within five minutes; a shorter explicit max-age is respected too.
      if (until !== null) result.freshness.freshUntil = new Date(Math.min(until, Date.parse(result.freshness.freshUntil))).toISOString();
      result.freshness.attribution = caption; result.displayOnly = true; return result;
    });
  }
}
export function normalizeAircraft(raw: unknown, tracked: TrackedFlight[], now: number, provider = 'airplanes-live', queryRevision = situationHash(tracked)): FlightSnapshot {
  const body = record(raw); if (!Array.isArray(body.ac)) throw new SituationProviderError('response');
  const sourceAt = number(body.now, 0); if (sourceAt === null) throw new SituationProviderError('response'); const epoch = sourceAt > 1e12 ? sourceAt : sourceAt * 1000;
  if (epoch > now + 60000) throw new SituationProviderError('response');
  const aircraft = array(body.ac).slice(0, 500).flatMap(item => {
    const a = record(item), position = coordinatesSchema.safeParse({ latitude: a.lat, longitude: a.lon }), seen = number(a.seen_pos, 0), icao = string(a.hex, 12), callsign = string(a.flight, 20);
    if (!position.success || !icao || !/^[a-f0-9]{6}$/i.test(icao) || seen === null || seen > 120 || now - (epoch - seen * 1000) >= 120000) return [];
    return [{ icao, callsign, registration: string(a.r, 20), aircraftType: string(a.t, 20), aircraftDescription: string(a.desc, 100), position: position.data, altitudeFeet: number(a.alt_baro, -2000, 100000), groundSpeedKnots: number(a.gs, 0, 3000), headingDegrees: number(a.track, 0, 360), observedAt: new Date(epoch - seen * 1000).toISOString(), origin: null, destination: null, trackedId: tracked.find(t => (t.kind === 'icao' ? icao.toUpperCase() : t.kind === 'registration' ? string(a.r, 20)?.toUpperCase().replaceAll('-', '') : callsign?.toUpperCase()) === (t.kind === 'registration' ? t.identifier.replaceAll('-', '') : t.identifier))?.id ?? null }];
  }).slice(0, 100);
  const value = { aircraft, queryRevision };
  return flightSnapshotSchema.parse({ ...value, partial: array(body.ac).length > aircraft.length, freshness: freshness(provider, freshnessMinutes.flights, now, new Date(epoch).toISOString(), value, provider === 'avioadsb' ? 'Data: AvioADSB (CC BY 4.0) · normalized by MoMo' : 'Aircraft positions from Airplanes.live · ADS-B/MLAT coverage varies') });
}
export const flightQueryRevision = (location: SituationLocation | undefined, tracked: TrackedFlight[], flightId?: string) => situationHash(flightId ? { tracked: tracked.find(f => f.id === flightId) } : { location: location?.revision, radiusNM: 40, tracked });
/** Explicit personal API use; one query, no schedules, no sweep of all saved locations. */
export class AvioAircraft implements FlightProvider {
  id = 'avioadsb';
  constructor(private transport: SituationTransport, private now = Date.now) {}
  async read(location: SituationLocation | undefined, tracked: TrackedFlight[], flightId?: string) {
    const flight = tracked.find(f => f.id === flightId);
    if (flightId && !flight || !flight && !location) throw new SituationProviderError('response');
    const path = flight ? `${flight.kind === 'icao' ? 'hex' : flight.kind === 'registration' ? 'reg' : 'callsign'}/${encodeURIComponent(flight.identifier)}` : `point/${location!.latitude}/${location!.longitude}/40`;
    const response = await this.transport.get(new URL(`https://avioadsb.org/v1/${path}`));
    return { ...normalizeAircraft(response, tracked, this.now(), this.id, flightQueryRevision(location, tracked, flightId)), queriedFlightId: flightId ?? null };
  }
}
