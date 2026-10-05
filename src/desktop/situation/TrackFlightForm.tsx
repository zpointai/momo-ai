import { useState } from 'react';
import { normalizeFlightInput } from '../../shared/flightIdentifiers';
import { commercialFlightNumber } from '../../shared/flightAware';
import type { TrackedFlight } from '../../shared/situation';

export function TrackFlightForm({ save, full }: { save(flight: TrackedFlight): Promise<boolean>; full: boolean }) {
  const [date, setDate] = useState('');
  const [input, setInput] = useState(''), [label, setLabel] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <form className="situation-pane-form" aria-label="Track a flight" onSubmit={async e => {
    e.preventDefault(); if (busy) return; setError('');
    try { const normalized = normalizeFlightInput(input, 'callsign'); setBusy(true); const tracking = { ...normalized, id: crypto.randomUUID() }, number = commercialFlightNumber(tracking); if (!number) throw new Error('Enter an IATA or ICAO flight number, such as KL897 or AHY071.'); await save({ ...tracking, label: label.trim() || normalized.label, ...(number ? { flightNumber: number, ...(date ? { departureDate: date } : {}) } : {}) }); }
    catch (e) { setError(e instanceof Error ? e.message : 'The flight could not be saved. Try again.'); }
    finally { setBusy(false); }
  }}>
    <label>Flight number<input autoFocus required maxLength={20} placeholder="W6 4513" value={input} onChange={e => { setInput(e.target.value); setError(''); }}/></label>
    <p>Use an IATA or ICAO flight number, such as KL897 or AHY071. FlightAware supplies status and position when available.</p>
    <label>Departure date (optional)<input type="date" value={date} onChange={e => setDate(e.target.value)}/></label><p>Blank follows today in your default place’s time zone. Use the departure airport’s date for a specific flight.</p>
    <details className="situation-flight-advanced"><summary>Advanced</summary><label>Label (optional)<input maxLength={80} value={label} onChange={e => setLabel(e.target.value)}/></label></details>
    {error && <p role="alert">{error}</p>}<button className="primary" disabled={full || busy}>{busy ? 'Saving…' : 'Track flight'}</button>
  </form>;
}
