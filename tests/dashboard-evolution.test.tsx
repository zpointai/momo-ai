// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DashboardContext, useDashboardSituation } from '../src/desktop/DashboardContext';
import { DashboardView } from '../src/desktop/DashboardCards';
import { DesktopApp } from '../src/desktop/Shell';
import { briefingSections } from '../src/desktop/DailyBriefing';
import { defaults, type DesktopBridge, type Snapshot } from '../src/shared/contracts';
import { emptyWorkspace } from '../src/shared/assistant';
import { initialAgentState } from '../src/shared/orchestration';
import { emptyGoogle, dateInZone } from '../src/shared/google';
import { emptySituationConfig, type SituationSnapshot } from '../src/shared/situation';
import type { DailyIntelligence, BriefingEntry } from '../src/shared/daily-intelligence';
import type { BackgroundInsight } from '../src/shared/background';
import type { AssistantController } from '../src/desktop/AssistantViews';
import type { OrchestrationController } from '../src/desktop/OrchestrationViews';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const at = new Date().toISOString(), today = dateInZone(new Date(), defaults.timezone);
const fresh = { provider: 'open-meteo', fetchedAt: at, observedAt: at, freshUntil: new Date(Date.now()+600000).toISOString(), revision:'r', attribution:'Open-Meteo' };
const source = { module:'planner', connector:'google', type:'calendar', id:'event', accountId:'accountA', label:'Calendar source', revision:'r', profile:'local', provenance:{kind:'connector',runId:null,fetchedAt:at},access:'read',retention:{kind:'transient',expiresAt:null} } as const;
function situation():SituationSnapshot {
 return { config:{...emptySituationConfig(),weatherEnabled:true,trafficEnabled:true,locations:[{id:'place',label:'Test locality',revision:'p',updatedAt:at,latitude:1,longitude:2,purpose:'',timezone:'Europe/Amsterdam'}],routes:[{id:'route',label:'Configured route',revision:'r',updatedAt:at,originId:'place',destinationId:'other'}]},selectedLocationId:'place',selectedRouteId:'route',weather:{locationId:'place',locationRevision:'p',freshness:fresh,partial:false,temperatureC:18.4,apparentC:18,code:2,humidityPercent:70,precipitationMm:0,windKph:10,windDegrees:90,forecast:[]},traffic:{routeId:'route',routeRevision:'r',freshness:{...fresh,provider:'tomtom',attribution:'Traffic © TomTom'},partial:false,durationSeconds:960,delaySeconds:120,distanceMeters:10000,typicalSeconds:900,freeFlowSeconds:840,congestion:'moderate',geometry:[],incidents:[]},flights:null,conditions:[],statuses:[],trafficCredential:'configured',protectionAvailable:true,reviewBlocked:false,usage:[],checkedAt:at };
}
function daily():DailyIntelligence {
 return {snapshot:{version:1,id:'daily',revision:'r',authorityRevision:'a',accountId:'accountA',profile:'local',createdAt:at,date:today,endDate:today,timezone:defaults.timezone,trigger:'view',entries:[{id:'entry',kind:'task',section:'prepare',title:'Retained preparation',detail:JSON.stringify({due:{kind:'none'}}),ref:{...source,type:'task'},freshness:'retained',sensitivity:'private',sharing:'local-only',estimatedTokens:10}],coverage:[],connectors:{weather:'available',traffic:'empty'}},synthesis:{snapshotId:'daily',snapshotRevision:'r',runId:null,updatedAt:at,status:'not-requested',reason:'',text:null}};
}
const snapshot:Snapshot={version:'isolated',settings:{values:{...defaults,assistantCollapsed:true},revision:0},credentials:{deepseek:'configured',jev:'missing',openai:'missing',minimax:'missing'},protectionAvailable:true,networkEnabled:false,aiRequestsEnabled:false,storage:'ready',google:{...emptyGoogle,activeAccountId:'accountA',accounts:[{id:'accountA',email:'isolated@example.test',status:'connected'}]}} as Snapshot;
function services(){
 const data={state:initialAgentState(),runs:[],dailyIntelligence:daily()},workspace={...emptyWorkspace,tasks:[]};
 const bridge={getSnapshot:vi.fn(async()=>({ok:true,value:snapshot})),onChanged:()=>()=>{},getWorkspace:vi.fn(async()=>({ok:true,value:workspace})),onWorkspaceChanged:()=>()=>{},agentCommand:vi.fn(async()=>({ok:true,value:data})),onAgentChanged:()=>()=>{},situationCommand:vi.fn(async()=>({ok:true,value:situation()})),readCalendar:vi.fn(async()=>({ok:true,value:{events:[],fetchedAt:at,cached:true}})),calendarAction:vi.fn(async()=>({ok:true,value:{actions:[],review:null}})),mailCommand:vi.fn(async()=>({ok:true,value:{actions:[],drafts:[],thread:null,review:null}})),updateSettings:vi.fn(),startRun:vi.fn()} as unknown as DesktopBridge;
 const controller={workspace,pending:false,task:vi.fn()} as unknown as AssistantController,orchestration={data,busy:false,command:vi.fn(async()=>true)} as unknown as OrchestrationController;
 return {bridge,controller,orchestration};
}
function props(){return {snapshot,...services(),review:vi.fn(),newTask:vi.fn(),newEvent:vi.fn(),activity:vi.fn(),settings:vi.fn(),usageSettings:vi.fn(),openSource:vi.fn(),openPlanner:vi.fn(),brief:vi.fn(async()=>true),recover:vi.fn(),active:true,openAssistant:vi.fn(),detailHost:document.createElement('div'),openDetails:vi.fn(),closeDetails:vi.fn(),openSituation:vi.fn()};}
it('shows zoned time and selected weather, omits even fresh commute data, and opens Weather',()=>{
 vi.useFakeTimers();vi.setSystemTime('2026-09-28T10:53:00Z');const value=situation();value.weather!.freshness={...fresh,fetchedAt:'2026-09-28T10:50:00Z',freshUntil:'2026-09-28T11:30:00Z'};value.traffic!.freshness=value.weather!.freshness;
 const open=vi.fn();render(<DashboardContext timezone="Europe/Amsterdam" snapshot={value} open={open}/>);
 expect(screen.getByText('12:53')).toBeTruthy();expect(screen.getByText('Europe/Amsterdam')).toBeTruthy();expect(document.querySelector('.dashboard-clock')?.textContent).not.toMatch(/Mon|Sept/);expect(screen.getByText(/18°C/)).toBeTruthy();
 expect(screen.queryByText(/Configured route|16 min|Moderate traffic|humidity|forecast|flight|time zones/i)).toBeNull();expect(screen.queryByRole('button',{name:'Open commute in Situation View'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Open Weather in Situation View'}));expect(open).toHaveBeenCalledWith('weather',value);
 act(()=>vi.advanceTimersByTime(4000000));expect(screen.queryByText(/Estimate expired|No current estimate/)).toBeNull();expect(screen.getByText(/Stale · Fetched/)).toBeTruthy();
});
it('keeps time alone when weather is unavailable, without a commute or replacement placeholder',()=>{
 const value=situation();value.weather!.locationRevision='old';value.traffic=null;const {rerender}=render(<DashboardContext timezone="UTC" snapshot={value} open={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:'Open Weather in Situation View'})).toBeNull();expect(screen.queryByText(/No current estimate|Configured route|16 min/)).toBeNull();expect(document.querySelector('.dashboard-context')?.children).toHaveLength(1);
 rerender(<DashboardContext timezone="UTC" snapshot={undefined} open={vi.fn()}/>);expect(screen.queryAllByRole('button')).toHaveLength(0);
});
it('reads only local snapshots on mount, configuration changes and reentry; preserves selected identity',async()=>{
 const {bridge}=services();function Probe({active}:{active:boolean}){useDashboardSituation(bridge,active,{locationId:'place',routeId:'route'});return null;}
 const {rerender}=render(<Probe active/>);await waitFor(()=>expect(bridge.situationCommand).toHaveBeenCalledTimes(1));
 act(()=>window.dispatchEvent(new Event('momo:situation-changed')));await waitFor(()=>expect(bridge.situationCommand).toHaveBeenCalledTimes(2));
 rerender(<Probe active={false}/>);rerender(<Probe active/>);await waitFor(()=>expect(bridge.situationCommand).toHaveBeenCalledTimes(3));expect(vi.mocked(bridge.situationCommand!).mock.calls.every(([c])=>c.action==='snapshot'&&c.locationId==='place'&&c.routeId==='route')).toBe(true);
});
it('groups Today, Prepare, Upcoming and source-backed Recent updates, omitting empty sections',()=>{
 const make=(kind:BriefingEntry['kind'],section:BriefingEntry['section'])=>({...daily().snapshot.entries[0],kind,section});
 expect(briefingSections([make('calendar','today'),make('task','prepare'),make('calendar','ahead'),make('situation','prepare'),make('workflow','prepare')],today).map(g=>g.label)).toEqual(['Today','Prepare','Upcoming','Recent updates']);
 expect(briefingSections([],today)).toEqual([]);
});
it('shows a larger three-item preview for each populated section and retains all entries in full detail',async()=>{
 const p=props(),record=daily();record.snapshot.entries=Array.from({length:16},(_,n)=>({...record.snapshot.entries[0],id:'item'+n,title:'Fact '+n,kind:n>=12?'situation':n<4?'attention':'task',section:n<4?'today':n<8?'prepare':n<12?'ahead':'prepare',detail:n>=12?JSON.stringify({summary:'Source-backed change'}):JSON.stringify({due:n<8?{kind:'none'}:{kind:'date',date:'2099-01-01'}})}));
 p.orchestration.data.dailyIntelligence=record;vi.mocked(p.bridge.agentCommand).mockResolvedValue({ok:true,value:{...p.orchestration.data,dailyIntelligence:record}});
 const {container}=render(<DashboardView {...p}/>);await screen.findByText('Fact 0');expect(container.querySelectorAll('.daily-content .daily-source')).toHaveLength(12);
 fireEvent.click(screen.getByRole('button',{name:'View full briefing'}));expect(p.detailHost.querySelectorAll('.daily-source')).toHaveLength(16);
});
it('honors a failed refresh stale status even before timestamp expiry',()=>{
 const value=situation();value.statuses=[{source:'weather',provider:'open-meteo',state:'stale',detail:'Refresh failed',lastError:'network',lastAttemptAt:at}];render(<DashboardContext timezone="UTC" snapshot={value} open={vi.fn()}/>);expect(screen.getByText(/Stale · Fetched/)).toBeTruthy();
});
it('keeps attention and empty tasks compact with real actions, Planner navigation and shared Assistant entry',async()=>{
 const p=props(),{container}=render(<DashboardView {...p}/>);await screen.findByText('Retained preparation');
 expect(container.querySelector('.attention-quiet')).toBeTruthy();expect(screen.getByText('No open tasks')).toBeTruthy();expect(screen.getByText('No upcoming events')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Ask Mo'}));expect(p.openAssistant).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'New task'}));fireEvent.click(screen.getByRole('button',{name:'Add task'}));expect(p.newTask).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole('button',{name:'New event'}));expect(p.newEvent).toHaveBeenCalledTimes(1);
 fireEvent.click(within(container.querySelector('.agenda-pane')!).getByRole('button',{name:'View all'}));fireEvent.click(within(container.querySelector('.tasks-pane')!).getByRole('button',{name:'View all'}));expect(p.openPlanner).toHaveBeenCalledTimes(2);
 expect(container.querySelector('.dashboard-inspector')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'View full briefing'}));expect(p.openDetails).toHaveBeenCalled();expect(p.detailHost.textContent).toContain('Retained preparation');
});
it('bounds populated tasks/events and assigns or dispositions the same attention root',async()=>{
 const p=props();p.controller.workspace.tasks=Array.from({length:8},(_,n)=>({id:'task'+n,title:'Task '+n,revision:1,status:'open',accountId:'accountA',due:{kind:'none'},createdAt:at,updatedAt:at}));
 vi.mocked(p.bridge.readCalendar).mockResolvedValue({ok:true,value:{events:Array.from({length:6},(_,n)=>({id:'e'+n,title:'Event '+n,time:{kind:'allDay',startDate:today,endDate:'2099-01-01'},status:'confirmed'})),fetchedAt:at}} as never);
 const insight={id:'insight',runId:'attention-root',accountId:'accountA',title:'Review source',summary:'Source-backed observation',observedAt:at,expiresAt:null,status:'active',ownerAttention:true,unresolvedQuestions:[],sources:[{...source,label:'Exact source'}]} as unknown as BackgroundInsight;
 p.orchestration.data.background={insights:[insight]} as never;
 p.orchestration.data.runs=[{id:'attention-root',event:{family:'briefing',accountId:'accountA',prompt:'Review source',origin:'momo'},background:{trigger:'startup'},status:'complete',createdAt:at,finishedAt:at,context:{createdAt:at,items:[{id:'M1',delivery:{ref:insight.sources[0]},title:'Exact source'}],limitations:[]},calls:[],proposals:[],findings:[],error:null,checkpoint:'Generated',result:null}] as never;
 const {container}=render(<DashboardView {...p}/>);await screen.findByText('Event 0');expect(container.querySelectorAll('.agenda-entry')).toHaveLength(3);expect(container.querySelectorAll('.task-row')).toHaveLength(3);expect(container.querySelector('.attention-quiet')).toBeNull();
 fireEvent.click(screen.getByText('Review source'));expect(p.activity).toHaveBeenCalled();fireEvent.click(screen.getByText('Handle with Mo'));expect(p.orchestration.command).toHaveBeenLastCalledWith({action:'handleWork',id:'attention-root'});fireEvent.click(screen.getByText('More options'));
 fireEvent.click(screen.getByText('Not relevant'));expect(p.orchestration.command).toHaveBeenLastCalledWith({action:'workDisposition',id:'attention-root',expectedRevision:0,choice:'not-relevant'});
 fireEvent.click(screen.getByText('Resolved elsewhere'));expect(p.orchestration.command).toHaveBeenLastCalledWith({action:'workDisposition',id:'attention-root',expectedRevision:0,choice:'resolved-elsewhere'});
});
it('retains Dashboard detail and unsent MoMo draft in the same workpane while preference persistence is pending',async()=>{
 location.hash='#dashboard';HTMLElement.prototype.scrollTo=()=>{};HTMLElement.prototype.scrollIntoView=()=>{};
 vi.stubGlobal('ResizeObserver',class {constructor(private cb:ResizeObserverCallback){}observe(target:Element){this.cb([{target,contentRect:{width:1920,height:1080}} as ResizeObserverEntry],this as unknown as ResizeObserver);}disconnect(){}});
 const {bridge}=services();let finish:(()=>void)|undefined;vi.mocked(bridge.updateSettings).mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({ok:true,value:{...snapshot,settings:{values:{...snapshot.settings.values,assistantCollapsed:false},revision:1}}});}));
 render(<DesktopApp bridge={bridge}/>);fireEvent.click(await screen.findByRole('button',{name:'View full briefing'}));const host=document.querySelector<HTMLElement>('.assistant-host')!,detail=document.querySelector('.dashboard-details'),scroll=detail!.querySelector('.pane-scroll')!;scroll.scrollTop=57;
 fireEvent.click(screen.getByRole('button',{name:'Mo',exact:true}));const editor=screen.getByLabelText('Message Mo') as HTMLTextAreaElement;fireEvent.change(editor,{target:{value:'Unsent Dashboard thought'}});
 for(const mode of ['Details','Mo','Work','Mo','Details']){fireEvent.click(screen.getByRole('button',{name:mode,exact:true}));expect(document.querySelector('.assistant-host')).toBe(host);expect(host.hidden).toBe(false);}
 await act(async()=>finish?.());expect(document.querySelector('.dashboard-details')).toBe(detail);expect(scroll.scrollTop).toBe(57);fireEvent.click(screen.getByRole('button',{name:'Mo',exact:true}));expect(screen.getByLabelText('Message Mo')).toBe(editor);expect(editor.value).toBe('Unsent Dashboard thought');expect(bridge.startRun).not.toHaveBeenCalled();
});
