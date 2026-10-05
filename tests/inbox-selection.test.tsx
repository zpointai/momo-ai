// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import React from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { InboxWorkspace,type InboxWorkspaceProps } from '../src/desktop/InboxWorkspace';
import { defaults,type DesktopBridge,type Result,type Snapshot } from '../src/shared/contracts';
import { emptyGoogle,type Mail } from '../src/shared/google';
import { initialAgentState } from '../src/shared/orchestration';
import { emptyWorkspace } from '../src/shared/assistant';
import type { MailResult } from '../src/shared/mail';
import type { AgentRun } from '../src/shared/orchestration';
afterEach(cleanup);
const date='2026-09-23T10:00:00.000Z';
const message=(id:string):Mail=>({id,threadId:'thread-'+id,subject:'Subject '+id,from:'Sender '+id,to:'fictional@example.test',snippet:'Snippet '+id,receivedAt:date,unread:true});
const thread=(id:string,accountId='a'):MailResult=>({drafts:[],actions:[],review:null,thread:{id:'thread-'+id,accountId,fetchedAt:date,truncated:false,messages:[{message:message(id),text:'Private-to-fixture body '+id,textAvailable:true,truncated:false,attachments:[],headers:{replyTo:'',cc:'',messageId:'<'+id+'@example.test>',references:''},labels:[]}]}});
function fixture(){
 const pending=new Map<string,(v:Result<MailResult>)=>void>();const commands:unknown[]=[];
 const bridge={readInbox:vi.fn(async(q:{accountId:string})=>({ok:true,value:{accountId:q.accountId,fetchedAt:date,cached:false,messages:[message('one'),message('two')],failed:0,nextPageToken:null}})),mailCommand:vi.fn(async(c:{action:string;id:string;accountId:string})=>{commands.push(c);if(c.action==='thread')return new Promise<Result<MailResult>>(r=>pending.set(c.accountId+':'+c.id,r));return {ok:true,value:{drafts:[],actions:[],review:null,thread:null}};}),readMessage:vi.fn()} as unknown as DesktopBridge;
 const snapshot:Snapshot={version:'test',settings:{values:defaults,revision:0},credentials: {openai:'missing', deepseek:'missing',jev:'missing',minimax:'missing'},protectionAvailable:true,networkEnabled:false,aiRequestsEnabled:false,storage:'ready',google:{...emptyGoogle,activeAccountId:'a',accounts:[{id:'a',email:'a@example.test',status:'connected',calendarWrite:false,mailCompose:false,mailSend:false,mailModify:false}]}};
 const props={snapshot,bridge,controller:{workspace:emptyWorkspace},orchestration:{data:{state:initialAgentState(),runs:[]},busy:false,command:vi.fn()},settings:vi.fn(),review:vi.fn(),newTask:vi.fn(),openSource:vi.fn(),agentEmail:vi.fn(),assistantAction:vi.fn()} as unknown as InboxWorkspaceProps;
 const resolve=async(id:string,account='a',ok=true)=>{await act(async()=>pending.get(account+':thread-'+id)!(ok?{ok:true,value:thread(id,account)}:{ok:false,error:{code:'unavailable',message:'Synthetic read failed'}}));};
 return {props,pending,commands,resolve};
}
it('never renders the new subject with the old body and rejects a late out-of-order result',async()=>{
 const f=fixture();render(<InboxWorkspace {...f.props}/>);await screen.findByRole('button',{name:/Subject one/});fireEvent.click(screen.getByRole('button',{name:/Subject one/}));await waitFor(()=>expect(f.pending.has('a:thread-one')).toBe(true));fireEvent.click(screen.getByRole('button',{name:/Subject two/}));await waitFor(()=>expect(f.pending.has('a:thread-two')).toBe(true));
 expect(screen.queryByRole('button',{name:'Reply',exact:true})).toBeNull();await f.resolve('two');expect(screen.getByText('Private-to-fixture body two')).toBeTruthy();await f.resolve('one');expect(screen.queryByText('Private-to-fixture body one')).toBeNull();expect(within(screen.getByRole('region',{name:'Message reading pane'})).getByRole('heading',{name:'Subject two',exact:true})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Reply',exact:true}));await waitFor(()=>expect(f.commands).toContainEqual(expect.objectContaining({action:'compose',sourceMessageId:'two',accountId:'a'})));
});
it('keyboard selection clears ready actions immediately and an error cannot restore old content',async()=>{
 const f=fixture();render(<InboxWorkspace {...f.props}/>);const first=await screen.findByRole('button',{name:/Subject one/});fireEvent.click(first);await waitFor(()=>expect(f.pending.has('a:thread-one')).toBe(true));await f.resolve('one');expect(screen.getByText('Private-to-fixture body one')).toBeTruthy();fireEvent.keyDown(first,{key:'ArrowDown'});expect(screen.queryByText('Private-to-fixture body one')).toBeNull();expect(screen.queryByRole('button',{name:'Reply',exact:true})).toBeNull();await waitFor(()=>expect(f.pending.has('a:thread-two')).toBe(true));await f.resolve('two','a',false);expect(screen.getByText('Message unavailable. Refresh to retry.')).toBeTruthy();expect(screen.queryByRole('button',{name:'Reply',exact:true})).toBeNull();
});
it('account changes invalidate selection and late reads cannot populate the new account',async()=>{
 const f=fixture(),view=render(<InboxWorkspace {...f.props}/>);fireEvent.click(await screen.findByRole('button',{name:/Subject one/}));await waitFor(()=>expect(f.pending.has('a:thread-one')).toBe(true));const next={...f.props,snapshot:{...f.props.snapshot,google:{...f.props.snapshot.google,activeAccountId:'b',accounts:[{...f.props.snapshot.google.accounts[0],id:'b',email:'b@example.test'}]}}};view.rerender(<InboxWorkspace {...next}/>);await f.resolve('one');expect(screen.queryByText('Private-to-fixture body one')).toBeNull();expect(screen.queryByRole('button',{name:'Reply',exact:true})).toBeNull();
});
it('reselecting the same loading message starts a fresh generation and resolves',async()=>{
 const f=fixture();render(<InboxWorkspace {...f.props}/>);const first=await screen.findByRole('button',{name:/Subject one/});fireEvent.click(first);await waitFor(()=>expect(f.pending.has('a:thread-one')).toBe(true));const obsolete=f.pending.get('a:thread-one');fireEvent.keyDown(first,{key:'ArrowUp'});await waitFor(()=>expect(f.pending.get('a:thread-one')).not.toBe(obsolete));await act(async()=>obsolete!({ok:true,value:thread('one')}));expect(screen.queryByRole('button',{name:'Reply',exact:true})).toBeNull();await f.resolve('one');expect(screen.getByText('Private-to-fixture body one')).toBeTruthy();expect(screen.getByRole('button',{name:'Reply',exact:true})).toBeTruthy();
});
it('a response with the wrong immutable thread or account is never made actionable',async()=>{
 const f=fixture();render(<InboxWorkspace {...f.props}/>);fireEvent.click(await screen.findByRole('button',{name:/Subject one/}));await waitFor(()=>expect(f.pending.has('a:thread-one')).toBe(true));await act(async()=>f.pending.get('a:thread-one')!({ok:true,value:thread('one','wrong-account')}));expect(screen.queryByText('Private-to-fixture body one')).toBeNull();expect(screen.queryByRole('button',{name:'Reply',exact:true})).toBeNull();
});
it('late AI output stays bound to its source and a changed thread makes it stale',async()=>{
 const f=fixture(),view=render(<InboxWorkspace {...f.props}/>);fireEvent.click(await screen.findByRole('button',{name:/Subject two/}));await waitFor(()=>expect(f.pending.has('a:thread-two')).toBe(true));await f.resolve('two');
 const run={id:'old-run',event:{family:'email',accountId:'a',resourceId:'one'},context:{items:[{id:'M1',kind:'email',resourceId:'one',threadId:'thread-one',title:'Subject one',text:`From: Sender one; Date: ${date}; Snippet one`}],limitations:[]},createdAt:date,result:{text:'Delayed assessment for one',draft:'Wrong-target reply'},proposals:[],decision:{priority:'high'}} as unknown as AgentRun;
 view.rerender(<InboxWorkspace {...f.props} agentRuns={[run]}/>);expect(screen.queryByText('Delayed assessment for one')).toBeNull();expect(screen.queryByRole('button',{name:'Review in composer'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/Subject one/}));await waitFor(()=>expect(f.pending.has('a:thread-one')).toBe(true));await f.resolve('one');view.rerender(<InboxWorkspace {...f.props} agentRuns={[{...run,context:{...run.context,items:[{...run.context.items[0],threadId:'changed-thread'}]}}]}/>);expect(screen.getByText('Source changed')).toBeTruthy();expect(screen.queryByRole('button',{name:'Review in composer'})).toBeNull();
});
