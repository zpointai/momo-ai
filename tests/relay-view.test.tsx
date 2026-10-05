// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RelayView, RelaySettings, type RelayController } from '../src/desktop/RelayView';
import type { RelayReceipt } from '../src/shared/relay';
afterEach(cleanup);
function fixture(receipts: RelayReceipt[] = []) {
  const relay: RelayController = { data: { connection: 'not-configured', provider: 'twilio', lastSync: null, receipts, responsibilities: [], totalReceipts: receipts.length }, error: '', busy: false, command: vi.fn(async () => true), refresh: vi.fn(async () => {}) };
  return { relay, tasks: [], accountId: null, active: true, detailHost: document.createElement('div'), details: vi.fn(), activity: vi.fn(), settings: vi.fn(), workflowSettings: vi.fn(), openSource: vi.fn() };
}
it('shows a top-level empty workspace with no invented contacts, connection, delivery or Send control', () => {
  render(<RelayView {...fixture()}/>); expect(screen.getByRole('heading', { name: 'Relay', exact: true })).toBeTruthy(); expect(screen.getAllByText('Needs setup').length).toBeGreaterThan(0); expect(screen.getByText('No recent communications')).toBeTruthy(); expect(screen.queryByRole('button', { name: /^send/i })).toBeNull(); expect(screen.queryByText(/James Smith|health|Last sync/)).toBeNull();
});
it('labels a synthetic event, retains selection through filtering and uses the shared Details action', () => {
  const receipt = { id: crypto.randomUUID(), event: { sender: 'SYNTHETIC sender', content: 'SYNTHETIC update', channel: 'sms', provider: 'synthetic' }, receivedAt: new Date().toISOString(), disposition: 'held', reason: 'unknown-sender', rootRunId: null, synthetic: true, timeline: [], draft: null } as RelayReceipt;
  const p = fixture([receipt]); render(<RelayView {...p}/>); fireEvent.click(screen.getByRole('button', { name: /SYNTHETIC sender/ })); expect(screen.getByText('SYNTHETIC ISOLATED ACCEPTANCE')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Queued', exact: true })); expect(screen.getByText('SYNTHETIC ISOLATED ACCEPTANCE')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Details', exact: true })); expect(p.details).toHaveBeenCalled();
});
it('keeps provider readiness factual and secrets out of renderer input', () => {
  render(<RelaySettings/>); expect(screen.getByText('Twilio · selected')).toBeTruthy(); expect(screen.getByText('Unavailable — setup required')).toBeTruthy(); expect([...document.querySelectorAll('.relay-settings-disclosure')].every(d=>!d.hasAttribute('open'))).toBe(true); for (const summary of document.querySelectorAll('.relay-settings-disclosure')) summary.setAttribute('open',''); expect(screen.getAllByRole('textbox').length).toBe(6); expect(document.querySelector('input[type=password]')).toBeNull(); expect(screen.getByRole('button', {name:'Authorize live sending…'}).hasAttribute('disabled')).toBe(true);
});
