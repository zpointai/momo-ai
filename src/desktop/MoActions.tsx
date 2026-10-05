import { useRef,useState } from 'react';
import type { AssistantRun } from '../shared/assistant';
import type { DesktopBridge } from '../shared/contracts';
import type { ResourceRef } from '../shared/modules';
import type { OrchestrationController } from './OrchestrationViews';
import { stableTaskId } from './WorkspaceControls';

export function MoActions({run,bridge,orchestration,openSource}:{run:AssistantRun;bridge:DesktopBridge;orchestration:OrchestrationController;openSource(ref:ResourceRef):void}){
  const [reply,setReply]=useState(run.result?.reply?.body??''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [reviewAt,setReviewAt]=useState(''),[expiresAt,setExpiresAt]=useState('');const lock=useRef(false);
  const proposal=run.result?.responsibility,task=run.sources.find(s=>s.id===proposal?.sourceId);
  const replySource=run.sources.find(s=>s.id===run.result?.reply?.sourceId);
  async function saveReply(){if(lock.current||!replySource||!run.accountId)return;lock.current=true;setBusy(true);setMessage('');try{
    const id=await stableTaskId(run.id+':reply'),result=await bridge.mailCommand({action:'compose',id,accountId:run.accountId,mode:'reply',sourceMessageId:replySource.resourceId,body:reply});
    if(!result.ok)throw Error(result.error.message);
    const draft=result.value.drafts.find(d=>d.id===id);if(!draft)throw Error('Local draft could not be confirmed. Check Inbox drafts.');
    setMessage('Reply saved locally. Nothing sent.');openSource({module:'inbox',connector:'local',type:'mailDraft',id,accountId:run.accountId,profile:'local',revision:String(draft.revision),label:'Local reply draft',provenance:{kind:'user',runId:run.id,fetchedAt:draft.updatedAt},access:'review',retention:{kind:'retained',expiresAt:null}});
  }catch(e){setMessage(e instanceof Error?e.message:'Local reply unavailable.');}finally{lock.current=false;setBusy(false);}}
  async function saveResponsibility(){if(lock.current||!proposal||!task||!reviewAt||!expiresAt)return;lock.current=true;setBusy(true);try{
    const ok=await orchestration.command({action:'createDesktopResponsibility',id:await stableTaskId(run.id+':responsibility'),conversationId:run.conversationId,taskId:task.resourceId,objective:proposal.objective,reviewAt:new Date(reviewAt).toISOString(),expiresAt:new Date(expiresAt).toISOString()});
    if(ok)setMessage('Responsibility saved. Resume it here when you are ready.');
  }finally{lock.current=false;setBusy(false);}}
  return <>{run.result?.reply&&<details className="mo-action-review"><summary>Review local reply</summary><label>Reply text<textarea value={reply} maxLength={5000} onChange={e=>setReply(e.target.value)}/></label><p>Saved on this computer. Sending or saving to Gmail still requires the existing mail review.</p><button className="secondary small" disabled={busy||!reply.trim()} onClick={()=>void saveReply()}>Save local reply</button></details>}
  {proposal&&task&&<details className="mo-action-review"><summary>Review responsibility</summary><p>{proposal.objective}</p><p>Scope: {task.label}. Trigger: resume here when you choose. No automatic observation or schedule.</p><label>Review by · computer time<input type="datetime-local" value={reviewAt} onChange={e=>setReviewAt(e.target.value)}/></label><label>Expires · computer time<input type="datetime-local" value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}/></label><button className="secondary small" disabled={busy||!reviewAt||!expiresAt} onClick={()=>void saveResponsibility()}>Approve responsibility</button></details>}
  {message&&<p role="status">{message}</p>}
  {run.result?.openSituation&&<button className="secondary small" onClick={()=>openSource({module:'situation',connector:'situation',type:'situation-status',id:run.result!.openSituation!,accountId:run.accountId,profile:'local',revision:run.id,label:run.result!.openSituation==='traffic'?'Traffic':'Weather',provenance:{kind:'assistant',runId:run.id,fetchedAt:run.createdAt},access:'read',retention:{kind:'transient',expiresAt:null}})}>Open {run.result.openSituation==='traffic'?'traffic':'Weather'} in Situation View</button>}</>;
}
export function MoResponsibilities({orchestration,accountId,openConversation,openSource,openWork}:{orchestration:OrchestrationController;accountId:string|null;openWork?(id:string):void;openConversation(id:string):void;openSource(ref:ResourceRef):void}){
  const runs=orchestration.data.runs.filter(r=>r.desktopResponsibility&&r.event.accountId===accountId);
  if(!runs.length)return null;
  return <details className="mo-responsibilities"><summary>Responsibilities · {runs.filter(r=>!['completed','cancelled','expired'].includes(r.desktopResponsibility!.status)).length} open</summary>{runs.map(run=>{const r=run.desktopResponsibility!,closed=['completed','cancelled','expired'].includes(r.status),due=Date.parse(r.reviewAt)<=Date.now()||Date.parse(r.expiresAt)<=Date.now();return <article key={run.id}><strong>{r.objective}</strong><p>{due&&!closed?'Review or expiry due':r.status} · {r.proactive?'approved native triggers':'owner-resume only'}</p>{r.proactive&&<p>{r.proactive.waitingReason}</p>}<small>Review {new Date(r.reviewAt).toLocaleString()} · Expires {new Date(r.expiresAt).toLocaleString()}</small><button className="text-button" onClick={()=>openSource(r.resource)}>{r.proactive?'Open source':'Open task'}</button>{r.proactive&&<button className="text-button" onClick={()=>openWork?.(run.id)}>Inspect tracking in Work</button>}{!closed&&!r.proactive&&<div><button className="secondary small" disabled={orchestration.busy||due} onClick={()=>void orchestration.command({action:'changeDesktopResponsibility',id:run.id,expectedRevision:r.revision,change:'resume'}).then(ok=>{if(ok)openConversation(r.conversationId);})}>Resume conversation</button><button className="text-button" disabled={orchestration.busy} onClick={()=>void orchestration.command({action:'changeDesktopResponsibility',id:run.id,expectedRevision:r.revision,change:'complete'})}>Complete</button><button className="text-button" disabled={orchestration.busy} onClick={()=>void orchestration.command({action:'changeDesktopResponsibility',id:run.id,expectedRevision:r.revision,change:'cancel'})}>Cancel responsibility</button></div>}</article>;})}</details>;
}
