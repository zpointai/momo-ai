// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { render,screen,fireEvent,cleanup,waitFor } from '@testing-library/react';
import { BackgroundSettings,InsightRow } from '../src/desktop/BackgroundIntelligence';
import { defaults,type Snapshot } from '../src/shared/contracts';
import { initialAgentState } from '../src/shared/orchestration';
import type { OrchestrationController } from '../src/desktop/OrchestrationViews';
import { activeInsights,type BackgroundInsight } from '../src/shared/background';
afterEach(cleanup);
it('defaults to off, buffers cadence edits and saves only the new settings field on explicit apply',async()=>{
 const save=vi.fn(async()=>true),command=vi.fn(async()=>true);const controller={data:{state:initialAgentState(),runs:[]},busy:false,loaded:true,error:'',command} as unknown as OrchestrationController;
 const snapshot={settings:{values:defaults,revision:7},google:{activeAccountId:'accountA'}} as unknown as Snapshot;
 const {container}=render(<BackgroundSettings snapshot={snapshot} controller={controller} save={save} busy={false}/>);
 expect((screen.getByLabelText('Enable background intelligence') as HTMLInputElement).checked).toBe(false);expect(save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByLabelText('Enable background intelligence'));fireEvent.change(screen.getByLabelText('Background intelligence cadence'),{target:{value:'180'}});expect(save).not.toHaveBeenCalled();fireEvent.click(screen.getByText('Apply changes'));
 await waitFor(()=>expect(save).toHaveBeenCalledWith({backgroundIntelligence:{enabled:true,cadenceMinutes:180,startupResume:false}},7));expect(container.textContent).not.toMatch(/Jev|DeepSeek|Luna/);
});
it('surfaces active evidence with source review and owner dismissal, never an execute button',()=>{
 const command=vi.fn(async()=>true),openSource=vi.fn(),now=Date.now();const insight={id:'id',accountId:'accountA',title:'Review this thread',summary:'Potential reply request; verify the full thread.',observedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),status:'active',ownerAttention:true,unresolvedQuestions:['Owner intent remains unknown.'],sources:[{id:'mail',type:'email',label:'Existing source'}]} as unknown as BackgroundInsight;
 expect(activeInsights([insight],'accountA',now)).toHaveLength(1);expect(activeInsights([{...insight,status:'dismissed'}],'accountA',now)).toHaveLength(0);expect(activeInsights([insight],'accountA',now+300001)).toHaveLength(0);
 render(<InsightRow insight={insight} controller={{busy:false,command} as unknown as OrchestrationController} openSource={openSource} activity={vi.fn()}/>);fireEvent.click(screen.getByText('Review this thread'));fireEvent.click(screen.getByText('Existing source'));expect(openSource).toHaveBeenCalledWith(insight.sources[0]);fireEvent.click(screen.getByText('Not relevant'));expect(command).toHaveBeenCalledWith({action:'insightDisposition',id:'id',status:'dismissed'});expect(screen.queryByRole('button',{name:/approve|execute|send/i})).toBeNull();
});
