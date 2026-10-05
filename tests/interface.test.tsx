// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { emptyGoogle } from '../src/shared/google';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act,cleanup, fireEvent, render, screen, waitFor,within } from '@testing-library/react';
import { DesktopApp } from '../src/desktop/App';
import { defaults, type DesktopBridge, type Snapshot } from '../src/shared/contracts';
import { initialAgentState } from '../src/shared/orchestration';
import { emptyWorkspace } from '../src/shared/assistant';
// jsdom has no layout engine or ResizeObserver. Supply the explicit test viewport;
// native window captures, not this harness, verify actual pane measurement.
class ViewportResizeObserver implements ResizeObserver {
  constructor(private callback:ResizeObserverCallback) {}
  observe(target:Element) { this.callback([{target,contentRect:DOMRect.fromRect({width:window.innerWidth,height:window.innerHeight}),borderBoxSize:[],contentBoxSize:[],devicePixelContentBoxSize:[]}],this); }
  unobserve() {}
  disconnect() {}
}
beforeEach(()=>{location.hash='';Object.defineProperty(window,'innerWidth',{value:1366,writable:true});vi.stubGlobal('ResizeObserver',ViewportResizeObserver);HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};HTMLElement.prototype.scrollTo=()=>{};HTMLElement.prototype.scrollIntoView=()=>{};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function fixture() {
  let snapshot: Snapshot = { version: 'test', settings: { values: defaults, revision: 0 }, credentials: {openai:'missing',  deepseek: 'missing', minimax: 'missing', jev: 'missing' }, protectionAvailable: true, networkEnabled: false, aiRequestsEnabled: false, google: emptyGoogle, storage: 'ready' };
  const listeners = new Set<(value: Snapshot) => void>();
  const bridge: DesktopBridge = {
    agentCommand:vi.fn(async()=>({ok:true,value:{state:initialAgentState(),runs:[]}})),onAgentChanged:()=>()=>{},
    calendarAction:vi.fn(async()=>({ok:true,value:{actions:[],review:null}})),
    mailCommand:vi.fn(async()=>({ok:true,value:{drafts:[],actions:[],thread:null,review:null}})),
    taskReceipt:vi.fn(async id=>({ok:true,value:{id,existed:false,task:null}})),
    clearConversation:vi.fn(async()=>({ok:true,value:emptyWorkspace})),
    saveCredential: vi.fn(async () => ({ ok:true, value:snapshot })),
    getWorkspace: vi.fn(async () => ({ok:true,value:emptyWorkspace})),
    startRun: vi.fn(async () => ({ok:false,error:{code:'unavailable',message:'Enable provider first'}})),
    cancelRun: vi.fn(async () => ({ok:true,value:emptyWorkspace})),
    taskCommand: vi.fn(async () => ({ok:true,value:emptyWorkspace})),
    onWorkspaceChanged: () => () => undefined,
    getSnapshot: vi.fn(async () => ({ ok: true, value: snapshot })),
    updateSettings: vi.fn(async input => { if(input.expectedRevision!==snapshot.settings.revision)return{ok:false,error:{code:'conflict',message:'Settings changed elsewhere.'}};snapshot = { ...snapshot, settings: { values: { ...snapshot.settings.values, ...input.patch }, revision: snapshot.settings.revision + 1 } }; listeners.forEach(listener => listener(snapshot)); return { ok: true, value: snapshot }; }),
    importCredential: vi.fn(async () => ({ ok: false, error: { code: 'cancelled', message: 'Cancelled' } })),
    removeCredential: vi.fn(async () => ({ ok: false, error: { code: 'cancelled', message: 'Cancelled' } })),
    googleCommand: vi.fn(async () => ({ ok: true, value: snapshot })),
    readInbox: vi.fn(async () => ({ ok: false, error: { code: 'unavailable', message: 'Connect Google' } })),
    readMessage: vi.fn(async () => ({ ok: false, error: { code: 'unavailable', message: 'Connect Google' } })),
    readCalendar: vi.fn(async () => ({ ok: false, error: { code: 'unavailable', message: 'Connect Google' } })),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { bridge, listeners,externalPreferences:(patch:Partial<Snapshot['settings']['values']>)=>{snapshot={...snapshot,settings:{revision:snapshot.settings.revision+1,values:{...snapshot.settings.values,...patch}}};} };
}
it('refreshes a stale panel preference once without reverting other settings or accepting older notifications',async()=>{
 const f=fixture();render(<DesktopApp bridge={f.bridge}/>);const button=await screen.findByRole('button',{name:'Collapse navigation'});const before=await f.bridge.getSnapshot();if(!before.ok)throw new Error('Fixture snapshot missing');
 f.externalPreferences({timezone:'Asia/Tokyo'});fireEvent.click(button);await screen.findByRole('button',{name:'Expand navigation'});expect(f.bridge.updateSettings).toHaveBeenCalledTimes(2);expect(f.bridge.updateSettings).toHaveBeenLastCalledWith({patch:{sidebarCollapsed:true},expectedRevision:1});
 const current=await f.bridge.getSnapshot();expect(current.ok&&current.value.settings.values.timezone).toBe('Asia/Tokyo');expect(screen.queryByRole('alert')).toBeNull();
 act(()=>f.listeners.forEach(listener=>listener(before.value)));expect(screen.getByRole('button',{name:'Expand navigation'})).toBeTruthy();
});
it('opens without accounts/keys, navigates truthfully and keeps a single subscription in StrictMode', async () => {
  const { bridge, listeners } = fixture();
  const view = render(<StrictMode><DesktopApp bridge={bridge}/></StrictMode>);
  await screen.findByRole('heading',{name:'Your day, in focus.'});
  expect(listeners.size).toBe(1);
  expect((screen.getByLabelText('Message Mo') as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Inbox', exact: true }));
  expect(screen.getByText('Google is not connected')).toBeTruthy();
  expect(bridge.importCredential).not.toHaveBeenCalled();
  view.unmount(); expect(listeners.size).toBe(0);
});
it('retains the assistant editor and activity details when switching the single workpane without dispatch',async()=>{
 const {bridge}=fixture();const original=bridge.getSnapshot;bridge.getSnapshot=async()=>{const result=await original();if(!result.ok)return result;return{ok:true,value:{...result.value,credentials:{...result.value.credentials,deepseek:'configured'},settings:{...result.value.settings,values:{...result.value.settings.values,deepseekEnabled:true}}}};};
 render(<DesktopApp bridge={bridge}/>);await screen.findByRole('heading',{name:'Your day, in focus.'});const editor=screen.getByLabelText('Message Mo') as HTMLTextAreaElement;fireEvent.change(editor,{target:{value:'Isolated unsent editor check'}});
 fireEvent.click(screen.getByRole('button',{name:'Work & approvals',exact:true}));await screen.findByRole('heading',{name:'Work',exact:true});fireEvent.click(screen.getByRole('button',{name:'History',exact:true}));expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Mo',exact:true}));expect(screen.getByLabelText('Message Mo')).toBe(editor);expect(editor.value).toBe('Isolated unsent editor check');expect(bridge.startRun).not.toHaveBeenCalled();expect(vi.mocked(bridge.agentCommand).mock.calls.every(([command])=>command.action!=='start')).toBe(true);
});
it('persists the collapsed navigation preference and preserves accessible navigation', async () => {
  const {bridge}=fixture();render(<DesktopApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Collapse navigation'}));
  await waitFor(()=>expect(bridge.updateSettings).toHaveBeenCalledWith({patch:{sidebarCollapsed:true},expectedRevision:0}));
  expect(await screen.findByRole('button',{name:'Expand navigation'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Inbox',exact:true}));expect(screen.getByText('Google is not connected')).toBeTruthy();
});
it('uses a masked write-only key field and clears it immediately after submission', async () => {
  const {bridge}=fixture();render(<DesktopApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Settings',exact:true}));fireEvent.click(screen.getByRole('button',{name:'AI & usage',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Providers',exact:true}));fireEvent.click(screen.getByText('Save or replace DeepSeek key'));
  const key=screen.getByLabelText('DeepSeek API key') as HTMLInputElement;
  expect(key.type).toBe('password');fireEvent.change(key,{target:{value:'synthetic-credential'}});
  fireEvent.submit(key.closest('form')!);
  await waitFor(()=>expect(bridge.saveCredential).toHaveBeenCalledWith({provider:'deepseek',secret:'synthetic-credential'}));
  expect(key.value).toBe('');expect(bridge.startRun).not.toHaveBeenCalled();
});
it('saves a local preference through the typed service', async () => {
  const { bridge } = fixture(); render(<DesktopApp bridge={bridge}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Settings',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Appearance & layout',exact:true}));
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'light' } });
  await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ patch: { theme: 'light' }, expectedRevision: 0 }));
  expect(await screen.findByText('Preferences saved.')).toBeTruthy();
});

