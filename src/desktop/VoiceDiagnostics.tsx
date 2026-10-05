import type { VoiceStatus } from '../shared/voice';
import type { AssistantRun } from '../shared/assistant';
import { voiceUsageStates } from '../shared/voice-accounting';

export function VoiceRequestDiagnostics({run}:{run:AssistantRun}){
 return <details><summary>Request accounting</summary>{voiceUsageStates(run).map((s,i)=><p key={i}>Request {i+1}: {s.state}{s.receivedAfterCancellation?' · Received after cancellation':''}</p>)}<p>{run.voiceDiagnostics?.cancelReason??'No cancellation recorded'} · {run.voiceDiagnostics?.resultDisposition??'Outcome not recorded'}</p>{run.voiceDiagnostics?.failureCategory&&<p>Failure category: {run.voiceDiagnostics.failureCategory}</p>}{run.voiceDiagnostics?.localAction&&<p>Local task: {run.voiceDiagnostics.localAction.status}</p>}</details>;
}

const duration=(start?:number,end?:number)=>start===undefined||end===undefined?'Not observed':end<start?'Clock skew; inspect timestamps':`${end-start} ms`;
export function VoiceDiagnostics({voice}:{voice?:VoiceStatus}){
 const d=voice?.diagnostics,t=d?.turns.at(-1);
 return <details><summary>Voice timing diagnostics</summary><dl className="settings-facts">
 <div><dt>Gateway status observed</dt><dd>{voice?.gateway?.observedAt?new Date(voice.gateway.observedAt).toLocaleString():'Not observed'}</dd></div>
 <div><dt>Desktop last seen by gateway</dt><dd>{voice?.gateway?.desktopLastSeenAt?new Date(voice.gateway.desktopLastSeenAt).toLocaleString():'Not observed'}</dd></div>
 <div><dt>Voice channel last seen</dt><dd>{voice?.lastSeenAt?new Date(voice.lastSeenAt).toLocaleString():'Not observed'}</dd></div>
 <div><dt>Inbound to PIN authenticated</dt><dd>{duration(d?.inboundAt,d?.pinAuthenticatedAt)}</dd></div>
 <div><dt>PIN to relay connected</dt><dd>{duration(d?.pinAuthenticatedAt,d?.socketConnectedAt)}</dd></div>
 <div><dt>Final recognition to desktop dispatch</dt><dd>{duration(t?.finalAt,t?.forwardedAt)}</dd></div>
 <div><dt>Native Executive</dt><dd>{duration(t?.executiveStartedAt,t?.executiveCompletedAt)}</dd></div>
 <div><dt>Final recognition to speech submission</dt><dd>{duration(t?.finalAt,t?.submittedAt)}</dd></div>
 <div><dt>Audible speech start</dt><dd>Not observable from ConversationRelay events</dd></div>
 <div><dt>Provider interruption events</dt><dd>{d?.interruptions.length??0}</dd></div>
 <div><dt>Last turn cancellation</dt><dd>{t?.cancelReason??'None observed'}</dd></div>
 </dl></details>;
}
