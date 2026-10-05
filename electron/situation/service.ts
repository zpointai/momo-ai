import { randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import { configurationIssue } from '../../src/shared/situationLifecycle';
import { NativeFlightAware, type FlightAwareProvider } from './flightAware';
import { commercialFlightNumber, departureDateFor, flightAwareRequestLimit, flightAwareLimitMilliUSD, flightAwareSpent, flightAwareResultSchema, flightAwarePositionSchema, type FlightAwarePosition, type FlightAwareResult, type FlightAwareState } from '../../src/shared/flightAware';
import type { CredentialStore } from '../credentials/store';
import { situationCommandSchema, situationConfigSchema, situationSnapshotSchema, freshnessState, type SituationCommand, type SituationSnapshot, type SituationProviderStatus, type SituationRequestRecord, type WeatherSnapshot, type TrafficSnapshot, type FlightSnapshot, type PlaceResult } from '../../src/shared/situation';
import { SituationStore, type SituationRecord } from './store';
import { NativeSituationTransport, OpenMeteoWeather, OpenMeteoGeocoding, TomTomTraffic, SituationProviderError, situationHash, flightQueryRevision, type WeatherProvider, type TrafficProvider, type FlightProvider, type GeocodingProvider } from './providers';
import { deriveSituationConditions, FlightChangeFeed } from './conditions';
import { LogoDevCarrierBrandProvider } from './carrierBranding';
import type { CarrierBrand, CarrierIdentity } from '../../src/shared/carrierBranding';

type Keys = Pick<CredentialStore, 'available' | 'status' | 'read' | 'save' | 'remove'>;
export interface SituationAccess { enabled: boolean; network: boolean; weatherOnly?: boolean }
export { deriveSituationConditions } from './conditions';
export class SituationService {
  private queue: Promise<unknown> = Promise.resolve();
  private weather: WeatherProvider;
  private traffic: TrafficProvider;
  private geocoder: GeocodingProvider;
  private placeResults: PlaceResult[] = [];
  private lastSearch = { query: '', at: -Infinity };
  private flightAware: FlightAwareProvider;
  private flightAwareResult: FlightAwareResult | null = null;
  private flightAwareError: FlightAwareState['error'] = null;
  private flightAwarePosition: FlightAwarePosition | null = null;
  private flightAwarePositionError: string | null = null;
  private flightChanges = new FlightChangeFeed();
  private brandProvider = new LogoDevCarrierBrandProvider();
  private operators = new Map<string, { carrier: CarrierIdentity | null; until: number }>();
  private brandingFlightIds = new Set<string>();
  constructor(private store: SituationStore, private keys: Keys, private access: () => Promise<SituationAccess>, private now = Date.now,
    providers?: { weather?: WeatherProvider; traffic?: TrafficProvider; flights?: FlightProvider; geocoder?: GeocodingProvider; flightAware?: FlightAwareProvider }, private importKey?: () => Promise<void>) {
    const transport = new NativeSituationTransport();
    this.weather = providers?.weather ?? new OpenMeteoWeather(transport, now);
    this.traffic = providers?.traffic ?? new TomTomTraffic(transport, now);
    this.geocoder = providers?.geocoder ?? new OpenMeteoGeocoding(transport, now);
    this.flightAware = providers?.flightAware ?? new NativeFlightAware(now);
  }
  command(raw: SituationCommand): Promise<SituationSnapshot> {
    const input = situationCommandSchema.parse(raw), operation = this.queue.then(() => this.execute(input));
    this.queue = operation.catch(() => undefined); return operation;
  }
  /** Cache reads never dispatch a provider request. Restricted traffic is response-only. */
  async snapshot(locationId?: string | null, routeId?: string | null): Promise<SituationSnapshot> {
    const record = await this.store.get(), { config } = record, now = this.now(), permission = await this.access();
    const location = config.locations.find(p => p.id === (locationId === undefined ? config.defaultLocationId : locationId)), route = config.routes.find(r => r.id === (routeId === undefined ? config.defaultRouteId : routeId));
    const weather = permission.enabled && config.weatherEnabled && location ? record.weather.find(w => w.locationId === location.id && w.locationRevision === location.revision) ?? null : null;
    const credential = await this.keys.status('tomtom');
    const flightAwareCredential = await this.keys.status('flightaware'), month = new Date(now).toISOString().slice(0, 7);
    if (this.flightAwareResult && now - Date.parse(this.flightAwareResult.checkedAt) > 900000) this.flightAwareResult = null;
    // Historical aircraft receipts remain readable; retired provider data is never projected.
    const flights = null;
    // Check timestamps survive position expiry, without retaining aircraft history.
    const flightChecks = permission.enabled && config.flightsEnabled ? config.trackedFlights.flatMap(f => {
      const revision = flightQueryRevision(undefined, config.trackedFlights, f.id);
      const last = [...record.statuses].reverse().find(s => s.source === 'flights' && s.selectionRevision === revision && s.lastAttemptAt);
      return last?.lastAttemptAt ? [{ flightId: f.id, at: last.lastAttemptAt }] : [];
    }) : [];
    const status = (source: SituationProviderStatus['source'], provider: string, configured: boolean, enabled: boolean, data: WeatherSnapshot | TrafficSnapshot | FlightSnapshot | null, detail: string): SituationProviderStatus => {
      const selectionRevision = source === 'weather' ? location?.revision : source === 'traffic' ? route?.revision : record.flights?.queryRevision;
      const last = [...record.statuses].reverse().find(s => s.source === source && (source === 'flights' || s.selectionRevision === selectionRevision)), failed = last?.state === 'error';
      const state = !permission.enabled || !enabled ? 'disabled' : !configured ? 'not-configured' : data ? failed || freshnessState(data.freshness, now) === 'stale' ? 'stale' : source === 'flights' && !(data as FlightSnapshot).aircraft.length ? 'empty' : data.partial ? 'partial' : 'available' : failed ? 'error' : 'empty';
      return { source, provider, state, detail: state === 'disabled' ? 'This source is off. Enable it in Configure view when needed.' : state === 'stale' ? 'This report is out of date. Refresh for current conditions.' : failed && configured && enabled ? last.detail : detail, lastAttemptAt: last?.lastAttemptAt ?? null, lastError: failed ? last.lastError : null };
    };
    const statuses: SituationProviderStatus[] = [
      status('weather', this.weather.id, !!location, config.weatherEnabled, weather, location ? 'Refresh to see weather for this place.' : 'Add a place to see its weather.'),
      status('traffic', this.traffic.id, credential === 'configured' && !!route, config.trafficEnabled, null, credential !== 'configured' ? 'Add a traffic provider and a saved route to see live commute conditions.' : !route ? 'Add another place to create a commute route.' : 'Refresh for a new route estimate.'),
      { source: 'flights', provider: 'flightaware', state: !permission.enabled || !config.flightsEnabled ? 'disabled' : flightAwareCredential !== 'configured' ? 'not-configured' : this.flightAwareError ? 'error' : this.flightAwareResult?.flights.length ? 'available' : 'empty', detail: this.flightAwareError?.detail ?? 'Track a flight and refresh for FlightAware status and position.', lastAttemptAt: this.flightAwareError?.at ?? this.flightAwareResult?.checkedAt ?? null, lastError: this.flightAwareError ? 'response' : null },
    ];
    const logoCredential = await this.keys.status('logodev');
    const brands: CarrierBrand[] = [];
    if (permission.enabled && permission.network && !permission.weatherOnly && config.flightsEnabled && config.carrierLogosEnabled && logoCredential === 'configured') {
      try {
        const token = await this.keys.read('logodev');
        for (const flight of this.flightAwareResult?.flights ?? []) if (flight.carrier && this.brandingFlightIds.has(flight.id) && brands.length < 8) brands.push(this.brandProvider.resolve(flight.carrier, token, now));
      } catch { /* Optional branding must never prevent the flight projection. */ }
    }
    const flightConditions = this.flightChanges.prune(config.trackedFlights, permission.enabled && permission.network && config.flightsEnabled && flightAwareCredential === 'configured', now);
    return situationSnapshotSchema.parse({ config, selectedLocationId: location?.id ?? null, selectedRouteId: route?.id ?? null, weather, traffic: null, flights, flightChecks, statuses,
      flightAware: { credential: flightAwareCredential, result: permission.enabled && permission.network && config.flightsEnabled && flightAwareCredential === 'configured' ? this.flightAwareResult : null, error: config.flightsEnabled ? this.flightAwareError : null,
        position: permission.enabled && permission.network && config.flightsEnabled && flightAwareCredential === 'configured' && this.flightAwareResult ? this.flightAwarePosition : null, positionError: this.flightAwarePositionError,
        month, requests: record.flightAwareAccess?.month === month ? record.flightAwareAccess.count : 0, limit: flightAwareRequestLimit(config), estimatedMilliUSD: flightAwareSpent(record.flightAwareAccess, month), limitMilliUSD: flightAwareLimitMilliUSD(config) },
      carrierBranding: { credential: logoCredential, brands },
      conditions: permission.enabled ? [...record.conditions.filter(c => Date.parse(c.expiresAt) > now && c.source === 'weather' && config.weatherEnabled && c.sourceId === location?.id), ...flightConditions].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 24) : [],
      trafficCredential: credential, protectionAvailable: this.keys.available(), reviewBlocked: !permission.network, usage: record.requests.slice(-40).reverse(), checkedAt: new Date(now).toISOString(), placeResults: this.placeResults });
  }
  private async request<T>(record: SituationRecord, provider: SituationRequestRecord['provider'], service: SituationRequestRecord['service'], read: () => Promise<T>): Promise<T> {
    const start = this.now(), free = provider !== 'tomtom' && provider !== 'flightaware';
    const request: SituationRequestRecord = { id: randomUUID(), provider, service, at: new Date(start).toISOString(), outcome: 'pending', costUSD: free ? '0' : null, pricing: free ? 'free-personal' : 'unpriced', durationMs: null };
    await this.store.appendRequest(request); record.requests.push(request); record.requests = record.requests.slice(-40); await this.store.put(record);
    try { const value = await read(); request.outcome = 'success'; return value; }
    catch (error) { request.outcome = 'error'; throw error; }
    finally { request.durationMs = Math.max(0, this.now() - start); await this.store.appendRequest(request); await this.store.put(record); }
  }
  private async execute(command: SituationCommand): Promise<SituationSnapshot> {
    const record = await this.store.get(), now = this.now();
    if (command.action === 'save-carrier-logo-token' || command.action === 'remove-carrier-logo-token') {
      if (command.action === 'save-carrier-logo-token') await this.keys.save('logodev', command.token);
      else await this.keys.remove('logodev');
      // Saving a key never opts in to image/operator requests.
      record.config.carrierLogosEnabled = false; record.config.revision++;
      this.operators.clear(); this.brandingFlightIds.clear(); await this.store.put(record); return this.snapshot();
    }
    if (command.action === 'configure') {
      if (command.expectedRevision !== record.config.revision) throw new AppError('conflict', 'Situation settings changed. Reload saved values before applying your edits.');
      if (command.config.trafficEnabled && !record.config.trafficEnabled && await this.keys.status('tomtom') !== 'configured') throw new AppError('invalid_input', 'Save a protected traffic key before enabling requests.');
      const config = situationConfigSchema.parse(command.config), updatedAt = new Date(now).toISOString();
      const issue = configurationIssue(config, record.config);
      if (issue) throw new AppError('invalid_input', issue);
      config.revision = record.config.revision + 1;
      config.locations = config.locations.map(p => {
        const old = record.config.locations.find(v => v.id === p.id);
        if (old && (p.latitude !== old.latitude || p.longitude !== old.longitude || p.timezone !== old.timezone)) delete p.locality;
        const { revision: _r, updatedAt: _t, ...identity } = p, revision = situationHash(identity);
        return { ...p, revision, updatedAt: old?.revision === revision ? old.updatedAt : updatedAt };
      });
      config.routes = config.routes.map(r => { const { revision: _r, updatedAt: _t, ...identity } = r, old = record.config.routes.find(v => v.id === r.id), revision = situationHash({ ...identity, endpoints: [config.locations.find(p => p.id === r.originId)!.revision, config.locations.find(p => p.id === r.destinationId)!.revision] }); return { ...r, revision, updatedAt: old?.revision === revision ? old.updatedAt : updatedAt }; });
      const oldConfig = record.config;
      const changedFlights = situationHash(oldConfig.trackedFlights) !== situationHash(config.trackedFlights);
      if (changedFlights || !config.flightsEnabled || oldConfig.carrierLogosEnabled !== config.carrierLogosEnabled) this.brandingFlightIds.clear();
      // Only current derived state is retired. Request receipts and persisted allowances are untouched.
      if (!config.flightsEnabled || changedFlights || oldConfig.defaultLocationId !== config.defaultLocationId ||
        oldConfig.locations.find(p => p.id === oldConfig.defaultLocationId)?.timezone !== config.locations.find(p => p.id === config.defaultLocationId)?.timezone) {
        this.flightAwareResult = null; this.flightAwareError = null;
        this.flightAwarePosition = null; this.flightAwarePositionError = null;
      }
      record.config = config;
      record.weather = record.weather.filter(w => config.locations.some(p => p.id === w.locationId && p.revision === w.locationRevision));
      record.traffic = [];
      record.conditions = record.conditions.filter(c => c.source === 'weather' && config.weatherEnabled && config.locations.some(p => p.id === c.sourceId && oldConfig.locations.some(old => old.id === p.id && old.revision === p.revision)));
      this.flightChanges.prune(config.trackedFlights, config.flightsEnabled, now);
      // Keep attempt timestamps for unchanged identities so toggles cannot reset cooldowns.
      const flightRevisions = new Set([
        ...config.locations.map(p => flightQueryRevision(p, config.trackedFlights)),
        ...config.trackedFlights.map(f => flightQueryRevision(undefined, config.trackedFlights, f.id)),
      ]);
      record.statuses = record.statuses.filter(s => s.source === 'weather' ? config.locations.some(p => p.revision === s.selectionRevision)
        : s.source === 'traffic' ? config.routes.some(r => r.revision === s.selectionRevision) : flightRevisions.has(s.selectionRevision ?? ''));
      if (!config.flightsEnabled || changedFlights || record.flights && !flightRevisions.has(record.flights.queryRevision)) record.flights = null;
      this.placeResults = [];
      await this.store.put(record); return this.snapshot();
    }
    if (command.action === 'save-traffic-key' || command.action === 'remove-traffic-key' || command.action === 'import-traffic-key') {
      if (command.action === 'save-traffic-key') await this.keys.save('tomtom', command.secret);
      else if (command.action === 'remove-traffic-key') await this.keys.remove('tomtom');
      else { if (!this.importKey) throw new AppError('unavailable', 'Key import is unavailable.'); await this.importKey(); }
      record.config.trafficEnabled = false; record.config.revision++; record.traffic = []; record.statuses = record.statuses.filter(s => s.source !== 'traffic'); record.conditions = record.conditions.filter(c => c.source !== 'traffic');
      await this.store.put(record); return this.snapshot();
    }
    if (command.action === 'snapshot') return this.snapshot(command.locationId, command.routeId);
    if (command.action === 'save-flightaware-key' || command.action === 'remove-flightaware-key') {
      if (command.action === 'save-flightaware-key') await this.keys.save('flightaware', command.secret);
      else await this.keys.remove('flightaware');
      this.flightAwareResult = null;
      this.flightAwareError = null;
      this.flightAwarePosition = null; this.flightAwarePositionError = null;
      this.flightChanges.reset(); this.operators.clear(); this.brandingFlightIds.clear();
      return this.snapshot();
    }
    const access = await this.access();
    if (!access.enabled) throw new AppError('permission_denied', 'Situation View is disabled in Settings.');
    if (!access.network) throw new AppError('permission_denied', 'Condition refresh is off for this review session.');
    if (access.weatherOnly && (command.action !== 'refresh' || command.source !== 'weather' || (command.locationId != null && command.locationId !== record.config.defaultLocationId))) throw new AppError('permission_denied', 'This review session permits only weather for the default saved place.');
    if (command.action === 'check-flightaware') {
      if (!record.config.flightsEnabled) throw new AppError('permission_denied', 'Flight data is disabled. Enable it in Configure view before checking a flight.');
      const day = Date.parse(command.departureDate + 'T00:00:00Z'), today = Date.parse(new Date(now).toISOString().slice(0, 10));
      if (Math.abs(day - today) > 86400000) throw new AppError('invalid_input', 'This coverage check supports today, yesterday or tomorrow only.');
      const month = new Date(now).toISOString().slice(0, 7), budget = record.flightAwareAccess;
      if (budget && now - Date.parse(budget.lastAttemptAt) < 60000) throw new AppError('unavailable', 'Wait one minute before another FlightAware check.');
      if (flightAwareSpent(budget, month) + 5 > flightAwareLimitMilliUSD(record.config)) throw new AppError('unavailable', 'The FlightAware monthly limit is reached. Review the limit in Situation Settings.');
      const key = await this.keys.read('flightaware');
      this.flightAwareResult = null;
      this.flightAwareError = null;
      this.flightAwarePosition = null; this.flightAwarePositionError = null;
      // Persist reservation before dispatch; failures/restarts/key replacement do not erase consumed requests.
      record.flightAwareAccess = { month, count: (budget?.month === month ? budget.count : 0) + 1, estimatedMilliUSD: flightAwareSpent(budget, month) + 5, lastAttemptAt: new Date(now).toISOString(), lastPositionAttemptAt: budget?.lastPositionAttemptAt };
      await this.store.put(record);
      try {
        const result = await this.request(record, 'flightaware', 'flight-status', () => this.flightAware.read(command.flightNumber, command.departureDate, key));
        const allowed = await this.access();
        if (!allowed.enabled || !allowed.network) throw new AppError('permission_denied', 'FlightAware results are no longer permitted in this session.');
        this.flightAwareResult = flightAwareResultSchema.parse(result);
      } catch (e) {
        if (e instanceof AppError) throw e;
        const code = e instanceof SituationProviderError ? e.code : 'response';
        throw new AppError('unavailable', code === 'authentication' ? 'FlightAware rejected the key or its access. Check your AeroAPI Personal subscription and protected key.' : code === 'rate-limit' ? 'FlightAware has limited requests. Wait before trying again.' : 'FlightAware could not be checked. The request was counted conservatively; check your connection or try later.');
      }
      return this.snapshot();
    }
    if (command.action === 'search-places') {
      const query = JSON.stringify([command.query, command.countryCode]);
      if (query === this.lastSearch.query && now - this.lastSearch.at < 300000) return this.snapshot();
      if (now - this.lastSearch.at < 2000) throw new AppError('unavailable', 'Wait a moment before searching again.');
      this.lastSearch = { query, at: now }; this.placeResults = [];
      try { this.placeResults = await this.request(record, 'open-meteo', 'geocoding', () => this.geocoder.search(command.query, command.countryCode)); }
      catch { this.lastSearch.query = ''; throw new AppError('unavailable', 'Places could not be found. Check your connection and try again.'); }
      const allowed = await this.access(); if (!allowed.enabled || !allowed.network) { this.placeResults = []; throw new AppError('permission_denied', 'Place search is no longer allowed.'); }
      return this.snapshot();
    }
    let view = await this.snapshot(command.locationId, command.routeId);
    const source = command.source, config = record.config;
    const place = config.locations.find(p => p.id === view.selectedLocationId), route = config.routes.find(r => r.id === view.selectedRouteId);
    if (source === 'weather' && (!config.weatherEnabled || !place)) throw new AppError('invalid_input', 'Choose a saved place and enable weather first.');
    if (source === 'traffic' && (!config.trafficEnabled || !route || view.trafficCredential !== 'configured')) throw new AppError('invalid_input', 'Add a traffic key and a route, then enable traffic in Settings.');
    if (source === 'flights' && !config.flightsEnabled) throw new AppError('invalid_input', 'Enable FlightAware tracking in Configure view first.');
    const selectedFlight = config.trackedFlights.find(f => f.id === command.flightId);
    const flightNumber = selectedFlight ? commercialFlightNumber(selectedFlight) : null;
    if (source === 'flights') {
      if (!selectedFlight || !flightNumber) throw new AppError('invalid_input', 'Choose a tracked IATA or ICAO flight number, such as KL897 or AHY071. Aircraft addresses and registrations are not supported by this flight lookup.');
      if (view.flightAware?.credential !== 'configured') throw new AppError('invalid_input', 'Connect FlightAware in Settings before refreshing flights.');
      const departureDate = departureDateFor(config, selectedFlight, now), cached = this.flightAwareResult;
      let statusAttempted = false;
      if (!cached || cached.flightNumber !== flightNumber || cached.departureDate !== departureDate || now - Date.parse(cached.checkedAt) >= 60000) {
        statusAttempted = true;
        try { await this.execute({ action: 'check-flightaware', flightNumber, departureDate }); }
        catch (e) { this.flightAwareError = { flightNumber, departureDate, at: new Date(now).toISOString(), detail: e instanceof AppError ? e.message : 'FlightAware could not be refreshed.' }; }
      }
      // The nested check reserves/accounted requests in the same serial command queue.
      const latest = await this.store.get(); record.requests = latest.requests; record.flightAwareAccess = latest.flightAwareAccess;
      view = await this.snapshot(command.locationId, command.routeId);
      const status = view.flightAware?.result;
      const match = status?.flightNumber === flightNumber && status.departureDate === departureDate && status.flights.length === 1 && !status.moreResults && now - Date.parse(status.checkedAt) < 60000 && !this.flightAwareError ? status.flights[0] : null;
      // Reused one-minute cache reads are not new observations or additional failed checks.
      if (statusAttempted && status && !this.flightAwareError) this.flightChanges.accept(selectedFlight, status, now);
      else if (statusAttempted && this.flightAwareError && !/Wait|limit|disabled|review/i.test(this.flightAwareError.detail)) this.flightChanges.unavailable(selectedFlight, now);
      if (match && !(this.flightAwarePosition?.flightId === match.id && now - Date.parse(this.flightAwarePosition.checkedAt) < 60000)) {
        this.flightAwarePosition = null; this.flightAwarePositionError = null;
        try {
          const month = new Date(now).toISOString().slice(0, 7), budget = record.flightAwareAccess;
          if (budget?.lastPositionAttemptAt && now - Date.parse(budget.lastPositionAttemptAt) < 60000) throw new AppError('unavailable', 'Wait one minute before refreshing the position again.');
          if (flightAwareSpent(budget, month) + 10 > flightAwareLimitMilliUSD(config)) throw new AppError('unavailable', 'The FlightAware monthly limit is reached. Review the limit in Situation Settings.');
          const key = await this.keys.read('flightaware');
          record.flightAwareAccess = { month, count: (budget?.month === month ? budget.count : 0) + 1, estimatedMilliUSD: flightAwareSpent(budget, month) + 10, lastAttemptAt: budget?.lastAttemptAt ?? new Date(now).toISOString(), lastPositionAttemptAt: new Date(now).toISOString() };
          await this.store.put(record);
          const position = await this.request(record, 'flightaware', 'aircraft', () => this.flightAware.position(match.id, key));
          const allowed = await this.access();
          if (!allowed.enabled || !allowed.network) throw new AppError('permission_denied', 'FlightAware results are no longer permitted in this session.');
          this.flightAwarePosition = flightAwarePositionSchema.parse(position);
        } catch (e) {
          this.flightAwarePositionError = e instanceof AppError ? e.message : e instanceof SituationProviderError && e.code === 'authentication' ? 'FlightAware position access was denied. Check your subscription.' : 'FlightAware could not return a position. Try again later.';
        }
      }
      if (match && config.carrierLogosEnabled && await this.keys.status('logodev') === 'configured') {
        await this.resolveCarrier(record, match, now);
        this.brandingFlightIds.add(match.id);
        const storedFlight = this.flightAwareResult?.flights.find(flight => flight.id === match.id);
        if (storedFlight) storedFlight.carrier = match.carrier;
      }
      // Use the verified FlightAware flight instance, never an assumed radio callsign.
      // FlightAware is the only flight source. Commercial results stay in memory.
      record.flights = null; await this.store.put(record);
      return this.snapshot(command.locationId, command.routeId);
    }
    const selectionRevision = source === 'weather' ? place!.revision : route!.revision;
    const priorData = source === 'weather' ? view.weather : null;
    if (priorData && freshnessState(priorData.freshness, now) === 'current') return view;
    const last = record.statuses.find(s => s.source === source && s.selectionRevision === selectionRevision), minimumMs = source === 'weather' ? 1800000 : 60000;
    // Traffic facts are intentionally absent from snapshots. A manual refresh must
    // not silently return that empty projection after navigation or a failed request.
    if (source !== 'traffic' && last?.lastAttemptAt && now - Date.parse(last.lastAttemptAt) < minimumMs) return view;
    const previous = structuredClone(record); let traffic: TrafficSnapshot | null = null;
    try {
      if (source === 'weather') {
        const weather = await this.request(record, 'open-meteo', 'weather', () => this.weather.read(place!));
        record.weather = [...record.weather.filter(w => w.locationId !== place!.id), weather];
      } else {
        const key = await this.keys.read('tomtom');
        traffic = await this.traffic.read(route!, config.locations.find(p => p.id === route!.originId)!, config.locations.find(p => p.id === route!.destinationId)!, key, (service, read) => this.request(record, 'tomtom', service, read));
        traffic.displayOnly = true;
      }
      const stillAllowed = await this.access(); if (!stillAllowed.enabled || !stillAllowed.network) throw new SituationProviderError('network');
      record.statuses = [...record.statuses.filter(s => s.source !== source || s.selectionRevision !== selectionRevision), { source, selectionRevision, provider: source === 'weather' ? this.weather.id : this.traffic.id, state: 'available', detail: 'Source refreshed.', lastAttemptAt: new Date(now).toISOString(), lastError: null }].slice(-21) as SituationProviderStatus[];
    } catch (e) {
      record.weather = previous.weather; record.flights = previous.flights; traffic = null;
      const code = e instanceof SituationProviderError ? e.code : 'response';
      record.statuses = [...record.statuses.filter(s => s.source !== source || s.selectionRevision !== selectionRevision), { source, selectionRevision, provider: source === 'weather' ? this.weather.id : this.traffic.id, state: 'error', detail: code === 'authentication' ? 'The source could not be connected. Review it in Settings.' : code === 'rate-limit' ? 'The source is busy. Wait before refreshing.' : 'The source could not be refreshed. Check your connection and try again later.', lastAttemptAt: new Date(now).toISOString(), lastError: code }].slice(-21) as SituationProviderStatus[];
    }
    record.traffic = []; record.conditions = deriveSituationConditions(previous, record, this.now()).filter(c => c.source !== 'traffic');
    await this.store.put(record);
    const result = await this.snapshot(command.locationId, command.routeId);
    if (traffic) { result.traffic = traffic; result.statuses = result.statuses.map(s => s.source === 'traffic' ? { ...s, state: traffic!.partial ? 'partial' : 'available', detail: 'Current route response. Refresh for a new estimate.' } : s); }
    return situationSnapshotSchema.parse(result);
  }
  private async resolveCarrier(record: SituationRecord, flight: FlightAwareResult['flights'][number], now: number) {
    const identity = flight.carrier;
    if (!identity?.icao || !this.flightAware.operator) return;
    const cached = this.operators.get(identity.icao);
    if (cached && cached.until > now) {
      if (cached.carrier && (!identity.iata || identity.iata === cached.carrier.iata)) flight.carrier = cached.carrier;
      return;
    }
    this.operators.set(identity.icao, { carrier: null, until: now + 600000 });
    try {
      const month = new Date(now).toISOString().slice(0, 7), budget = record.flightAwareAccess;
      if (flightAwareSpent(budget, month) + 15 > flightAwareLimitMilliUSD(record.config)) return;
      const key = await this.keys.read('flightaware');
      record.flightAwareAccess = { month, count: (budget?.month === month ? budget.count : 0) + 1, estimatedMilliUSD: flightAwareSpent(budget, month) + 15, lastAttemptAt: budget?.lastAttemptAt ?? new Date(now).toISOString(), lastPositionAttemptAt: budget?.lastPositionAttemptAt };
      await this.store.put(record);
      const carrier = await this.request(record, 'flightaware', 'operator', () => this.flightAware.operator!(identity.icao!, key));
      if (carrier.icao !== identity.icao || identity.iata && carrier.iata !== identity.iata || !carrier.name) return;
      const access = await this.access(); if (!access.enabled || !access.network) return;
      this.operators.set(identity.icao, { carrier, until: now + 86400000 });
      flight.carrier = carrier;
    } catch { /* Keep the carrier-code fallback; status and position remain usable. */ }
  }
}
