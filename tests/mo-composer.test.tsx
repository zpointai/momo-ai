// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {MoMoPanel} from '../src/desktop/MoMoPanel';
import {defaults} from '../src/shared/contracts';
import {emptyGoogle} from '../src/shared/google';
import {emptyWorkspace,type AssistantRun} from '../src/shared/assistant';
import {initialAgentState,type AgentRun} from '../src/shared/orchestration';

beforeEach(()=>{HTMLElement.prototype.scrollTo=vi.fn();});
afterEach(cleanup);
const at=new Date().toISOString();
const answer=(extra:Partial<AssistantRun>={})=>({id:'answer',conversationId:'conversation',accountId:'accountA',prompt:'Hi Mo',createdAt:at,status:'succeeded',result:{answer:'Hello. How can I help?',suggestions:[],citations:[]},sources:[],warnings:[],error:null,...extra}) as AssistantRun;
function work(state='needs-owner',conversationId='conversation'){
 return {id:'root',createdAt:at,event:{accountId:'accountA',family:'chat',origin:'user',prompt:'Supplier follow-up'},executive:{state,conversationId,assistantRunId:'answer',revision:1,nextStep:'Review the linked result'},status:state==='working'?'running':'review',context:{createdAt:at,items:[{id:'M1',kind:'email',resourceId:'mail1',accountId:'accountA',revision:'r1',title:'Supplier email',text:'Source',fetchedAt:at}],limitations:[]},checkpoint:'Review',proposals:[],steps:[],calls:[],findings:[],result:null,error:null} as unknown as AgentRun;
}
function props(runs:AssistantRun[]=[answer()],roots:AgentRun[]=[]):ComponentProps<typeof MoMoPanel>{
 return {snapshot:{settings:{values:{...defaults,deepseekEnabled:true},revision:0},google:{...emptyGoogle,activeAccountId:'accountA'},credentials:{deepseek:'configured'}},bridge:{},controller:{workspace:{...emptyWorkspace,runs},start:vi.fn(async()=>true),pending:false,error:'',cancel:vi.fn()},conversationId:'conversation',newConversation:vi.fn(),openConversation:vi.fn(),settings:vi.fn(),resetWidth:vi.fn(),onSuggestion:vi.fn(),openSource:vi.fn(),openWork:vi.fn(),clearWork:vi.fn(),workflowSettings:vi.fn(),orchestration:{data:{state:{...initialAgentState(),config:{...initialAgentState().config,shareTasks:true}},runs:roots},command:vi.fn(async()=>true),busy:false}} as unknown as ComponentProps<typeof MoMoPanel>;
}
async function send(text:string){fireEvent.change(screen.getByLabelText('Message Mo'),{target:{value:text}});fireEvent.click(screen.getByRole('button',{name:'Send message'}));await waitFor(()=>expect((screen.getByLabelText('Message Mo') as HTMLTextAreaElement).value).toBe(''));}
it('shows normal answers without success telemetry or a mode selector, with neutral idle character',()=>{
 render(<MoMoPanel {...props()}/>);expect(screen.getByText('Hello. How can I help?')).toBeTruthy();expect(screen.queryByText('succeeded')).toBeNull();expect(screen.queryByRole('group',{name:'Message route'})).toBeNull();expect(screen.queryByRole('button',{name:'Workflow',exact:true})).toBeNull();expect(screen.queryByRole('button',{name:'Conversation',exact:true})).toBeNull();expect(screen.getByText('Ready')).toBeTruthy();expect(document.querySelector('.assistant')?.getAttribute('data-mo-state')).toBe('idle');expect(screen.getAllByRole('textbox',{name:'Message Mo'})).toHaveLength(1);
});
it.each(['Hi Mo','Check my agenda and prepare a reply','Keep track of this task'])('uses the same Executive entry point for %s',async prompt=>{
 const p=props();render(<MoMoPanel {...p}/>);await send(prompt);expect(p.controller.start).toHaveBeenCalledWith(expect.objectContaining({mode:'chat',conversationId:'conversation',prompt}));
});
it.each(['cancelled','interrupted','failed'] as const)('preserves useful %s status',status=>{render(<MoMoPanel {...props([answer({status,result:null,error:status==='failed'?'Model unavailable':null})])}/>);expect(screen.getByText(status==='cancelled'?'Cancelled':status==='interrupted'?'Interrupted — review before trying again':'Model unavailable')).toBeTruthy();});
it('keeps active progress and stop visible',()=>{render(<MoMoPanel {...props([answer({status:'running',result:null,stage:'Checking your agenda'})])}/>);expect(screen.getByText('Checking your agenda…')).toBeTruthy();expect(screen.getByRole('button',{name:'Stop'})).toBeTruthy();});
it('does not inherit unrelated account attention or treat completed work as a pending decision',()=>{
 const p=props([answer()],[work('needs-owner','other')]);const v=render(<MoMoPanel {...p}/>);expect(screen.queryByText('Waiting for you')).toBeNull();v.rerender(<MoMoPanel {...props([answer()],[work('completed')])}/>);expect(screen.getByText('Ready')).toBeTruthy();
});
it.each(['needs-owner','approval-required','prepared','blocked'])('waits for a genuine %s decision in this conversation',state=>{render(<MoMoPanel {...props([answer()],[work(state)])}/>);expect(screen.getByText('Waiting for you')).toBeTruthy();expect(document.querySelector('.mo-character')?.getAttribute('data-state')).toBe('waiting');});
it('waits for an unbound clarification but resets after the next ordinary answer',()=>{
 const run=answer();run.result!.clarification='Which item?';const p=props([run]);const v=render(<MoMoPanel {...p}/>);expect(screen.getByText('Waiting for you')).toBeTruthy();v.rerender(<MoMoPanel {...props([answer({id:'next'}),run])}/>);expect(screen.getByText('Ready')).toBeTruthy();
});
it('reflects sharing choices, keeps exact selected work/source binding, and preserves a draft',async()=>{
 const p={...props([answer()],[work()]),workId:'root'};const v=render(<MoMoPanel {...p}/>);expect(screen.getByText('Working on · Supplier follow-up')).toBeTruthy();fireEvent.click(screen.getByText('Working on · Supplier follow-up'));fireEvent.click(screen.getByLabelText('Include inbox & calendar'));
 fireEvent.change(screen.getByLabelText('Message Mo'),{target:{value:'Unsent draft'}});v.rerender(<MoMoPanel {...p} conversationId="other"/>);v.rerender(<MoMoPanel {...p}/>);expect((screen.getByLabelText('Message Mo') as HTMLTextAreaElement).value).toBe('Unsent draft');await send('What are you waiting for?');expect(p.controller.start).toHaveBeenCalledWith(expect.objectContaining({workId:'root',messageId:'mail1',includeGoogle:true}));
 v.rerender(<MoMoPanel {...p} workId={undefined}/>);expect(screen.getByText('Context · This conversation · Inbox + Calendar')).toBeTruthy();
});
it('keeps selected-work controls on the existing root without inference or implicit approval',async()=>{
 const p={...props([answer()],[work()]),workId:'root'};render(<MoMoPanel {...p}/>);await send('Handle this');expect(p.orchestration.command).toHaveBeenCalledWith({action:'handleWork',id:'root'});await send('Keep track of this');expect(p.openWork).toHaveBeenCalledWith('root');await send('Cancel that');expect(p.orchestration.command).toHaveBeenCalledWith({action:'cancel',id:'root'});expect(p.controller.start).not.toHaveBeenCalled();expect(p.orchestration.command).toHaveBeenCalledTimes(2);
});
