// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopApp } from '../src/desktop/Shell';
import { defaults, type DesktopBridge, type Snapshot } from '../src/shared/contracts';
import { emptyGoogle } from '../src/shared/google';
import { emptyWorkspace } from '../src/shared/assistant';
import { initialAgentState } from '../src/shared/orchestration';
import { emptySituationConfig, situationSnapshotSchema } from '../src/shared/situation';
import type { SituationDetailRequest } from '../src/desktop/situation/SituationDetails';

const data = situationSnapshotSchema.parse({ config: emptySituationConfig(), selectedLocationId: null, selectedRouteId: null, weather: null, traffic: null, flights: null, conditions: [], statuses: ['weather', 'traffic', 'flights'].map(source => ({ source, provider: 'isolated', state: 'empty', detail: '', lastAttemptAt: null, lastError: null })), trafficCredential: 'missing', protectionAvailable: true, reviewBlocked: false, usage: [], checkedAt: new Date().toISOString() });
vi.mock('../src/desktop/situation/SituationView', () => ({ SituationView: ({ details, settings }: { details(r: SituationDetailRequest): void; settings(): void }) => <><canvas aria-label="Retained map"/>{(['weather', 'traffic', 'flights'] as const).map(kind => <button key={kind} onClick={() => details({ kind, snapshot: data })}>{kind} detail</button>)}<button onClick={settings}>Configure view</button></> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([['weather', 2752], ['traffic', 1920], ['flights', 1280]] as const)('keeps one shell through %s ↔ MoMo while the collapsed preference write is pending at %spx', async (kind, width) => {
  location.hash = '#situation';
  HTMLElement.prototype.scrollTo = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.stubGlobal('ResizeObserver', class { constructor(private cb: ResizeObserverCallback) {} observe(target: Element) { this.cb([{ target, contentRect: { width, height: 1080 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} });
  const values = { ...defaults, assistantCollapsed: true, deepseekEnabled: true };
  const snapshot: Snapshot = { version: 'isolated', settings: { values, revision: 0 }, credentials: { openai: 'missing', deepseek: 'configured', minimax: 'missing', jev: 'missing' }, protectionAvailable: true, networkEnabled: false, aiRequestsEnabled: false, google: emptyGoogle, storage: 'ready' };
  let finish: (() => void) | undefined;
  const bridge = {
    getSnapshot: async () => ({ ok: true, value: snapshot }), onChanged: () => () => {},
    getWorkspace: async () => ({ ok: true, value: emptyWorkspace }), onWorkspaceChanged: () => () => {},
    agentCommand: vi.fn(async () => ({ ok: true, value: { state: initialAgentState(), runs: [] } })), onAgentChanged: () => () => {},
    situationCommand: vi.fn(async () => ({ ok: true, value: data })),
    calendarAction: vi.fn(async () => ({ ok: true, value: { actions: [], review: null } })),
    mailCommand: vi.fn(async () => ({ ok: true, value: { drafts: [], actions: [], thread: null, review: null } })),
    updateSettings: vi.fn(() => new Promise(resolve => { finish = () => resolve({ ok: true, value: { ...snapshot, settings: { values: { ...values, assistantCollapsed: false }, revision: 1 } } }); })),
    startRun: vi.fn(),
  } as unknown as DesktopBridge;
  render(<DesktopApp bridge={bridge}/>);
  fireEvent.click(await screen.findByText(kind + ' detail'));
  const shell = document.querySelector<HTMLElement>('.assistant-host')!, detail = document.querySelector<HTMLElement>('.situation-details')!, canvas = screen.getByLabelText('Retained map');
  detail.scrollTop = 127;
  fireEvent.click(screen.getByRole('button', { name: 'Mo', exact: true }));
  expect(shell.hidden).toBe(false); expect(shell.dataset.mode).toBe('assistant');
  expect(document.querySelector('.app-shell')?.classList.contains('assistant-collapsed')).toBe(false);
  const editor = screen.getByLabelText('Message Mo') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'Unsent continuity check' } });
  for (let i = 0; i < 5; i++) {
    fireEvent.click(screen.getByRole('button', { name: 'Details', exact: true }));
    expect(document.querySelector('.assistant-host')).toBe(shell); expect(shell.hidden).toBe(false);
    expect(document.querySelector('.situation-details')).toBe(detail); expect(detail.scrollTop).toBe(127);
    fireEvent.click(screen.getByRole('button', { name: 'Mo', exact: true }));
    expect(screen.getByLabelText('Message Mo')).toBe(editor); expect(editor.value).toBe('Unsent continuity check');
  }
  fireEvent.click(screen.getByRole('button', { name: 'Work', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Mo', exact: true }));
  expect(shell.hidden).toBe(false); expect(screen.getByLabelText('Retained map')).toBe(canvas);
  await act(async () => finish?.());
  // Testing Library deliberately exercises the wide and modal editor lifecycle without a browser layout engine.
  fireEvent.click(screen.getByRole('button', { name: 'Configure view', exact: true }));
  await screen.findByRole('heading', { name: 'Configure Situation View' });
  fireEvent.click(await screen.findByRole('button', { name: 'Add place', exact: true }));
  const inputs = document.querySelectorAll<HTMLInputElement>('.situation-configure input');
  const input = inputs[0]; fireEvent.change(input, { target: { value: 'Unsent place search' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mo', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Configure', exact: true }));
  expect(document.querySelector('.situation-configure input')).toBe(input); expect(input.value).toBe('Unsent place search');
  expect(vi.mocked(bridge.situationCommand!).mock.calls.every(([command]) => command.action === 'snapshot')).toBe(true);
  expect(bridge.startRun).not.toHaveBeenCalled();
});
