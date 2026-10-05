import { useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, CarFront, Clock3, CloudSun, MapPin, Plane, Plus, Search, Trash2 } from 'lucide-react';
import type { DesktopBridge } from '../../shared/contracts';
import { situationConfigSchema, sourceStateLabel, type PlaceResult, type SituationCommand, type SituationConfig, type SituationLocation, type CommuteRoute, type TimeZoneEntry, type TrackedFlight } from '../../shared/situation';
import { configurationIssue, placeRoutes } from '../../shared/situationLifecycle';
import { TimeZoneSelector } from '../TimeZoneSelector';
import { situationChanged, useSituation } from './useSituation';
import { TrackFlightForm } from './TrackFlightForm';
import './situation.css';

type Section = 'places' | 'routes' | 'zones' | 'flights' | 'layers' | null;
type Removal = { kind: 'place' | 'route' | 'zone' | 'flight'; id: string; label: string; revision: number };
const removeLabel = (kind: Removal['kind']) => ({ place: 'Remove place', route: 'Remove route', zone: 'Remove timezone', flight: 'Stop tracking' }[kind]);
function Row({ name, detail, children }: { name: string; detail?: string; children?: ReactNode }) {
  return <div className="situation-config-row"><span><strong>{name}</strong>{detail && <small>{detail}</small>}</span><div className="situation-row-actions">{children}</div></div>;
}
function FormActions({ cancel, label = 'Save changes' }: { cancel(): void; label?: string }) {
  return <div className="situation-row-actions"><button className="primary">{label}</button><button type="button" className="text-button" onClick={cancel}>Cancel</button></div>;
}
export function SituationConfigure({ bridge, active, settings }: { bridge: DesktopBridge; active: boolean; settings(): void }) {
  const { snapshot, setSnapshot, load, error: readError } = useSituation(bridge, active);
  const [section, setSection] = useState<Section>(null), [sectionRevision, setSectionRevision] = useState(0), [flightFormVisited, setFlightFormVisited] = useState(false);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [query, setQuery] = useState(''), [results, setResults] = useState<PlaceResult[]>([]), [searched, setSearched] = useState(false);
  const [placeEdit, setPlaceEdit] = useState<{ value: SituationLocation; revision: number }>();
  const [route, setRoute] = useState({ label: '', originId: '', destinationId: '' }), [routeEdit, setRouteEdit] = useState<{ value: CommuteRoute; revision: number }>();
  const [zone, setZone] = useState({ label: '', timezone: '' }), [zoneEdit, setZoneEdit] = useState<{ value: TimeZoneEntry; revision: number }>();
  const [flightEdit, setFlightEdit] = useState<{ value: TrackedFlight; revision: number }>(), [removal, setRemoval] = useState<Removal>();
  async function command(input: SituationCommand, message: string, selection?: { locationId?: string | null; routeId?: string | null }) {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await bridge.situationCommand?.(input);
      if (!result?.ok) {
        setError(result?.error.code === 'conflict' ? 'Saved settings changed elsewhere. Your inputs are kept. Cancel and reopen this edit to review the latest values.' : result?.error.message ?? 'Changes could not be saved. Try again.');
        if (result?.error.code === 'conflict') await load();
        return false;
      }
      setSnapshot(result.value); setNotice(message);
      if (input.action === 'search-places') { setResults(result.value.placeResults ?? []); setSearched(true); }
      else situationChanged(selection);
      return true;
    } catch { setError('The operation could not be confirmed. Reload your saved view and try again.'); return false; }
    finally { locked.current = false; setBusy(false); }
  }
  async function save(patch: Partial<SituationConfig>, message: string, revision = snapshot?.config.revision, selection?: { locationId?: string | null; routeId?: string | null }) {
    if (!snapshot || revision === undefined) return false;
    const parsed = situationConfigSchema.safeParse({ ...snapshot.config, ...patch });
    if (!parsed.success) { setError('Check labels, coordinates, time zones and route endpoints. Origin and destination must be different.'); return false; }
    const issue = configurationIssue(parsed.data, snapshot.config);
    if (issue) { setError(issue); return false; }
    return command({ action: 'configure', config: parsed.data, expectedRevision: revision }, message, selection);
  }
  if (!snapshot) return <div className="situation-configure"><h2>Configure Situation View</h2><p role="status">{readError || 'Opening your saved view…'}</p>{readError && <button className="secondary" onClick={() => void load()}>Try again</button>}</div>;
  const config = snapshot.config;
  const fa = snapshot.flightAware;
  const flightAwareState = !config.flightsEnabled ? 'Off' : fa?.credential === 'error' || fa?.error ? 'Unavailable' : fa?.credential !== 'configured' ? 'Not configured' : !fa.result ? 'Connected' : Date.now() - Date.parse(fa.result.checkedAt) >= 300000 ? 'Stale' : !fa.result.flights.length ? 'No observations' : 'Available';
  const toggle = (value: Section) => { setSection(v => v === value ? null : value); setSectionRevision(config.revision); if (value === 'flights') setFlightFormVisited(true); setError(''); setNotice(''); };
  const askRemove = (kind: Removal['kind'], id: string, label: string) => { setRemoval({ kind, id, label, revision: config.revision }); setError(''); };
  const confirmRemoval = async () => {
    if (!removal) return;
    const { kind, id, revision } = removal;
    if (kind === 'place' && placeRoutes(config, id).length) return;
    const patch: Partial<SituationConfig> = kind === 'flight' ? { trackedFlights: config.trackedFlights.filter(f => f.id !== id) }
      : kind === 'zone' ? { timezones: config.timezones.filter(z => z.id !== id) }
      : kind === 'route' ? { routes: config.routes.filter(r => r.id !== id), defaultRouteId: config.defaultRouteId === id ? null : config.defaultRouteId }
      : { locations: config.locations.filter(p => p.id !== id), defaultLocationId: config.defaultLocationId === id ? null : config.defaultLocationId };
    if (await save(patch, kind === 'flight' ? 'Tracking stopped. Request history is kept.' : `${removal.label} removed.`, revision)) {
      setRemoval(undefined);
      if (placeEdit?.value.id === id) setPlaceEdit(undefined);
      if (routeEdit?.value.id === id) setRouteEdit(undefined);
      if (zoneEdit?.value.id === id) setZoneEdit(undefined);
      if (flightEdit?.value.id === id) setFlightEdit(undefined);
    }
  };
  const removalView = (kind: Removal['kind'], id: string) => {
    if (removal?.kind !== kind || removal.id !== id) return null;
    const dependencies = kind === 'place' ? placeRoutes(config, id) : [];
    return <div className="situation-inline-confirm" role="group" aria-label={removeLabel(kind) + ' ' + removal.label}>
      {dependencies.length ? <><p>This place is used by {dependencies.map(r => r.label).join(', ')}. Change or remove {dependencies.length === 1 ? 'that route' : 'those routes'} first.</p><button className="text-button" onClick={() => setRemoval(undefined)}>Keep place</button></>
        : <><p>{removeLabel(kind)} {removal.label}?</p><div className="situation-row-actions"><button className="secondary" onClick={() => void confirmRemoval()}>{removeLabel(kind)}</button><button className="text-button" onClick={() => setRemoval(undefined)}>Cancel</button></div></>}
    </div>;
  };
  const addPlace = async (p: PlaceResult) => {
    if (config.locations.some(v => v.locality?.providerId === p.locality.providerId)) { setError('This locality is already saved. Edit its label or purpose instead.'); return; }
    const next = { ...p, id: crypto.randomUUID(), label: p.locality.name, purpose: '', revision: '', updatedAt: new Date().toISOString() };
    if (await save({ locations: [...config.locations, next], defaultLocationId: config.defaultLocationId ?? next.id }, 'Place saved.', sectionRevision)) { setResults([]); setQuery(''); setSearched(false); setSection(null); }
  };
  const moveZone = (index: number, delta: number) => { const zones = [...config.timezones]; [zones[index], zones[index + delta]] = [zones[index + delta], zones[index]]; void save({ timezones: zones }, 'Clock order saved.'); };
  const routeFields = (value: typeof route, change: (patch: Partial<typeof route>) => void) => <><label>Route name<input required maxLength={80} value={value.label} onChange={e => change({ label: e.target.value })}/></label>{(['originId', 'destinationId'] as const).map((field, i) => <label key={field}>{i ? 'Destination' : 'Origin'}<select required value={value[field]} onChange={e => change({ [field]: e.target.value })}><option value="">Choose a saved place</option>{config.locations.map(p => <option value={p.id} key={p.id}>{p.label}</option>)}</select></label>)}</>;
  const zoneFields = (value: typeof zone, change: (patch: Partial<typeof zone>) => void) => <><label>Clock label<input required maxLength={80} value={value.label} onChange={e => change({ label: e.target.value })}/></label><TimeZoneSelector saved={value.timezone} value={value.timezone} change={timezone => change({ timezone })} disabled={busy} invalid={false} commitLabel="Save"/></>;
  return <div className="situation-configure" aria-busy={busy}>
    <header><h2>Configure Situation View</h2><p>Your places, routes and a few useful clocks.</p><p>Save each edit here. Source data refreshes only when you ask.</p></header>
    {(error || readError) && <p className="banner error" role="alert">{error || readError}<button className="text-button" onClick={() => void load()}>Reload saved view</button></p>}{notice && <p role="status" className="situation-settings-notice">{notice}</p>}
    <fieldset disabled={busy}>
      <section aria-label="Places"><h3><MapPin size={17}/>Places</h3>
        {config.locations.map(p => <div key={p.id}><Row name={p.label} detail={[p.purpose ? `Purpose: ${p.purpose}` : '', p.locality ? `${p.locality.name}, ${p.locality.country}` : p.timezone].filter(Boolean).join(' · ')}>
          <button className="text-button" onClick={() => void save({ defaultLocationId: p.id }, 'Map focus updated.', config.revision, { locationId: p.id })}>{p.id === config.defaultLocationId ? 'Map focus' : 'Use'}</button>
          <button className="text-button" aria-label={'Edit place ' + p.label} onClick={() => setPlaceEdit({ value: { ...p }, revision: config.revision })}>Edit</button>
        </Row>{placeEdit?.value.id === p.id && <form className="situation-pane-form" aria-label={'Edit place ' + p.label} onSubmit={e => { e.preventDefault(); void save({ locations: config.locations.map(v => v.id === p.id ? placeEdit.value : v) }, 'Place saved.', placeEdit.revision).then(ok => { if (ok) setPlaceEdit(undefined); }); }}>
          <label>Place label<input required maxLength={80} value={placeEdit.value.label} onChange={e => setPlaceEdit({ ...placeEdit, value: { ...placeEdit.value, label: e.target.value } })}/></label>
          <label>Purpose (optional)<input maxLength={40} placeholder="Home, Work, or another purpose" value={placeEdit.value.purpose} onChange={e => setPlaceEdit({ ...placeEdit, value: { ...placeEdit.value, purpose: e.target.value } })}/></label><p>Purpose is your choice. It does not create another saved place.</p>
          <details className="situation-location-advanced"><summary>Location details</summary>{(['latitude', 'longitude'] as const).map(field => <label key={field}>{field === 'latitude' ? 'Latitude' : 'Longitude'}<input type="number" step="any" required min={field === 'latitude' ? -85 : -180} max={field === 'latitude' ? 85 : 180} value={Number.isNaN(placeEdit.value[field]) ? '' : placeEdit.value[field]} onChange={e => setPlaceEdit({ ...placeEdit, value: { ...placeEdit.value, [field]: e.target.valueAsNumber } })}/></label>)}<label>Place time zone (optional)<input value={placeEdit.value.timezone ?? ''} maxLength={80} onChange={e => setPlaceEdit({ ...placeEdit, value: { ...placeEdit.value, timezone: e.target.value || null } })}/></label><p>Changing coordinates clears the earlier locality lookup. No lookup is sent when saving.</p></details>
          <FormActions cancel={() => setPlaceEdit(undefined)}/><button type="button" className="text-button" onClick={() => askRemove('place', p.id, p.label)}>Remove place</button>
        </form>}{removalView('place', p.id)}</div>)}
        {!config.locations.length && <p>No saved places</p>}
        <button className="text-button" aria-expanded={section === 'places'} onClick={() => toggle('places')} disabled={config.locations.length >= 12}><Plus size={15}/>Add place</button>
        {section === 'places' && <form className="situation-pane-form" onSubmit={e => { e.preventDefault(); void command({ action: 'search-places', query }, ''); }}><label>City or locality<input autoFocus aria-label="Find a locality" value={query} minLength={3} maxLength={100} placeholder="City, country" onChange={e => { setQuery(e.target.value); setResults([]); setSearched(false); }}/></label><p>Search sends this place name to Open-Meteo. Select a result to save it.</p><button className="secondary" disabled={query.trim().length < 3 || snapshot.reviewBlocked}><Search size={15}/>Find place</button>{results.map(p => <button className="situation-place-result" type="button" key={p.locality.providerId} onClick={() => void addPlace(p)}><span><strong>{p.locality.name}</strong><small>{p.locality.country} · {p.timezone}</small></span><Plus size={16}/></button>)}{searched && !results.length && <p>No matching locality. Try the city and country.</p>}</form>}
      </section>
      <section aria-label="Commute"><h3><CarFront size={17}/>Commute</h3>
        {config.routes.map(r => <div key={r.id}><Row name={r.label} detail={`${config.locations.find(p => p.id === r.originId)?.label} → ${config.locations.find(p => p.id === r.destinationId)?.label}`}>
          <button className="text-button" onClick={() => void save({ defaultRouteId: r.id }, 'Route selected.', config.revision, { routeId: r.id })}>{r.id === config.defaultRouteId ? 'Use route' : 'Use'}</button><button className="text-button" aria-label={'Edit route ' + r.label} onClick={() => setRouteEdit({ value: { ...r }, revision: config.revision })}>Edit</button>
        </Row>{routeEdit?.value.id === r.id && <form className="situation-pane-form" aria-label={'Edit route ' + r.label} onSubmit={e => { e.preventDefault(); void save({ routes: config.routes.map(v => v.id === r.id ? routeEdit.value : v) }, 'Route saved. Refresh for a new estimate.', routeEdit.revision).then(ok => { if (ok) setRouteEdit(undefined); }); }}>{routeFields(routeEdit.value, patch => setRouteEdit({ ...routeEdit, value: { ...routeEdit.value, ...patch } }))}<FormActions cancel={() => setRouteEdit(undefined)}/><button type="button" className="text-button" onClick={() => askRemove('route', r.id, r.label)}>Remove route</button></form>}{removalView('route', r.id)}</div>)}
        {!config.routes.length && <p>No saved commute route</p>}
        <button className="text-button" aria-expanded={section === 'routes'} onClick={() => toggle('routes')} disabled={config.routes.length >= 8}><Plus size={15}/>Add route</button>
        {section === 'routes' && (config.locations.length < 2 ? <div className="situation-pane-form"><p>Add another place to create a commute route.</p><button className="text-button" onClick={() => toggle('places')}>Add place<ArrowRight size={14}/></button></div> : <form className="situation-pane-form" onSubmit={e => { e.preventDefault(); const r = { ...route, id: crypto.randomUUID(), revision: '', updatedAt: new Date().toISOString() }; void save({ routes: [...config.routes, r], defaultRouteId: config.defaultRouteId ?? r.id }, 'Route saved.', sectionRevision).then(ok => { if (ok) { setRoute({ label: '', originId: '', destinationId: '' }); setSection(null); } }); }}>{routeFields(route, patch => setRoute(v => ({ ...v, ...patch })))}<FormActions label="Save route" cancel={() => setSection(null)}/></form>)}
      </section>
      <section aria-label="Time zones"><h3><Clock3 size={17}/>Time zones<button className="text-button" aria-expanded={section === 'zones'} onClick={() => toggle('zones')}>Edit</button></h3>
        {config.timezones.map((z, index) => <div key={z.id}><Row name={z.label} detail={section === 'zones' ? z.timezone : undefined}>{section === 'zones' && <>
          <button className="icon-button" aria-label={'Move ' + z.label + ' up'} disabled={!index} onClick={() => moveZone(index, -1)}><ArrowUp size={15}/></button><button className="icon-button" aria-label={'Move ' + z.label + ' down'} disabled={index === config.timezones.length - 1} onClick={() => moveZone(index, 1)}><ArrowDown size={15}/></button>
          <button className="text-button" aria-label={'Edit clock ' + z.label} onClick={() => setZoneEdit({ value: { ...z }, revision: config.revision })}>Edit</button><button className="icon-button" aria-label={'Remove timezone ' + z.label} onClick={() => askRemove('zone', z.id, z.label)}><Trash2 size={15}/></button>
        </>}</Row>{section === 'zones' && zoneEdit?.value.id === z.id && <form className="situation-pane-form" aria-label={'Edit clock ' + z.label} onSubmit={e => { e.preventDefault(); void save({ timezones: config.timezones.map(v => v.id === z.id ? zoneEdit.value : v) }, 'Clock saved.', zoneEdit.revision).then(ok => { if (ok) { setZoneEdit(undefined); setSectionRevision(config.revision + 1); } }); }}>{zoneFields(zoneEdit.value, patch => setZoneEdit({ ...zoneEdit, value: { ...zoneEdit.value, ...patch } }))}<FormActions cancel={() => setZoneEdit(undefined)}/></form>}{removalView('zone', z.id)}</div>)}
        {!config.timezones.length && <p>No extra clocks</p>}
        {section === 'zones' && <><p>These clocks are saved separately from places. The first four appear in the overview.</p><form className="situation-pane-form" aria-label="Add a clock" onSubmit={e => { e.preventDefault(); void save({ timezones: [...config.timezones, { ...zone, id: crypto.randomUUID() }] }, 'Clock saved.', sectionRevision).then(ok => { if (ok) { setZone({ label: '', timezone: '' }); setSectionRevision(config.revision + 1); } }); }}>{zoneFields(zone, patch => setZone(v => ({ ...v, ...patch })))}<button className="secondary" disabled={config.timezones.length >= 8}>Add clock</button></form></>}
      </section>
      <section aria-label="Flights"><h3><Plane size={17}/>Flights</h3>
        {config.trackedFlights.map(f => <div key={f.id}><Row name={f.label} detail={`${f.identifier}${f.departureDate ? ' · ' + f.departureDate : ''}`}><button className="text-button" aria-label={'Edit tracking ' + f.label} onClick={() => setFlightEdit({ value: { ...f }, revision: config.revision })}>Edit</button><button className="text-button" aria-label={'Stop tracking ' + f.label} onClick={() => askRemove('flight', f.id, f.label)}>Stop tracking</button></Row>
          {flightEdit?.value.id === f.id && <form className="situation-pane-form" aria-label={'Edit tracking ' + f.label} onSubmit={e => { e.preventDefault(); const value = { ...flightEdit.value, label: flightEdit.value.label.trim() || f.identifier }; void save({ trackedFlights: config.trackedFlights.map(v => v.id === f.id ? value : v) }, 'Tracking updated.', flightEdit.revision).then(ok => { if (ok) setFlightEdit(undefined); }); }}><label>Label (optional)<input maxLength={80} value={flightEdit.value.label} onChange={e => setFlightEdit({ ...flightEdit, value: { ...flightEdit.value, label: e.target.value } })}/></label><p>{f.kind === 'callsign' ? 'Normalized callsign' : f.kind === 'icao' ? 'ICAO address' : 'Registration'}: {f.identifier}. To replace this identifier, stop tracking and track the correct flight.</p><FormActions cancel={() => setFlightEdit(undefined)}/></form>}{removalView('flight', f.id)}</div>)}
        {!config.trackedFlights.length && <p>No tracked flights</p>}<button className="text-button" aria-expanded={section === 'flights'} onClick={() => toggle('flights')} disabled={config.trackedFlights.length >= 8}><Plus size={15}/>Track flight</button>
        {flightFormVisited && <div hidden={section !== 'flights'}><TrackFlightForm full={config.trackedFlights.length >= 8} save={async flight => { const ok = await save({ trackedFlights: [...config.trackedFlights, flight] }, 'Flight saved. Use Refresh to check it.', sectionRevision); if (ok) { setSection(null); setFlightFormVisited(false); } return ok; }}/></div>}
      </section>
      <section aria-label="Data sources"><h3><CloudSun size={17}/>Data sources</h3>
        {snapshot.statuses.filter(s => s.source !== 'flights').map(s => <Row key={s.source} name={s.source === 'weather' ? 'Weather' : 'Traffic'} detail={s.source === 'traffic' ? `${snapshot.trafficCredential === 'configured' ? 'Key protected' : snapshot.trafficCredential === 'error' ? 'Protected key unavailable' : 'No protected key'} · ${config.routes.length ? 'Route saved' : 'No saved route'}` : 'Open-Meteo · no account needed'}><small>{sourceStateLabel(s.state)}</small></Row>)}
        <Row name="Flight status & position" detail="FlightAware · protected key managed in Settings"><small>{flightAwareState}</small></Row>
        <label className="situation-pane-toggle"><span>Weather<small>Enable manual weather refreshes</small></span><input type="checkbox" aria-label="Enable weather" checked={config.weatherEnabled} onChange={e => void save({ weatherEnabled: e.target.checked }, e.target.checked ? 'Weather enabled. Use Refresh to load it.' : 'Weather disabled.')}/></label>
        <label className="situation-pane-toggle"><span>Traffic<small>{snapshot.trafficCredential !== 'configured' ? 'Add a protected key in Settings first' : !config.routes.length ? 'Add a route before refreshing' : 'Manual refresh for your selected route'}</small></span><input type="checkbox" aria-label="Enable traffic" disabled={!config.trafficEnabled && snapshot.trafficCredential !== 'configured'} checked={config.trafficEnabled} onChange={e => void save({ trafficEnabled: e.target.checked }, e.target.checked ? 'Traffic enabled. Use Refresh for an estimate.' : 'Traffic disabled.')}/></label>
        <label className="situation-pane-toggle"><span>FlightAware tracking<small>Manual status and position updates for your tracked flights, within your spending limit.</small></span><input type="checkbox" checked={config.flightsEnabled} onChange={e => void save({ flightsEnabled: e.target.checked }, e.target.checked ? 'Flight data enabled. Use Refresh to load it.' : 'Flight data disabled. Protected keys are kept.')}/></label>
        <button className="text-button" onClick={settings}>Provider settings<ArrowRight size={14}/></button>
      </section>
      <section><button className="text-button" aria-expanded={section === 'layers'} onClick={() => toggle('layers')}>More layers<ArrowRight size={14}/></button>{section === 'layers' && <div className="situation-pane-form"><p>Saved places, weather and connected traffic or aircraft appear on the map when data is available.</p><p>Road incidents accompany a loaded traffic route. Satellite and weather radar are not connected.</p><label className="situation-pane-toggle">Online basemap<input type="checkbox" checked={config.mapEnabled} onChange={e => void save({ mapEnabled: e.target.checked }, 'Map preference saved.')}/></label></div>}</section>
    </fieldset><footer><button className="text-button" onClick={settings}>All Situation View settings<ArrowRight size={14}/></button></footer>
  </div>;
}