it('stores, replaces and removes OpenAI through a cleared masked field without enabling or testing a model',async()=>{
 const {bridge}=fixture();
 bridge.saveCredential=vi.fn(async()=>{const r=await bridge.getSnapshot();if(!r.ok)return r;return{ok:true,value:{...r.value,credentials:{...r.value.credentials,openai:'configured'}}};});
 bridge.removeCredential=vi.fn(async()=>bridge.getSnapshot());
 render(<DesktopApp bridge={bridge}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Settings',exact:true}));fireEvent.click(screen.getByRole('button',{name:'AI & usage',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Providers',exact:true}));
 expect(screen.getByText('GPT-6 Luna · optional Mo Executive')).toBeTruthy();
 expect(screen.getByText('Save or replace OpenAI key').closest('details')!.open).toBe(false);
 fireEvent.click(screen.getByText('Save or replace OpenAI key'));
 const input=screen.getByLabelText('OpenAI API key') as HTMLInputElement;
 expect(input.type).toBe('password');expect(input.autocomplete).toBe('off');
 for(const secret of ['SYNTHETIC_OPENAI_INPUT_001','SYNTHETIC_OPENAI_INPUT_002']){
   fireEvent.change(input,{target:{value:secret}});fireEvent.submit(input.closest('form')!);expect(input.value).toBe('');
   await waitFor(()=>expect(bridge.saveCredential).toHaveBeenLastCalledWith({provider:'openai',secret}));
   await screen.findByText('API access not tested in this app');
   expect(screen.getByRole('combobox',{name:'Mo Executive model'})).toHaveProperty('value','deepseek-flash');
 }
 expect(screen.queryByRole('checkbox',{name:'Enable OpenAI requests'})).toBeNull();expect(screen.getByRole('button',{name:/Test OpenAI/})).toBeTruthy();
 fireEvent.click(within(document.querySelector('[data-provider="openai"]') as HTMLElement).getByRole('button',{name:'Remove key',exact:true}));await waitFor(()=>expect(bridge.removeCredential).toHaveBeenCalledWith('openai'));
 expect(bridge.updateSettings).not.toHaveBeenCalled();expect(bridge.startRun).not.toHaveBeenCalled();expect(bridge.importCredential).not.toHaveBeenCalled();
 expect(vi.mocked(bridge.agentCommand).mock.calls.every(([command])=>command.action!=='start')).toBe(true);
});

