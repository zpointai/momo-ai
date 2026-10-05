// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {VoiceDiagnostics,VoiceRequestDiagnostics} from '../src/desktop/VoiceDiagnostics';
import {moStateLabel} from '../src/desktop/MoIdentity';
import type {VoiceStatus} from '../src/shared/voice';
import type {AssistantRun} from '../src/shared/assistant';
afterEach(cleanup);
it('labels observable timing without presenting speech submission as audible start',()=>{
 const voice={gateway:null,channel:'online',call:'waiting',sessionId:null,diagnostics:{inboundAt:1000,pinAuthenticatedAt:2000,socketConnectedAt:2500,turns:[{id:crypto.randomUUID(),generation:1,finalAt:3000,forwardedAt:3001,executiveStartedAt:3100,executiveCompletedAt:4200,submittedAt:4300}],interruptions:[],audibleStart:'not-observable'}} satisfies VoiceStatus;
 render(<VoiceDiagnostics voice={voice}/>);expect(screen.getByText('1300 ms')).toBeTruthy();expect(screen.getByText('1100 ms')).toBeTruthy();expect(screen.getByText('Not observable from ConversationRelay events')).toBeTruthy();
});
it('unknown cancelled usage stays explicit and receipt after cancellation is labelled',()=>{
 render(<VoiceRequestDiagnostics run={{calls:[{dispatched:true,usage:null},{dispatched:true,usage:{input:1,output:1},receivedAfterCancellation:true}],voiceDiagnostics:{startedAt:0,cancelReason:'disconnected',resultDisposition:'disconnected'}} as AssistantRun}/>);
 expect(screen.getByText(/Dispatched \/ usage unknown/)).toBeTruthy();expect(screen.getByText(/Received after cancellation/)).toBeTruthy();
});
it('character states remain textual and never imply listening outside a call',()=>{expect(moStateLabel('idle')).toBe('Ready');expect(moStateLabel('connected')).toBe('Connected');expect(moStateLabel('processing')).toBe('Processing your request');expect(moStateLabel('waiting')).toBe('Waiting for you');});
