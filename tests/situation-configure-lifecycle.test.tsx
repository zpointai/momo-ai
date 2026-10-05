// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SituationConfigure } from '../src/desktop/situation/SituationConfigure';
import { reconcileSituationDetail } from '../src/desktop/situation/SituationDetails';
import { SituationService } from '../electron/situation/service';
import { SituationStore } from '../electron/situation/store';
import { emptySituationConfig, type SituationConfig } from '../src/shared/situation';
import type { DesktopBridge } from '../src/shared/contracts';
import { situationChanged, retainCurrentTraffic } from '../src/desktop/situation/useSituation';

afterEach(cleanup);
async function fixture() {
  HTMLElement.prototype.scrollIntoView = () => {};
  const store = new SituationStore(), at = new Date().toISOString();
  const p = { id: crypto.randomUUID(), label: 'Fixture Home', purpose: 'Home', latitude: 51.8, longitude: 4.6, timezone: 'Europe/Amsterdam', revision: '', updatedAt: at }, q = { ...p, id: crypto.randomUUID(), label: 'Fixture Work', purpose: 'Work', longitude: 4.7 };
  const r = { id: crypto.randomUUID(), label: 'Fixture commute', originId: p.id, destinationId: q.id, revision: '', updatedAt: at }, f = { id: crypto.randomUUID(), label: 'W6 4513', kind: 'callsign' as const, identifier: 'WZZ4513' };
  const keys = { available: () => true, status: vi.fn(async () => 'configured' as const), read: vi.fn(), save: vi.fn(), remove: vi.fn() };
  const service = new SituationService(store, keys, async () => ({ enabled: true, network: false }));
  const initial = await service.command({ action: 'configure', expectedRevision: 0, config: { ...emptySituationConfig(), locations: [p, q], defaultLocationId: p.id, routes: [r], defaultRouteId: r.id, trackedFlights: [f], flightsEnabled: true, timezones: [{ id: crypto.randomUUID(), label: 'Amsterdam', timezone: 'Europe/Amsterdam' }, { id: crypto.randomUUID(), label: 'Tokyo', timezone: 'Asia/Tokyo' }] } });
  const command = vi.fn(async input => { try { return { ok: true, value: await service.command(input) }; } catch (error) { return { ok: false, error: { code: (error as { code: string }).code, message: (error as Error).message } }; } });
  const bridge = { situationCommand: command } as unknown as DesktopBridge;
  const view = render(<SituationConfigure bridge={bridge} active settings={vi.fn()}/>);
  await screen.findByRole('heading', { name: 'Configure Situation View' });
  const current = async () => (await service.snapshot()).config;
  const mutate = async (patch: Partial<SituationConfig>) => { const config = await current(); const result = await service.command({ action: 'configure', config: { ...config, ...patch }, expectedRevision: config.revision }); act(() => { situationChanged(); }); return result; };
  return { service, initial, current, mutate, command, bridge, view, keys, p, q, r, f };
}
it('exposes Stop tracking, cancels safely, then confirms the exact record removal without any provider command', async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole('button', { name: 'Stop tracking W6 4513' }));
  const confirm = () => within(screen.getByRole('group', { name: 'Stop tracking W6 4513' }));
  fireEvent.click(confirm().getByRole('button', { name: 'Cancel' })); expect((await f.current()).trackedFlights).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Stop tracking W6 4513' })); fireEvent.click(confirm().getByRole('button', { name: 'Stop tracking', exact: true }));
  await screen.findByText('No tracked flights'); expect((await f.current()).trackedFlights).toEqual([]);
  expect(f.command.mock.calls.every(([c]) => ['configure', 'snapshot'].includes(c.action))).toBe(true); expect(f.keys.read).not.toHaveBeenCalled();
});
it('edits the optional label while keeping the normalized identifier and makes replacement instructions explicit', async () => {
  const f = await fixture(); fireEvent.click(screen.getByRole('button', { name: 'Edit tracking W6 4513' }));
  const form = screen.getByRole('form', { name: 'Edit tracking W6 4513' });
  expect(form.textContent).toContain('Normalized callsign: WZZ4513'); expect(form.textContent).toContain('stop tracking and track the correct flight');
  fireEvent.change(within(form).getByLabelText('Label (optional)'), { target: { value: 'Family arrival' } }); fireEvent.submit(form);
  await screen.findByText('Tracking updated.'); expect((await f.current()).trackedFlights[0]).toMatchObject({ id: f.f.id, identifier: 'WZZ4513', label: 'Family arrival' });
});
it('blocks a dependent place, preserves explicit purpose, and removes it only after its route is removed', async () => {
  const f = await fixture(); fireEvent.click(screen.getByRole('button', { name: 'Edit place Fixture Home' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove place', exact: true }));
  const block = screen.getByRole('group', { name: 'Remove place Fixture Home' }); expect(block.textContent).toContain('Fixture commute'); expect(within(block).queryByRole('button', { name: 'Remove place', exact: true })).toBeNull();
  expect((await f.current()).locations).toHaveLength(2);
  fireEvent.click(within(block).getByRole('button', { name: 'Keep place' }));
  const form = screen.getByRole('form', { name: 'Edit place Fixture Home' });
  fireEvent.change(within(form).getByLabelText('Purpose (optional)'), { target: { value: '' } }); fireEvent.submit(form);
  await screen.findByText('Place saved.'); expect((await f.current()).locations[0].purpose).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Edit route Fixture commute' })); fireEvent.click(screen.getByRole('button', { name: 'Remove route', exact: true }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Remove route Fixture commute' })).getByRole('button', { name: 'Remove route', exact: true }));
  await screen.findByText('No saved commute route'); expect((await f.current()).locations).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Edit place Fixture Home' })); fireEvent.click(screen.getByRole('button', { name: 'Remove place', exact: true }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Remove place Fixture Home' })).getByRole('button', { name: 'Remove place', exact: true }));
  await screen.findByText('Fixture Home removed.'); expect((await f.current()).defaultLocationId).toBeNull(); expect((await f.current()).locations.map(p => p.id)).toEqual([f.q.id]);
});
it('replaces route endpoints and label atomically with a new route revision', async () => {
  const f = await fixture(); fireEvent.click(screen.getByRole('button', { name: 'Edit route Fixture commute' }));
  const form = screen.getByRole('form', { name: 'Edit route Fixture commute' });
  fireEvent.change(within(form).getByLabelText('Route name'), { target: { value: 'Return' } }); fireEvent.change(within(form).getByLabelText('Origin'), { target: { value: f.q.id } }); fireEvent.change(within(form).getByLabelText('Destination'), { target: { value: f.p.id } }); fireEvent.submit(form);
  await screen.findByText('Route saved. Refresh for a new estimate.'); const next = (await f.current()).routes[0]; expect(next).toMatchObject({ id: f.r.id, label: 'Return', originId: f.q.id, destinationId: f.p.id }); expect(next.revision).not.toBe(f.initial.config.routes[0].revision);
});
it('reorders, edits, prevents duplicate clocks, and removes the last clock without touching places', async () => {
  const f = await fixture(), zones = within(screen.getByRole('region', { name: 'Time zones' })); fireEvent.click(zones.getByRole('button', { name: 'Edit', exact: true }));
  fireEvent.click(zones.getByRole('button', { name: 'Move Tokyo up' })); await screen.findByText('Clock order saved.'); expect((await f.current()).timezones[0].label).toBe('Tokyo');
  fireEvent.click(zones.getByRole('button', { name: 'Edit clock Tokyo' })); const form = zones.getByRole('form', { name: 'Edit clock Tokyo' });
  fireEvent.change(within(form).getByLabelText('Time zone', { exact: true }), { target: { value: 'Europe/Amsterdam' } }); fireEvent.submit(form); await screen.findByText('This time zone already has a clock. Edit the existing clock instead.');
  fireEvent.change(within(form).getByLabelText('Time zone', { exact: true }), { target: { value: 'America/New_York' } }); fireEvent.change(within(form).getByLabelText('Clock label'), { target: { value: 'New York' } }); fireEvent.submit(form); await screen.findByText('Clock saved.');
  for (const name of ['New York', 'Amsterdam']) { fireEvent.click(zones.getByRole('button', { name: 'Remove timezone ' + name })); fireEvent.click(within(screen.getByRole('group', { name: 'Remove timezone ' + name })).getByRole('button', { name: 'Remove timezone', exact: true })); await screen.findByText(name + ' removed.'); }
  expect(zones.getByText('No extra clocks')).toBeTruthy(); expect((await f.current()).locations).toEqual(f.initial.config.locations);
});
it('rejects a stale editor rather than overwriting a newer change, keeping its unsaved inputs', async () => {
  const f = await fixture(); fireEvent.click(screen.getByRole('button', { name: 'Edit tracking W6 4513' }));
  const form = screen.getByRole('form', { name: 'Edit tracking W6 4513' }); fireEvent.change(within(form).getByLabelText('Label (optional)'), { target: { value: 'Unsent draft' } });
  await f.mutate({ weatherEnabled: false }); await waitFor(() => expect((screen.getByLabelText('Enable weather') as HTMLInputElement).checked).toBe(false)); fireEvent.submit(form);
  await screen.findByText(/Saved settings changed elsewhere/); expect((within(form).getByLabelText('Label (optional)') as HTMLInputElement).value).toBe('Unsent draft');
  const current = await f.current(); expect(current.weatherEnabled).toBe(false); expect(current.trackedFlights[0].label).toBe('W6 4513');
});
it('keeps flight entry inputs, section and scroll through temporary workpane activity', async () => {
  const f = await fixture(); fireEvent.click(screen.getByRole('button', { name: 'Track flight', exact: true }));
  const input = screen.getByLabelText('Flight number'); fireEvent.change(input, { target: { value: 'KL 897' } }); const pane = document.querySelector('.situation-configure')!; pane.scrollTop = 450;
  f.view.rerender(<SituationConfigure bridge={f.bridge} active={false} settings={vi.fn()}/>); f.view.rerender(<SituationConfigure bridge={f.bridge} active settings={vi.fn()}/>);
  expect(screen.getByLabelText('Flight number')).toBe(input); expect((input as HTMLInputElement).value).toBe('KL 897'); expect(pane.scrollTop).toBe(450);
  expect(f.command.mock.calls.every(([c]) => c.action === 'snapshot')).toBe(true);
});
it('updates source controls immediately while keeping credentials and avoiding source requests', async () => {
  const f = await fixture(); fireEvent.click(screen.getByLabelText('Enable traffic')); await screen.findByText('Traffic enabled. Use Refresh for an estimate.');
  fireEvent.click(screen.getByLabelText('Enable traffic')); await screen.findByText('Traffic disabled.');
  const source = screen.getByRole('region', { name: 'Data sources' }); expect(source.textContent).toContain('Key protected'); expect(source.textContent).toContain('Flight status & position');
  expect((await f.current()).trafficEnabled).toBe(false); expect(f.keys.remove).not.toHaveBeenCalled(); expect(f.keys.read).not.toHaveBeenCalled();
});
it('retires selected detail requests and display-only traffic when their saved identity disappears', async () => {
  const f = await fixture(), initial = f.initial;
  const next = { ...initial, config: { ...initial.config, routes: [], locations: [], trackedFlights: [] }, selectedLocationId: null, selectedRouteId: null };
  expect(reconcileSituationDetail({ kind: 'flights', snapshot: initial, flightId: f.f.id }, next)).toBeNull();
  expect(reconcileSituationDetail({ kind: 'traffic', snapshot: initial }, next)).toBeNull(); expect(reconcileSituationDetail({ kind: 'weather', snapshot: initial }, next)).toBeNull();
  const traffic = { routeId: f.r.id, routeRevision: initial.config.routes[0].revision, displayOnly: true, freshness: { freshUntil: new Date(Date.now() + 60000).toISOString() } } as NonNullable<typeof initial.traffic>;
  expect(retainCurrentTraffic({ ...initial, traffic }, next).traffic).toBeNull();
  const changed = { ...initial, config: { ...initial.config, routes: [{ ...initial.config.routes[0], revision: 'changed' }] } }; expect(retainCurrentTraffic({ ...initial, traffic }, changed).traffic).toBeNull();
});
