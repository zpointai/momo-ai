// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { DailyBriefing,FullDailyBriefing } from '../src/desktop/DailyBriefing';
import { BackgroundSettings } from '../src/desktop/BackgroundIntelligence';
import { ProviderSettings,type AssistantController } from '../src/desktop/AssistantViews';
import type { OrchestrationController } from '../src/desktop/OrchestrationViews';
import { defaults,type Snapshot,type DesktopBridge } from '../src/shared/contracts';
import { emptyWorkspace } from '../src/shared/assistant';
import { initialAgentState } from '../src/shared/orchestration';
import type { DailyIntelligence } from '../src/shared/daily-intelligence';
import { dateInZone } from '../src/shared/google';
afterEach(cleanup);
const snapshot={settings:{values:defaults,revision:7},credentials:{openai:'configured',deepseek:'configured',jev:'configured'},protectionAvailable:true,google:{activeAccountId:'accountA'}} as Snapshot;
function controller(){return{data:{state:initialAgentState(),runs:[]},busy:false,loaded:true,error:'',command:vi.fn(async()=>true)} as unknown as OrchestrationController;}
function record():DailyIntelligence{const at=new Date().toISOString(),date=dateInZone(new Date(),defaults.timezone);return{snapshot:{connectors:{weather:'not-configured',traffic:'not-configured'},id:'test',revision:'r',accountId:'accountA',timezone:defaults.timezone,date,createdAt:at,entries:Array.from({length:12},(_,n)=>({id:'e'+n,kind:'task',section:n<6?'prepare':'ahead',title:'Source '+n,detail:JSON.stringify({due:n<6?{kind:'none'}:{kind:'date',date:'2099-01-01'}}),ref:{id:'source'+n,type:'task',label:'Source '+n,provenance:{kind:'user',fetchedAt:at}}})),coverage:[{source:'calendar',status:'available',detail:'Existing range',included:0,total:0},{source:'tasks',status:'available',detail:'Open tasks',included:12,total:12},{source:'attention',status:'available',detail:'Saved assessments',included:0,total:0},{source:'approvals',status:'disabled',detail:'Reviews remain in Work',included:0,total:null}]},synthesis:{status:'not-requested',snapshotId:'test',snapshotRevision:'r',updatedAt:at,text:null,runId:null,reason:''}} as DailyIntelligence;}
it('bounds the Dashboard preview, omits empty Today, and exposes all source-backed entries in full detail',async()=>{
 const daily=record(),openFull=vi.fn(),activity=vi.fn(),orchestration=controller();const command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}));
 const props={snapshot,bridge:{agentCommand:command} as unknown as DesktopBridge,orchestration,openSource:vi.fn(),activity,usageSettings:vi.fn(),openFull};const {container,unmount}=render(<DailyBriefing {...props}/>);
 await screen.findByText('Source 0');expect(container.querySelectorAll('.daily-source')).toHaveLength(4);expect(screen.queryByRole('heading',{name:'Today'})).toBeNull();expect(container.querySelector('.daily-content')?.classList.contains('pane-scroll')).toBe(false);expect(container.querySelector('.daily-content')?.getAttribute('tabindex')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'View full briefing'}));expect(openFull).toHaveBeenCalledWith(daily);expect(command.mock.calls).toHaveLength(1);unmount();
 const openSource=vi.fn(),full=render(<FullDailyBriefing record={daily} openSource={openSource} activity={activity} settings={vi.fn()}/>);expect(full.container.querySelectorAll('.daily-source')).toHaveLength(12);expect(full.container.querySelector('.pane-scroll')).toBeNull();fireEvent.click(screen.getByRole('button',{name:/Source 11/}));expect(openSource).toHaveBeenCalledWith(daily.snapshot.entries[11].ref);expect(activity).not.toHaveBeenCalled();
});
it('keeps the complete saved summary and renders its formatting without remote images or links',async()=>{
 const daily=record(),text='**Saved summary**\n\n'+('A retained fact. '.repeat(35))+'\n\n- Final retained item\n- [Reference](https://example.test/private)\n\n![Remote image](https://example.test/pixel.png)';
 daily.synthesis={...daily.synthesis,status:'complete',text};
 const openFull=vi.fn(),command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}));
 const view=render(<DailyBriefing snapshot={snapshot} bridge={{agentCommand:command} as unknown as DesktopBridge} orchestration={controller()} openSource={vi.fn()} activity={vi.fn()} usageSettings={vi.fn()} openFull={openFull}/>);
 await screen.findByText('Saved summary');expect(view.container.querySelector('.daily-narrative strong')?.textContent).toBe('Saved summary');expect(view.container.querySelector('.daily-narrative')?.textContent).toContain('Final retained item');expect(view.container.querySelectorAll('img,a')).toHaveLength(0);
 expect(view.container.querySelector('.daily-narrative p')).toBeNull();expect(screen.getByText('Preview')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Read full summary'}));expect(openFull).toHaveBeenCalledWith(daily);expect(command).toHaveBeenCalledTimes(1);view.unmount();
 const full=render(<FullDailyBriefing record={daily} openSource={vi.fn()} activity={vi.fn()} settings={vi.fn()}/>);expect(full.container.querySelector('.daily-summary-text')?.textContent).toContain('Final retained item');expect(full.container.querySelectorAll('img,a')).toHaveLength(0);
 expect(full.container.querySelector('.daily-full')?.children[1].className).toBe('daily-summary');
});
it('excludes legacy chat and approval rows from preview, full briefing and source details without deleting records',async()=>{
 const daily=record(),legacy={...daily.snapshot.entries[0],id:'legacy-chat',kind:'workflow' as const,title:'chat workflow',detail:'Workflow held for review.',ref:{...daily.snapshot.entries[0].ref,type:'briefing' as const}};
 daily.snapshot.entries.unshift(legacy,{...legacy,id:'legacy-approval',kind:'approval',title:'Saved proposal'});
 const before=structuredClone(daily),command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}})),props={snapshot,bridge:{agentCommand:command} as unknown as DesktopBridge,orchestration:controller(),openSource:vi.fn(),activity:vi.fn(),usageSettings:vi.fn(),openFull:vi.fn()};
 const view=render(<DailyBriefing {...props}/>);await screen.findByText('Source 0');expect(screen.queryByText('chat workflow')).toBeNull();expect(screen.queryByText('Saved proposal')).toBeNull();expect(view.container.querySelectorAll('.daily-source')).toHaveLength(4);view.unmount();
 const full=render(<FullDailyBriefing record={daily} openSource={props.openSource} activity={props.activity} settings={vi.fn()}/>);expect(full.container.textContent).not.toContain('chat workflow');expect(full.container.textContent).not.toContain('Saved proposal');expect(daily).toEqual(before);expect(command.mock.calls.every(([c])=>(c as {action:string}).action==='dailyBriefing')).toBe(true);
});
it('does not refresh daily content or disturb its summary when chat activity changes',async()=>{
 const daily=record(),orchestration=controller(),command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}));
 const props={snapshot,bridge:{agentCommand:command} as unknown as DesktopBridge,orchestration,openSource:vi.fn(),activity:vi.fn(),usageSettings:vi.fn(),openFull:vi.fn()};
 const view=render(<DailyBriefing {...props}/>);await screen.findByText('Source 0');expect(command).toHaveBeenCalledTimes(1);
 const next={...orchestration,data:{...orchestration.data,runs:[{id:'chat',status:'review',event:{family:'chat'},proposals:[]} as never]}};
 view.rerender(<DailyBriefing {...props} orchestration={next}/>);await waitFor(()=>expect(command).toHaveBeenCalledTimes(1));
});
it('Refresh facts and Brief me dispatch distinct commands, with graceful unavailable copy',async()=>{
 const daily=record(),orchestration=controller(),command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}));
 render(<DailyBriefing snapshot={snapshot} bridge={{agentCommand:command} as unknown as DesktopBridge} orchestration={orchestration} openSource={vi.fn()} activity={vi.fn()} usageSettings={vi.fn()} openFull={vi.fn()}/>);
 await screen.findByText('Source 0');await waitFor(()=>expect((screen.getByRole('button',{name:'Brief me'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Refresh facts'}));await waitFor(()=>expect(command).toHaveBeenLastCalledWith({action:'dailyBriefing',refresh:true,synthesize:false}));await waitFor(()=>expect((screen.getByRole('button',{name:'Brief me'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Brief me'}));await waitFor(()=>expect(command).toHaveBeenLastCalledWith({action:'dailyBriefing',refresh:true,synthesize:true}));
});
it('a process-only review block explains review availability without exposing internal flags',async()=>{
 const daily=record();daily.synthesis.status='blocked';daily.synthesis.reason='session_no_inference';const orchestration=controller();orchestration.data.briefingEligibility={accountId:'accountA',issues:[{code:'session_no_inference',message:'No-inference review session',target:'none',label:'Review'}]} as unknown as typeof orchestration.data.briefingEligibility;
 render(<DailyBriefing snapshot={snapshot} bridge={{agentCommand:vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}))} as unknown as DesktopBridge} orchestration={orchestration} openSource={vi.fn()} activity={vi.fn()} usageSettings={vi.fn()} openFull={vi.fn()}/>);await screen.findByText('Source 0');expect(screen.getByText('Review session · AI summaries are off')).toBeTruthy();expect(screen.getByText('Your daily facts are still available.')).toBeTruthy();expect(screen.queryByText(/No-inference|session_no_inference|DeepSeek|Luna/)).toBeNull();expect((screen.getByRole('button',{name:'Brief me'}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'Refresh facts'}) as HTMLButtonElement).disabled).toBe(false);
});
it.each([
 ['provider','ai','Connect an AI provider to prepare a summary','Review AI connections'],
 ['spending_stop','limits','AI usage controls need review','Review spending controls'],
 ['workflow','automation','Briefing workflow needs review','Review workflow setup'],
] as const)('projects the %s blocker and routes its recovery without dispatching',async(code,target,message,label)=>{
 const daily=record(),orchestration=controller(),recover=vi.fn(),issue={code,target,message:'Internal diagnostic must stay native',label};
 orchestration.data.briefingEligibility={accountId:'accountA',checkedAt:new Date().toISOString(),eligible:false,issues:[issue],activeRunId:null};
 const command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}));
 render(<DailyBriefing snapshot={snapshot} bridge={{agentCommand:command} as unknown as DesktopBridge} orchestration={orchestration} openSource={vi.fn()} activity={vi.fn()} usageSettings={vi.fn()} recover={recover} openFull={vi.fn()}/>);
 await screen.findByText('Source 0');expect(screen.getByText(message)).toBeTruthy();expect(screen.queryByText(issue.message)).toBeNull();
 expect((screen.getByRole('button',{name:'Brief me'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:label}));expect(recover).toHaveBeenCalledWith(issue);expect(command).toHaveBeenCalledTimes(1);
});
it('keeps an eligible Brief me amber, blocks double clicks, and retains facts after synthesis failure',async()=>{
 const daily=record(),orchestration=controller();orchestration.data.briefingEligibility={accountId:'accountA',checkedAt:new Date().toISOString(),eligible:true,issues:[],activeRunId:null};
 let finish!:(value:unknown)=>void;const command=vi.fn().mockResolvedValueOnce({ok:true,value:{dailyIntelligence:daily}}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 render(<DailyBriefing snapshot={snapshot} bridge={{agentCommand:command} as unknown as DesktopBridge} orchestration={orchestration} openSource={vi.fn()} activity={vi.fn()} usageSettings={vi.fn()} openFull={vi.fn()}/>);
 await screen.findByText('Source 0');const button=screen.getByRole('button',{name:'Brief me'}) as HTMLButtonElement;await waitFor(()=>expect(button.disabled).toBe(false));expect(button.className).toBe('primary');
 fireEvent.click(button);fireEvent.click(button);expect(command).toHaveBeenCalledTimes(2);expect(command).toHaveBeenLastCalledWith({action:'dailyBriefing',refresh:true,synthesize:true});
 finish({ok:true,value:{dailyIntelligence:{...daily,synthesis:{...daily.synthesis,status:'failed',reason:'Private provider error',updatedAt:new Date().toISOString()}}}});
 await screen.findByText('AI summary unavailable');expect(screen.getByText('Source 0')).toBeTruthy();expect(screen.queryByText('Private provider error')).toBeNull();expect(button.disabled).toBe(false);
});
it('recognizes an existing native briefing before its synthesis projection arrives',async()=>{
 const daily=record(),orchestration=controller();orchestration.data.briefingEligibility={accountId:'accountA',checkedAt:new Date().toISOString(),eligible:false,issues:[{code:'active',target:'automation',label:'Inspect active briefing',message:'Already running'}],activeRunId:'running'};
 const command=vi.fn(async()=>({ok:true,value:{dailyIntelligence:daily}}));render(<DailyBriefing snapshot={snapshot} bridge={{agentCommand:command} as unknown as DesktopBridge} orchestration={orchestration} openSource={vi.fn()} activity={vi.fn()} usageSettings={vi.fn()} openFull={vi.fn()}/>);
 await screen.findByText('Source 0');expect((screen.getByRole('button',{name:'Preparing summary…'}) as HTMLButtonElement).disabled).toBe(true);expect(command).toHaveBeenCalledTimes(1);
});
it('manual refresh remains separate from configuration apply/cancel, including dirty edits and revision conflict',async()=>{
 const orchestration=controller(),save=vi.fn(async()=>true),{container,rerender}=render(<BackgroundSettings snapshot={snapshot} controller={orchestration} save={save} busy={false}/>);
 const apply=screen.getByRole('button',{name:'Apply changes'}) as HTMLButtonElement;expect(apply.disabled).toBe(true);const refresh=screen.getByRole('button',{name:'Refresh intelligence'});expect(refresh.closest('.background-manual')).toBeTruthy();expect(apply.closest('.background-edit-footer')).toBeTruthy();fireEvent.click(refresh);expect(orchestration.command).toHaveBeenLastCalledWith({action:'refreshIntelligence',providerCalls:2});expect(save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByLabelText('Enable background intelligence'));fireEvent.click(refresh);expect(save).not.toHaveBeenCalled();expect(screen.getByRole('status').closest('.background-edit-footer')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Cancel',exact:true}));expect((screen.getByLabelText('Enable background intelligence') as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByLabelText('Enable background intelligence'));rerender(<BackgroundSettings snapshot={{...snapshot,settings:{...snapshot.settings,revision:8}}} controller={orchestration} save={save} busy={false}/>);expect(apply.disabled).toBe(true);expect(container.textContent).toContain('Saved values changed');expect(save).not.toHaveBeenCalled();
});
it('OpenAI shares provider controls, imports through the existing bridge callback and tests only on click',()=>{
 const start=vi.fn(),credential=vi.fn(),save=vi.fn(),assistant={workspace:emptyWorkspace,pending:false,start} as unknown as AssistantController;
 const {container}=render(<ProviderSettings snapshot={snapshot} busy={false} save={save} credential={credential} saveKey={vi.fn()} controller={assistant}/>),openai=within(container.querySelector('[data-provider="openai"]') as HTMLElement);
 expect(container.querySelectorAll('.provider-block')).toHaveLength(3);expect(container.querySelectorAll('.provider-row')).toHaveLength(3);expect(openai.getByText('API access not tested in this app')).toBeTruthy();expect(openai.getByText('Save or replace OpenAI key').closest('details')!.open).toBe(false);expect(openai.queryByRole('checkbox')).toBeNull();expect(start).not.toHaveBeenCalled();fireEvent.click(openai.getByRole('button',{name:'Import key file'}));expect(credential).toHaveBeenCalledWith('openai',false);expect(save).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();fireEvent.click(openai.getByRole('button',{name:'Test OpenAI · one request'}));expect(start).toHaveBeenCalledTimes(1);expect(start).toHaveBeenCalledWith(expect.objectContaining({mode:'openai-test',accountId:null,includeGoogle:false}));
});
