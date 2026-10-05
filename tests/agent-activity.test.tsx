// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityDrawer } from '../src/desktop/ActivityPanel';
import type { ComponentProps } from 'react';

it('renders useful specialist history and owner approval without leaking provider diagnostics or context chatter', () => {
  const at = '2026-09-27T09:00:00.000Z';
  // UI-only isolated fixture; never injected into an application profile or capture.
  const run = { id: 'run', event: { family: 'task', accountId: 'accountA', prompt: 'Check my calendar' }, createdAt: at, finishedAt: at, status: 'complete', checkpoint: 'Complete', result: { text: 'A proposal is ready.', draft: null }, proposals: [], findings: [], context: { items: [], limitations: [] }, error: null, calendarProposalId: 'proposal', calls: [{ provider: 'jev', reportedModel: 'PRIVATE_PROVIDER_CANARY', status: 'complete' }], team: { specialistId: 'planner', items: [{ id: 'root', role: 'executive', sources: [], status: 'complete', reason: null }, { id: 'planner', role: 'planner', sources: [], status: 'complete', reason: null }, { id: 'context', role: 'context', sources: [], status: 'complete', reason: 'PRIVATE_CONTEXT_CHATTER' }], ledger: { passed: true, semantic: 'flags' } } };
  const props = { snapshot: { google: { activeAccountId: 'accountA' } }, bridge: {}, controller: { workspace: { runs: [] } }, orchestration: { data: { runs: [run], state: { feedback: [] } }, busy: false }, review: () => {}, openSource: () => {}, openCalendar: () => {}, openConversation: () => {}, recover: () => {} } as unknown as ComponentProps<typeof ActivityDrawer>;
  const html = renderToStaticMarkup(<ActivityDrawer {...props} />);
  expect(html).toContain('Work history · Planner'); expect(html).toContain('Check my calendar'); expect(html).toContain('0 sources'); expect(html).toContain('Calendar proposal awaits owner approval.'); expect(html).toContain('Additional review signals raised concerns'); expect(html).toContain('Review Calendar proposal');
  expect(html).not.toContain('PRIVATE_PROVIDER_CANARY'); expect(html).not.toContain('PRIVATE_CONTEXT_CHATTER'); expect(html).not.toContain('Jev');
});
