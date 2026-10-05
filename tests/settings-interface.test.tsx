// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import React,{useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {SettingsPage} from '../src/desktop/SettingsPage';
import {defaults,type Snapshot} from '../src/shared/contracts';
import {initialAgentState} from '../src/shared/orchestration';
import {emptyWorkspace} from '../src/shared/assistant';
import type {AssistantController} from '../src/desktop/AssistantViews';
import type {OrchestrationController} from '../src/desktop/OrchestrationViews';
import type {SettingsSection} from '../src/shared/modules';
import {settingEntries} from '../src/shared/settings-catalogue';
afterEach(cleanup);
it('keeps account-specific policy edits attached to the original account and maps every search target to a real element',async()=>{
 const state=initialAgentState(),command=vi.fn(async()=>true);
 const snapshot:Snapshot={version:'isolated-test',settings:{values:defaults,revision:0},credentials: {openai:'missing', deepseek:'missing',jev:'missing',minimax:'missing'},protectionAvailable:true,networkEnabled:false,aiRequestsEnabled:false,storage:'ready',google:{configuration:'configured',connecting:false,activeAccountId:'accountA',accounts:[{id:'accountA',email:'a@example.test',status:'connected'},{id:'accountB',email:'b@example.test',status:'connected'}]}};
 const orchestration={data:{state,runs:[],costs:undefined},command,loaded:true,busy:false,error:''} as unknown as OrchestrationController;
 const controller={workspace:emptyWorkspace,pending:false} as unknown as AssistantController;
 function Harness(){const[account,setAccount]=useState('accountA'),[section,setSection]=useState<SettingsSection>('automation');return <><button onClick={()=>setAccount(account==='accountA'?'accountB':'accountA')}>Switch test account</button><SettingsPage section={section} choose={setSection} snapshot={{...snapshot,google:{...snapshot.google,activeAccountId:account}}} orchestration={orchestration} controller={controller} busy={false} save={vi.fn()} credential={vi.fn()} saveKey={vi.fn()} googleCommand={vi.fn()}/></>;}
 const {container}=render(<Harness/>);
 // Usage history is correctly absent when no native ledger was supplied.
 for(const entry of settingEntries.filter(e=>e.id!=='attempts'))expect(container.querySelector(entry.selector),entry.id).toBeTruthy();
 let scope=screen.getAllByLabelText('email action scope').find(e=>!e.closest('[hidden]')) as HTMLSelectElement;fireEvent.change(scope,{target:{value:'L0'}});
 fireEvent.click(screen.getByRole('button',{name:'Switch test account'}));scope=screen.getAllByLabelText('email action scope').find(e=>!e.closest('[hidden]')) as HTMLSelectElement;expect(scope.value).toBe('L1');
 fireEvent.click(screen.getByRole('button',{name:'Switch test account'}));scope=screen.getAllByLabelText('email action scope').find(e=>!e.closest('[hidden]')) as HTMLSelectElement;expect(scope.value).toBe('L0');
 fireEvent.click(screen.getByRole('button',{name:'Apply email workflow'}));await waitFor(()=>expect(command).toHaveBeenCalledWith(expect.objectContaining({action:'policy',expectedRevision:0,policy:expect.objectContaining({accountId:'accountA',level:'L0'})})));
});