it('keeps unsaved Settings edits across sections and workspaces, then cancels without a write',async()=>{
 const {bridge}=fixture();render(<DesktopApp bridge={bridge}/>);fireEvent.click(await screen.findByRole('button',{name:'Settings',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Appearance & layout',exact:true}));
 const field=screen.getByLabelText('Time zone') as HTMLInputElement;fireEvent.change(field,{target:{value:'Asia/Tokyo'}});
 fireEvent.click(screen.getByRole('button',{name:'Privacy & data',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Appearance & layout',exact:true}));expect(field.value).toBe('Asia/Tokyo');
 fireEvent.click(screen.getByRole('button',{name:'Dashboard',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Settings',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Appearance & layout',exact:true}));expect((screen.getByLabelText('Time zone') as HTMLInputElement).value).toBe('Asia/Tokyo');
 fireEvent.click(screen.getByRole('button',{name:'Cancel edits',exact:true}));expect(field.value).toBe(defaults.timezone);expect(bridge.updateSettings).not.toHaveBeenCalled();
});
it('validates a grouped timezone and refuses a stale revision without overwriting saved values',async()=>{
 const f=fixture();render(<DesktopApp bridge={f.bridge}/>);fireEvent.click(await screen.findByRole('button',{name:'Settings',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Appearance & layout',exact:true}));
 const field=screen.getByLabelText('Time zone') as HTMLInputElement;fireEvent.change(field,{target:{value:'Invalid/Zone'}});fireEvent.submit(field.closest('form')!);expect(screen.getByRole('alert').textContent).toContain('valid IANA');expect(f.bridge.updateSettings).not.toHaveBeenCalled();
 fireEvent.change(field,{target:{value:'Asia/Tokyo'}});f.externalPreferences({timezone:'Europe/London'});const latest=await f.bridge.getSnapshot();if(!latest.ok)throw Error();act(()=>f.listeners.forEach(fn=>fn(latest.value)));
 expect(field.value).toBe('Asia/Tokyo');expect((screen.getByRole('button',{name:'Apply time zone'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.submit(field.closest('form')!);expect(f.bridge.updateSettings).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Cancel edits'}));expect(field.value).toBe('Europe/London');
 fireEvent.change(field,{target:{value:'Asia/Tokyo'}});fireEvent.submit(field.closest('form')!);await waitFor(()=>expect(f.bridge.updateSettings).toHaveBeenCalledWith({patch:{timezone:'Asia/Tokyo'},expectedRevision:1}));await screen.findByText('Preferences saved.');
});
it('searches only static Settings descriptions and focuses the real control without provider or source calls',async()=>{
 location.hash='#settings/overview';const {bridge}=fixture();render(<DesktopApp bridge={bridge}/>);const search=await screen.findByRole('searchbox',{name:'Search settings'});
 fireEvent.change(search,{target:{value:'timezone'}});fireEvent.click(screen.getByRole('button',{name:/Time zone.*IANA/}));expect(document.activeElement).toBe(screen.getByLabelText('Time zone'));
 fireEvent.change(search,{target:{value:'key credentials'}});fireEvent.click(screen.getByRole('button',{name:/DeepSeek access/}));expect(document.activeElement?.closest('[data-provider]')?.getAttribute('data-provider')).toBe('deepseek');
 for(const fn of [bridge.startRun,bridge.readInbox,bridge.readMessage,bridge.readCalendar,bridge.googleCommand,bridge.updateSettings,bridge.saveCredential])expect(fn).not.toHaveBeenCalled();
 expect((bridge.agentCommand as ReturnType<typeof vi.fn>).mock.calls.every(([c])=>c.action==='snapshot')).toBe(true);
});
it('keeps the recommended preset a preview until explicit application',async()=>{
 location.hash='#settings/ai/limits';const {bridge}=fixture();render(<DesktopApp bridge={bridge}/>);fireEvent.click(await screen.findByRole('button',{name:/Preview recommended limits/}));expect(screen.getByRole('region',{name:'Recommended limits preview'})).toBeTruthy();expect(bridge.updateSettings).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Cancel preview'}));expect(screen.queryByRole('region',{name:'Recommended limits preview'})).toBeNull();expect(bridge.updateSettings).not.toHaveBeenCalled();
});
