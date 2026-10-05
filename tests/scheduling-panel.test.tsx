// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SchedulingPanel } from '../src/desktop/SchedulingPanel';
import type { OrchestrationController } from '../src/desktop/OrchestrationViews';
import { initialAgentState, type AgentRun } from '../src/shared/orchestration';
import type { MailThread } from '../src/shared/mail';
afterEach(cleanup);
const message = { id: 'message1', threadId: 'thread1', subject: 'Isolated scheduling fixture', from: 'sender@example.test', to: 'owner@example.test', snippet: 'Could we meet?', unread: true, receivedAt: '2026-09-29T08:00:00Z' };
const thread: MailThread = { id: message.threadId, accountId: 'test', fetchedAt: message.receivedAt, revision: 'a'.repeat(64), truncated: false, messages: [{ message, text: message.snippet, textAvailable: true, truncated: false, attachments: [], headers: { replyTo: message.from, cc: '', messageId: '<message1@example.test>', references: '' }, labels: [] }] };
function props(runs: AgentRun[] = []) {
 return { accountId: 'test', message, thread, timezone: 'Europe/Amsterdam', controller: { data: { state: initialAgentState(), runs }, busy: false, command: vi.fn(async () => {}) } as unknown as OrchestrationController, blocked: '', openDraft: vi.fn(), openSource: vi.fn() };
}
function held(): AgentRun {
 return { id: 'held-task', event: { scheduling: { threadId: thread.id, threadRevision: thread.revision }, accountId: 'test', resourceId: message.id }, status: 'review', scheduling: { version: 1, phase: 'needs-information', inbox: { schema: 'inbox-scheduling-v1', intent: 'arrange', sourceId: 'M1', quote: message.snippet, scope: null, basis: 'source', uncertainty: ['Confirm the search window.'] }, planner: null, draftHash: null, contextHistory: [] }, error: 'Confirm the search window.' } as AgentRun;
}
it('starts from the exact selected message and thread through the existing native workflow command', () => {
 const p = props(); render(<SchedulingPanel {...p}/>); fireEvent.click(screen.getByRole('button', { name: 'MoMo scheduling' })); fireEvent.click(screen.getByRole('button', { name: 'Check scheduling request' }));
 expect(p.controller.command).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', event: expect.objectContaining({ accountId: 'test', resourceId: message.id, scheduling: { threadId: thread.id, threadRevision: thread.revision } }) }));
});
it('continues the same task after explicit owner clarification, with no assumed date or duration', () => {
 const p = props([held()]); render(<SchedulingPanel {...p}/>); fireEvent.click(screen.getByRole('button', { name: 'Confirm scheduling details' }));
 expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe(''); expect((screen.getByLabelText('Duration in minutes') as HTMLInputElement).value).toBe('');
 for (const [name, value] of [['Date', '2026-10-01'], ['From', '09:00'], ['Until', '12:00'], ['Duration in minutes', '30']]) fireEvent.change(screen.getByLabelText(name), { target: { value } });
 fireEvent.click(screen.getByRole('button', { name: 'Check confirmed window' }));
 expect(p.controller.command).toHaveBeenCalledWith({ action: 'continueScheduling', id: 'held-task', confirmed: { intent: 'arrange', scope: { date: '2026-10-01', from: '09:00', to: '12:00', durationMinutes: 30, timezone: 'Europe/Amsterdam' } } });
});
it('does not offer clarification against a changed thread', () => {
 const p = props([held()]); render(<SchedulingPanel {...p} thread={{ ...thread, revision: 'b'.repeat(64) }}/>);
 expect(screen.queryByRole('button', { name: 'Confirm scheduling details' })).toBeNull(); expect(screen.getByRole('alert').textContent).toContain('thread changed');
});
it('keeps policy blocks visible and prevents a new dispatch', () => {
 const p = props(); render(<SchedulingPanel {...p} blocked="Planner is disabled."/>); fireEvent.click(screen.getByRole('button', { name: 'MoMo scheduling' }));
 expect((screen.getByRole('button', { name: 'Check scheduling request' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByText('Planner is disabled.')).toBeTruthy();
});
it('offers explicit replanning and preserves the old draft when a replacement is ready',()=>{
 const run=held();run.status='complete';run.localDraftId='old-draft';run.scheduling!.phase='awaiting-owner';run.scheduling!.draftStale=true;run.scheduling!.replacementPending=true;run.result={text:'Updated facts',draft:'New proposed wording.',evidence:['M1'],reminders:[]};
 const p=props([run]);render(<SchedulingPanel {...p}/>);expect(screen.getByText(/Earlier proposed times are stale/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Open preserved draft'}));expect(p.openDraft).toHaveBeenCalledWith('old-draft');fireEvent.click(screen.getByRole('button',{name:'Prepare as a new local reply'}));expect(p.controller.command).toHaveBeenCalledWith({action:'useReplannedReply',id:run.id});fireEvent.click(screen.getByRole('button',{name:'Replan from current thread'}));expect(p.controller.command).toHaveBeenCalledWith({action:'replanScheduling',id:run.id});
});
it('opens a separate calendar action in Planner and does not approve through Inbox',()=>{
 const run=held();run.calendarProposalId='calendar-action';run.scheduling!.calendarDelivery={actionId:'calendar-action',state:'pending',approvedAt:null};const openCalendar=vi.fn();render(<SchedulingPanel {...props([run])} openCalendar={openCalendar}/>);fireEvent.click(screen.getByRole('button',{name:'Review update in Planner'}));expect(openCalendar).toHaveBeenCalledWith('calendar-action');expect(screen.queryByRole('button',{name:/Approve & update/})).toBeNull();expect(screen.getByText(/Email and calendar approvals are separate/)).toBeTruthy();
});
