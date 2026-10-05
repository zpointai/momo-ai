// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { normalizeFlightInput } from '../src/shared/flightIdentifiers';
import { TrackFlightForm } from '../src/desktop/situation/TrackFlightForm';
import { normalizeAircraft, AvioAircraft } from '../electron/situation/providers';
import { commercialFlightNumber } from '../src/shared/flightAware';
afterEach(cleanup);
it.each(['W6 4513', 'W64513'])('normalizes %s without a required label', input => { expect(normalizeFlightInput(input)).toEqual({ kind: 'callsign', identifier: 'WZZ4513', label: 'W6 4513' }); });
it.each([['WZZ4513', 'callsign'], ['HA-LXH', 'registration'], ['N123AB', 'registration'], ['4CA123', 'icao']])('detects %s as %s', (input, kind) => { expect(normalizeFlightInput(input).kind).toBe(kind); });
it.each(['ABC', 'AB1234', '12', '123456789012345', '??'])('rejects ambiguous or invalid %s', input => { expect(() => normalizeFlightInput(input)).toThrow('recognize'); });
it('accepts other commercial designators without inventing an ICAO airline alias', () => {
  expect(normalizeFlightInput('KL 1234')).toEqual({ kind: 'callsign', identifier: 'KL1234', label: 'KL 1234' });
  expect(normalizeFlightInput('KL1234', 'callsign').identifier).toBe('KL1234');
});
it.each([['AHY071','AHY71'],['KL 897','KL897'],['BA 123','BA123'],['LH 400','LH400']])('saves %s with its FlightAware designator and explicit date', async(input,number)=>{
  const save=vi.fn(async()=>true);render(<TrackFlightForm full={false} save={save}/>);
  fireEvent.change(screen.getByLabelText('Flight number'),{target:{value:input}});fireEvent.change(screen.getByLabelText('Departure date (optional)'),{target:{value:'2026-09-29'}});fireEvent.click(screen.getByRole('button',{name:'Track flight'}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({flightNumber:number,departureDate:'2026-09-29'})));
});
it('routes a legacy ICAO designator by its identifier, never a label or aircraft address',()=>{
  const saved={id:crypto.randomUUID(),kind:'callsign' as const,identifier:'AHY071',label:'My flight'};expect(commercialFlightNumber(saved)).toBe('AHY71');
  expect(commercialFlightNumber({...saved,identifier:'GHOST',label:'AHY071'})).toBeNull();expect(commercialFlightNumber({...saved,kind:'icao',identifier:'ABC123',label:'AHY071'})).toBeNull();expect(commercialFlightNumber({...saved,kind:'registration',identifier:'N123AB'})).toBeNull();
});
it('saves through the ordinary one-field flight form and keeps advanced terminology secondary', async () => {
  const save = vi.fn(async () => true); render(<TrackFlightForm full={false} save={save}/>);
  fireEvent.change(screen.getByLabelText('Flight number'), { target: { value: 'W6 4513' } });
  expect((screen.getByLabelText('Label (optional)') as HTMLInputElement).required).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Track flight' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ label: 'W64513', identifier: 'W64513', flightNumber: 'W64513', kind: 'callsign' })));
});
it('admits an observed tracked aircraft, drops stale positions, retains an empty response and invents no flight schedule', async () => {
  const now = Date.now(), flight = { id: crypto.randomUUID(), ...normalizeFlightInput('W6 4513') };
  const raw = { now, ac: [{ hex: '4ca123', flight: 'WZZ4513', r: 'HA-LXH', lat: 51, lon: 4, seen_pos: 1, alt_baro: 20000, gs: 300, track: 30 }] };
  const live = normalizeAircraft(raw, [flight], now);
  expect(live.aircraft[0]).toMatchObject({ trackedId: flight.id, origin: null, destination: null, headingDegrees: 30 });
  expect(normalizeAircraft({ ...raw, now: now - 180000 }, [flight], now).aircraft).toEqual([]);
  const get = vi.fn(async () => ({ now, ac: [] })); const empty = await new AvioAircraft({ get }).read(undefined, [flight], flight.id);
  expect(empty.aircraft).toEqual([]); expect(get).toHaveBeenCalledOnce(); expect((get.mock.calls[0] as unknown as [URL])[0].pathname).toBe('/v1/callsign/WZZ4513');
  expect(JSON.stringify(empty)).not.toMatch(/Eindhoven|Varna|arrival|departure|gate|cancel/);
  const registration = { id: crypto.randomUUID(), ...normalizeFlightInput('HA-LXH') };
  expect(normalizeAircraft(raw, [registration], now).aircraft[0].trackedId).toBe(registration.id);
  await new AvioAircraft({ get }).read(undefined, [registration], registration.id);
  expect((get.mock.calls[1] as unknown as [URL])[0].pathname).toBe('/v1/reg/HA-LXH');
});
