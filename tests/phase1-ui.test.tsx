// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {useOrchestration,type OrchestrationController} from '../src/desktop/OrchestrationViews';
import {UsageSettings} from '../src/desktop/UsageSettings';
import {DashboardUsage} from '../src/desktop/DashboardUsage';
import {ActivityDrawer} from '../src/desktop/ActivityPanel';
import {defaults,type DesktopBridge,type Snapshot} from '../src/shared/contracts';
import {initialAgentState,type AgentSnapshot} from '../src/shared/orchestration';
import {emptyWorkspace} from '../src/shared/assistant';
import {emptyGoogle} from '../src/shared/google';
import type {AssistantController} from '../src/desktop/AssistantViews';
import {seedRates,type BudgetBoundary,type Costs} from '../src/shared/usage';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();});
const snapshot:Snapshot={version:'test',settings:{values:defaults,revision:0},credentials: {openai:'missing', deepseek:'missing',jev:'missing',minimax:'missing'},protectionAvailable:true,networkEnabled:false,aiRequestsEnabled:false,storage:'ready',google:{...emptyGoogle,activeAccountId:'accountA'}};
const blank:AgentSnapshot={state:initialAgentState(),runs:[]};
it('refreshes local usage on focus and UTC rollover, and removes both listeners on unmount',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T23:59:59.000Z'));
 const command=vi.fn(async()=>({ok:true,value:blank}));const bridge={agentCommand:command} as unknown as DesktopBridge;
 const view=renderHook(()=>useOrchestration(bridge));await act(async()=>{});expect(command).toHaveBeenCalledTimes(1);
 await act(async()=>{window.dispatchEvent(new Event('focus'));});expect(command).toHaveBeenCalledTimes(2);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(command).toHaveBeenCalledTimes(3);
 expect(command.mock.calls.every(([c])=>(c as {action:string}).action==='snapshot')).toBe(true);
 view.unmount();window.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(86400000);expect(command).toHaveBeenCalledTimes(3);
});
it('shows priced amounts separately from unresolved exposure and labels OpenAI tariffs correctly',()=>{
 const period={attempts:53,priced:48,unknown:0,provisional:5,low:11811588,high:21779166,exposure:101699166,development:0,developmentHigh:0};
 const costs:Costs={day:'2026-10-02',month:'2026-10',today:period,monthToDate:period,rates:seedRates,recent:[],forecast:null,warning:false,stopped:false};
 const view=render(<DashboardUsage costs={costs} openSettings={vi.fn()}/>);
 expect(screen.getAllByText('$0.0118 – $0.0218')).toHaveLength(2);expect(screen.getByText(/reserved bound is \$0.0799/)).toBeTruthy();
 expect(screen.getByText(/Phone, hosting and other service charges/)).toBeTruthy();view.unmount();
 const controller={data:{...blank,costs},busy:false,error:'',command:vi.fn(async()=>true),loaded:true} as OrchestrationController;
 render(<UsageSettings snapshot={snapshot} controller={controller} busy={false} save={vi.fn()}/>);
 expect(screen.getByText(/OpenAI · gpt-6-luna/)).toBeTruthy();expect(screen.getByText(/cache write 0.125/)).toBeTruthy();
});
it('does not let a late initial or usage snapshot undo a published assessment correction',async()=>{
 let initial!:(value:unknown)=>void,changed!:(value:AgentSnapshot)=>void,usage!:()=>void,later!:(value:unknown)=>void;
 const bridge={agentCommand:vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{initial=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{later=resolve;})),onAgentChanged:(cb:typeof changed)=>{changed=cb;return()=>{};},onWorkspaceChanged:(cb:typeof usage)=>{usage=cb;return()=>{};}} as unknown as DesktopBridge;
 const view=renderHook(()=>useOrchestration(bridge));const corrected={...blank,state:{...blank.state,revision:1}};
 act(()=>changed(corrected));await act(async()=>initial({ok:true,value:blank}));expect(view.result.current.data.state.revision).toBe(1);
 act(()=>usage());act(()=>changed({...corrected,state:{...corrected.state,revision:2}}));await act(async()=>later({ok:true,value:blank}));expect(view.result.current.data.state.revision).toBe(2);
});
it('budget preview requires a separate confirmation, cancels without applying, and shows the chosen boundary',async()=>{
 const period={attempts:1,priced:0,unknown:1,provisional:0,low:0,high:0,exposure:0,development:0,developmentHigh:0};
 const costs:Costs={day:'2026-09-25',month:'2026-09',today:period,monthToDate:period,rates:seedRates,recent:[],forecast:null,warning:false,stopped:true,enforcement:{boundary:null,historicalUnknown:0,month:period}};
 const preview:BudgetBoundary={id:crypto.randomUUID(),at:'2026-09-25T12:00:00.000Z',settingsRevision:0,previousId:null,legacyIds:['legacy']};
 const command=vi.fn(async()=>true),controller={data:{...blank,costs},busy:false,error:'',command,loaded:true} as OrchestrationController;
 const view=render(<UsageSettings snapshot={snapshot} controller={controller} busy={false} save={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:'Start enforced budget from now…'}));expect(command).toHaveBeenCalledWith({action:'previewBudgetBoundary'});expect(command.mock.calls.some(([c])=>(c as {action:string}).action==='applyBudgetBoundary')).toBe(false);
 view.rerender(<UsageSettings snapshot={snapshot} controller={{...controller,data:{...controller.data,budgetPreview:preview}}} busy={false} save={vi.fn()}/>);await screen.findByRole('button',{name:'Confirm this budget boundary'});expect(screen.getByText(/not marked free, deleted or repriced/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Cancel boundary'}));expect(screen.queryByRole('button',{name:'Confirm this budget boundary'})).toBeNull();expect(command.mock.calls.some(([c])=>(c as {action:string}).action==='applyBudgetBoundary')).toBe(false);
});
it('archived history stays inspectable and pending/uncertain rows remain visible even with a marker',async()=>{
 const command=vi.fn(async()=>true),accountId='accountA';const actions=['succeeded','pending','unknown'].map((status,i)=>({id:'action'+i,accountId,kind:'archive',createdAt:'2026-09-25T12:00:00Z',expiresAt:'2000-01-01T00:00:00Z',status,detail:'Fixture '+status}));
 const bridge={calendarAction:async()=>({ok:true,value:{actions:[]}}),mailCommand:async()=>({ok:true,value:{actions,drafts:[],thread:null,review:null}})} as unknown as DesktopBridge;
 const orchestration={data:{...blank,activityArchives:actions.map(a=>({id:'mail:'+a.id,accountId}))},command,busy:false,error:'',loaded:true} as OrchestrationController;
 render(<ActivityDrawer snapshot={snapshot} bridge={bridge} controller={{workspace:emptyWorkspace} as AssistantController} orchestration={orchestration} review={vi.fn()} openSource={vi.fn()} openCalendar={vi.fn()} openConversation={vi.fn()} recover={vi.fn()}/>);
 await screen.findByText('Fixture unknown');expect(screen.getByText('Fixture pending')).toBeTruthy();expect(screen.queryByText('Fixture succeeded')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Show archived'}));expect(screen.getByText('Fixture succeeded')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Restore archived history'}));await waitFor(()=>expect(command).toHaveBeenCalledWith({action:'restoreActivity',accountId}));
});
