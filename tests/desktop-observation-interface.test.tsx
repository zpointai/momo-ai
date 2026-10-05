// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
// Isolated synthetic state only. These tests are not real Windows acceptance.
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopObservation, observationValue } from '../src/desktop/DesktopObservation';
import type { DesktopBridge } from '../src/shared/contracts';
import type { DesktopObservationCommand, DesktopObservationState, NodeObservation } from '../src/shared/desktop-observation';

const known = <T,>(value: T) => ({ state: 'known' as const, value });
const unsupported = { state: 'unsupported' as const };
const fixtureNode: NodeObservation = { id: 'n0', parentId: null, role: 'button', name: known('Synthetic safe control'), automationId: { state: 'redacted' }, className: { state: 'unknown' }, enabled: known(true), offscreen: known(false), keyboardFocusable: known(true), hasKeyboardFocus: known(false), readOnly: unsupported, selected: unsupported, toggle: unsupported, expansion: unsupported, bounds: { state: 'unavailable' }, patterns: known(['invoke']), protectedContent: known(false) };
const blank = (): DesktopObservationState => ({ capability: 'desktop.observe', enabled: true, status: 'AVAILABLE', reason: null, session: null, catalog: null, tree: null, diagnostics: [] });
function populated(): DesktopObservationState {
  const session = { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 300000).toISOString(), targetId: crypto.randomUUID() };
  return { ...blank(), session, tree: { version: 1, sessionId: session.id, targetId: session.targetId, requestId: crypto.randomUUID(), snapshotId: crypto.randomUUID(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15000).toISOString(), status: 'AVAILABLE', reasons: [], limitsHit: [], elapsedMs: 10, visitedNodes: 1, nodes: [fixtureNode], foreground: known(false), containsKeyboardFocus: known(false), focus: { state: 'outside-target' } } };
}
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
function setup(initial = blank(), enabled = true) {
  let current = initial;
  const call = vi.fn(async (command: DesktopObservationCommand) => {
    if (command.action === 'end' || command.action === 'cancel') current = blank();
    if (command.action === 'observe') current = { ...populated(), session: current.session };
    return { ok: true as const, value: current };
  });
  const bridge = { desktopObservation: call } as unknown as DesktopBridge, save = vi.fn(async () => true);
  const props = { bridge, active: true, enabled, revision: 12, saving: false, save };
  return { call, bridge, save, props, view: render(<DesktopObservation {...props}/>) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('starts no native work on mount, enablement or reactivation and saves permission against the revision', async () => {
  const h = setup(blank(), false); await settle();
  expect(h.call.mock.calls.every(([c]) => c.action === 'status')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Enable Desktop Observation' })); await settle();
  expect(h.save).toHaveBeenCalledWith({ desktopObservation: { enabled: true } }, 12);
  h.view.rerender(<DesktopObservation {...h.props} enabled={true} revision={13}/>); await settle();
  expect(h.call.mock.calls.some(([c]) => c.action === 'begin')).toBe(false);
});
it('clears mounted-but-inactive content and ends the session without restarting on return', async () => {
  const h = setup(populated()); await settle();
  expect(screen.getByText('Synthetic safe control')).toBeTruthy();
  h.view.rerender(<DesktopObservation {...h.props} active={false}/>); await settle();
  expect(screen.queryByText('Synthetic safe control')).toBeNull();
  expect(h.call.mock.calls.some(([c]) => c.action === 'end')).toBe(true);
  h.view.rerender(<DesktopObservation {...h.props}/>); await settle();
  expect(h.call.mock.calls.some(([c]) => c.action === 'begin')).toBe(false);
});
it('cancels pending begin on inactivity and discards a late session reply', async () => {
  const h = setup(); await settle();
  let answer!: (value: { ok: true; value: DesktopObservationState }) => void;
  h.call.mockImplementation(async command => command.action === 'begin' ? new Promise(resolve => { answer = resolve; }) : { ok: true, value: blank() });
  fireEvent.click(screen.getByRole('button', { name: 'Start observation' })); await settle();
  const begin = h.call.mock.calls.find(([c]) => c.action === 'begin')![0];
  h.view.rerender(<DesktopObservation {...h.props} active={false}/>); await settle();
  expect(h.call).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel', cancelRequestId: begin.requestId }));
  await act(async () => answer({ ok: true, value: populated() }));
  expect(screen.queryByText('Synthetic safe control')).toBeNull();
  expect(h.call.mock.calls.some(([c]) => c.action === 'end')).toBe(true);
});
it('expires the local tree even when status responses are delayed and never auto-observes', async () => {
  vi.useFakeTimers(); const h = setup(populated()); await settle();
  h.call.mockImplementation(() => new Promise(() => {}));
  await act(async () => { await vi.advanceTimersByTimeAsync(15250); });
  expect(screen.queryByText('Synthetic safe control')).toBeNull();
  expect(h.call.mock.calls.some(([c]) => c.action === 'observe')).toBe(false);
});
it('keeps missing-value states distinct and exposes capabilities only as text', async () => {
  for (const state of ['unknown', 'unsupported', 'unavailable', 'redacted'] as const) expect(observationValue({ state })).toBe(state[0].toUpperCase() + state.slice(1));
  setup(populated()); await settle();
  fireEvent.click(screen.getByRole('button', { name: /Synthetic safe control/ }));
  expect(screen.getByText('Capabilities (data only)')).toBeTruthy();
  expect(screen.getByText('invoke')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^invoke$/i })).toBeNull();
  expect(screen.getAllByText('Redacted').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Unsupported').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
});
it('ends and clears before saving revocation, including pending native work', async () => {
  const h = setup(populated()); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Disable Desktop Observation' })); await settle();
  expect(screen.queryByText('Synthetic safe control')).toBeNull();
  expect(h.save).toHaveBeenCalledWith({ desktopObservation: { enabled: false } }, 12);
  const endIndex = h.call.mock.calls.findIndex(([c]) => c.action === 'end');
  expect(h.call.mock.invocationCallOrder[endIndex]).toBeLessThan(h.save.mock.invocationCallOrder[0]);
});
