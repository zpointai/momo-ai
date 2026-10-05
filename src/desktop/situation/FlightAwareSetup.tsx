import { useRef, useState } from 'react';
import { Plane } from 'lucide-react';
import type { SituationCommand, SituationSnapshot } from '../../shared/situation';
import { flightNumberSchema, flightDateSchema } from '../../shared/flightAware';

export function FlightAwareSetup({ snapshot, busy, dirty, command }: {
  snapshot: SituationSnapshot; busy: boolean; dirty: boolean;
  command(input: SituationCommand, notice: string): Promise<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null), [hasKey, setHasKey] = useState(false), [remove, setRemove] = useState(false);
  const [number, setNumber] = useState(() => snapshot.config.trackedFlights.map(f => f.label).find(v => flightNumberSchema.safeParse(v).success) ?? '');
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  const [limit, setLimit] = useState(String((snapshot.config.flightAwareMonthlyLimitCents ?? 400) / 100));
  const limitCents = Math.round(Number(limit) * 100), validLimit = limit.trim() !== '' && Number.isFinite(limitCents) && limitCents >= 0 && limitCents <= 400;
  const state = snapshot.flightAware, credential = state?.credential ?? 'missing', blocked = busy || dirty;
  const validNumber = flightNumberSchema.safeParse(number), validDate = flightDateSchema.safeParse(date);
  const result = state?.result, changedQuery = result && (result.flightNumber !== (validNumber.success ? validNumber.data : '') || result.departureDate !== date);
  const time = (v: string | null, zone: string | null) => {
    if (!v) return 'Not supplied';
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone ?? 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(v)); }
    catch { return new Date(v).toISOString(); }
  };
  return <section className="settings-card" aria-label="FlightAware setup">
    <h2><Plane size={18}/>FlightAware · status & position</h2>
    <p>Refresh a tracked flight in Situation View to retrieve its status and latest position. Saving a key makes no request.</p>
    <p role="status">{credential === 'configured' ? 'FlightAware key protected on this computer.' : credential === 'error' ? 'Protected FlightAware key unavailable. Save a working key again.' : 'Awaiting your FlightAware AeroAPI key.'}</p>
    <details className="situation-add-editor"><summary>Manage protected FlightAware key</summary>
      <label>API key<input type="password" aria-label="FlightAware API key" autoComplete="new-password" spellCheck={false} maxLength={2048} ref={input} onChange={e => setHasKey(!!e.target.value.trim())}/></label>
      <div className="situation-key-actions"><button className="secondary" type="button" disabled={blocked || !snapshot.protectionAvailable || !hasKey} onClick={() => {
        const secret = input.current?.value.trim() ?? ''; if (input.current) input.current.value = ''; setHasKey(false);
        void command({ action: 'save-flightaware-key', secret }, 'FlightAware key protected. No request sent.');
      }}>Protect FlightAware key</button>{credential !== 'missing' && <button className="text-button" type="button" disabled={blocked} onClick={() => setRemove(true)}>Remove FlightAware key</button>}</div>
      {remove && <div><p>Remove the protected FlightAware key from this computer?</p><button className="secondary" type="button" disabled={blocked} onClick={() => { setRemove(false); void command({ action: 'remove-flightaware-key' }, 'FlightAware key removed.'); }}>Confirm removal</button><button className="text-button" type="button" onClick={() => setRemove(false)}>Keep key</button></div>}
    </details>
    <div className="situation-form-grid">
      <label>Flight number<input aria-label="FlightAware flight number" placeholder="W6 4513" value={number} maxLength={12} onChange={e => setNumber(e.target.value)}/></label>
      <label>Departure date<input type="date" aria-label="FlightAware departure date" value={date} onChange={e => setDate(e.target.value)}/></label>
    </div>
    <p>Choose today, yesterday or tomorrow, using the departure airport’s local date.</p>
    <button className="secondary" type="button" disabled={blocked || !snapshot.config.flightsEnabled || snapshot.reviewBlocked || credential !== 'configured' || !validNumber.success || !validDate.success || (state?.estimatedMilliUSD ?? (state?.requests ?? 0) * 5) + 5 > (state?.limitMilliUSD ?? 4000)} onClick={() => {
      if (validNumber.success && validDate.success) void command({ action: 'check-flightaware', flightNumber: validNumber.data, departureDate: validDate.data }, 'FlightAware coverage check finished. Review the result below.');
    }}>{busy ? 'Working…' : 'Check flight · 1 request'}</button>
    {dirty && <p>Apply or cancel your other Situation edits before managing this connection.</p>}
    {!snapshot.config.flightsEnabled && <p>Flight data is off. Enable FlightAware tracking in Configure view to allow manual checks.</p>}
    {snapshot.reviewBlocked && <p>Provider requests are disabled for this review session.</p>}
    <p><small>{state?.requests ?? 0} requests this UTC month · estimated ${((state?.estimatedMilliUSD ?? (state?.requests ?? 0) * 5) / 1000).toFixed(3)} of ${((state?.limitMilliUSD ?? 4000) / 1000).toFixed(2)}. One status lookup is $0.005; one position lookup is $0.010 before credits. A full Refresh is up to $0.015. Failed attempts count. No automatic refresh.</small></p>
    <label>MoMo monthly limit (USD)<input type="number" min="0" max="4" step="0.01" value={limit} onChange={e => setLimit(e.target.value)}/></label>
    <button type="button" className="secondary" disabled={blocked || !validLimit || limitCents === (snapshot.config.flightAwareMonthlyLimitCents ?? 400)} onClick={() => void command({ action: 'configure', expectedRevision: snapshot.config.revision, config: { ...snapshot.config, flightAwareMonthlyLimitCents: limitCents } }, 'FlightAware limit saved. No request sent.')}>Save monthly limit</button>
    <p>MoMo cannot see usage elsewhere on your FlightAware account or guarantee that free credit remains. The limit applies to this MoMo profile.</p>
    {result && <div role="status" aria-label="FlightAware coverage result">
      <h3>{result.flightNumber} · {result.departureDate}</h3><p>Checked {new Date(result.checkedAt).toLocaleString()}{changedQuery ? ' · previous query; check again for the edited flight or date' : ''}</p>
      {!result.flights.length && <p>{result.returnedCount ? 'FlightAware returned records, but none could be verified against this flight number and departure date.' : 'FlightAware returned no flight records for this query.'} This does not establish whether the flight departed.</p>}
      {result.flights.map(f => <details className="situation-add-editor" key={f.id} open><summary>{f.origin ?? 'Origin unavailable'} → {f.destination ?? 'Destination unavailable'}</summary>
        <p><strong>{f.status ?? 'Status not supplied'}</strong> · {f.flightNumber}</p>
        <dl>
          <dt>Registration</dt><dd>{f.registration ?? 'Not supplied'}</dd><dt>ATC callsign</dt><dd>{f.callsign ?? 'Not supplied'}</dd><dt>Aircraft type</dt><dd>{f.equipment ?? 'Not supplied'}</dd>
          <dt>Scheduled gate departure</dt><dd>{time(f.scheduledOut, f.originTimezone)}</dd><dt>Estimated gate departure</dt><dd>{time(f.estimatedOut, f.originTimezone)}</dd>
          <dt>Actual gate departure</dt><dd>{time(f.actualOut, f.originTimezone)}</dd><dt>Actual takeoff</dt><dd>{time(f.actualOff, f.originTimezone)}</dd>
          <dt>Scheduled gate arrival</dt><dd>{time(f.scheduledIn, f.destinationTimezone)}</dd><dt>Estimated gate arrival</dt><dd>{time(f.estimatedIn, f.destinationTimezone)}</dd>
          <dt>Actual landing</dt><dd>{time(f.actualOn, f.destinationTimezone)}</dd><dt>Actual gate arrival</dt><dd>{time(f.actualIn, f.destinationTimezone)}</dd>
        </dl>
      </details>)}
      {result.moreResults && <p>The response has more pages. This check reads only the first page to bound usage.</p>}
      <small>Source: FlightAware AeroAPI · airport local times · point-in-time check, retained in memory for up to 15 minutes.</small>
    </div>}
  </section>;
}
