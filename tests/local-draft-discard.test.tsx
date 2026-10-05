// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
// Isolated component contracts only. These fixtures never enter a desktop profile or captures.
import React from 'react';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {InboxWorkspace,type InboxWorkspaceProps} from '../src/desktop/InboxWorkspace';
import {defaults,type DesktopBridge,type Snapshot,type Result} from '../src/shared/contracts';
import {emptyGoogle} from '../src/shared/google';
import {initialAgentState} from '../src/shared/orchestration';
import {emptyWorkspace} from '../src/shared/assistant';
import type {LocalMailDraft,MailCommand,MailResult} from '../src/shared/mail';

beforeAll(()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(){this.setAttribute('open','');}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(){this.removeAttribute('open');}});
});
afterEach(cleanup);
const date='2026-09-24T10:00:00.000Z';
function setup(remote=false){
 let records:LocalMailDraft[]=[{id:crypto.randomUUID(),accountId:'a',from:'a@example.test',mode:'compose',sourceMessageId:null,threadId:null,inReplyTo:null,references:'',fields:{to:'',cc:'',bcc:'',subject:'Isolated component fixture',body:'Retained unit-test content'},revision:3,contentRevision:1,createdAt:date,updatedAt:date,status:remote?'remote':'local',remoteDraftId:remote?'remote-unit-id':null,remoteRevision:remote?1:null,sentMessageId:null}];
 const original=records[0];const commands:MailCommand[]=[];let onDiscard:(c:MailCommand)=>Promise<Result<MailResult>>=async()=>({ok:true,value:{drafts:[],actions:[],thread:null,review:null}});
 const result=():MailResult=>({drafts:records,actions:[],thread:null,review:null});
 const bridge={readInbox:vi.fn(async()=>({ok:true,value:{accountId:'a',fetchedAt:date,cached:false,messages:[],failed:0,nextPageToken:null}})),mailCommand:vi.fn(async(c:MailCommand)=>{commands.push(c);if(c.action==='discardLocal')return onDiscard(c);return {ok:true,value:result()};})} as unknown as DesktopBridge;
 const snapshot:Snapshot={version:'unit-test',settings:{values:defaults,revision:0},credentials: {openai:'missing', deepseek:'missing',jev:'missing',minimax:'missing'},protectionAvailable:true,networkEnabled:false,aiRequestsEnabled:false,storage:'ready',google:{...emptyGoogle,activeAccountId:'a',accounts:[{id:'a',email:'a@example.test',status:'connected',calendarWrite:false,mailCompose:false,mailSend:false,mailModify:false}]}};
 const props={snapshot,bridge,controller:{workspace:emptyWorkspace},orchestration:{data:{state:initialAgentState(),runs:[]},busy:false,command:vi.fn()},settings:vi.fn(),review:vi.fn(),newTask:vi.fn(),openSource:vi.fn()} as unknown as InboxWorkspaceProps;
 const openList=async()=>{fireEvent.click(await screen.findByRole('button',{name:/Local drafts/}));return screen.getByRole('region',{name:'Local drafts'});};
 const openEditor=async()=>{const list=await openList();fireEvent.click(within(list).getByRole('button',{name:/Isolated component fixture/}));return screen.getByRole('region',{name:'Local mail composer'});};
 return {props,original,commands,openList,openEditor,discard:(f:typeof onDiscard)=>{onDiscard=f;},records:(value:LocalMailDraft[])=>{records=value;}};
}
it('shows matching list/editor actions and cancel/close keep the persisted draft',async()=>{
 const f=setup();render(<InboxWorkspace {...f.props}/>);let list=await f.openList();fireEvent.click(within(list).getByRole('button',{name:'Discard local draft…'}));expect(screen.getByRole('dialog')).toBeTruthy();expect(screen.getByRole('button',{name:'Keep draft'})).toBe(document.activeElement);fireEvent.click(screen.getByRole('button',{name:'Keep draft'}));expect(f.commands.filter(c=>c.action==='discardLocal')).toHaveLength(0);
 list=screen.getByRole('region',{name:'Local drafts'});fireEvent.click(within(list).getByRole('button',{name:/Isolated component fixture/}));fireEvent.click(screen.getByRole('button',{name:'Discard local draft…'}));fireEvent.click(screen.getByRole('button',{name:'Keep draft'}));expect(screen.getByRole('textbox',{name:'Mail body'})).toHaveProperty('value',f.original.fields.body);fireEvent.click(screen.getByRole('button',{name:'Close — keep draft'}));expect(f.commands.filter(c=>c.action!=='list')).toHaveLength(0);expect(screen.getByRole('button',{name:/Local drafts 1/})).toBeTruthy();
});
it('submits the exact revision once, waits for native success, then removes only the matching editor',async()=>{
 const f=setup();let finish!:(r:Result<MailResult>)=>void;f.discard(()=>new Promise(r=>{finish=r;}));render(<InboxWorkspace {...f.props}/>);await f.openEditor();fireEvent.click(screen.getByRole('button',{name:'Discard local draft…'}));const button=screen.getByRole('button',{name:'Discard draft',exact:true});fireEvent.click(button);fireEvent.click(button);
 expect(f.commands.filter(c=>c.action==='discardLocal')).toEqual([{action:'discardLocal',accountId:'a',id:f.original.id,expectedRevision:3}]);expect(screen.getByRole('textbox',{name:'Mail body',hidden:true})).toHaveProperty('value',f.original.fields.body);
 await act(async()=>finish({ok:true,value:{drafts:[],actions:[],thread:null,review:null}}));expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('region',{name:'Local mail composer'})).toBeNull();expect(screen.getByRole('button',{name:/Local drafts 0/})).toBeTruthy();
});
it('preserves content on a stale-confirmation rejection and does not silently retry a newer revision',async()=>{
 const f=setup();f.discard(async()=>({ok:false,error:{code:'conflict',message:'Draft changed. Reopen and review discard again.'}}));render(<InboxWorkspace {...f.props}/>);await f.openEditor();fireEvent.click(screen.getByRole('button',{name:'Discard local draft…'}));fireEvent.click(screen.getByRole('button',{name:'Discard draft',exact:true}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Keep draft'}));expect(screen.getByRole('textbox',{name:'Mail body'})).toHaveProperty('value',f.original.fields.body);expect(f.commands.filter(c=>c.action==='discardLocal')).toHaveLength(1);
});
it('labels linked remote copies precisely and makes no discard call when cancelled',async()=>{
 const f=setup(true);render(<InboxWorkspace {...f.props}/>);await f.openEditor();fireEvent.click(screen.getByRole('button',{name:'Discard local copy…'}));expect(screen.getByText(/The Gmail draft remains/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Keep draft'}));expect(f.commands.filter(c=>c.action==='discardLocal')).toHaveLength(0);
});
it('an untouched empty composer creates no draft and offers no discard',async()=>{
 const f=setup();render(<InboxWorkspace {...f.props}/>);fireEvent.click(screen.getByRole('button',{name:'Compose',exact:true}));expect(screen.queryByRole('button',{name:'Discard local draft…'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Close empty composer'}));expect(screen.queryByRole('dialog')).toBeNull();await waitFor(()=>expect(f.commands.every(c=>c.action==='list')).toBe(true));
});
it('a late discard result cannot replace the newly selected account',async()=>{
 const f=setup();let finish!:(r:Result<MailResult>)=>void;f.discard(()=>new Promise(r=>{finish=r;}));const view=render(<InboxWorkspace {...f.props}/>);await f.openEditor();fireEvent.click(screen.getByRole('button',{name:'Discard local draft…'}));fireEvent.click(screen.getByRole('button',{name:'Discard draft',exact:true}));
 const other={...f.original,id:crypto.randomUUID(),accountId:'b',from:'b@example.test',fields:{...f.original.fields,subject:'Other isolated account'}};f.records([other]);view.rerender(<InboxWorkspace {...f.props} snapshot={{...f.props.snapshot,google:{...f.props.snapshot.google,activeAccountId:'b',accounts:[{...f.props.snapshot.google.accounts[0],id:'b',email:'b@example.test'}]}}}/>);
 await act(async()=>finish({ok:true,value:{drafts:[],actions:[],thread:null,review:null}}));expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('button',{name:/Local drafts 1/})).toBeTruthy();
});
