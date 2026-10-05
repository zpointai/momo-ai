import {type SettingsSave} from './SettingsEditing';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import type { DesktopBridge, Snapshot } from '../shared/contracts';
import { emptyWorkspace, taskDue, type AssistantWorkspace, type LocalTask, type RunRequest, type TaskCommand, type TaskDraft } from '../shared/assistant';

export function useAssistantWorkspace(bridge?: DesktopBridge) {
  const [workspace, setWorkspace] = useState<AssistantWorkspace>(emptyWorkspace);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const apply = (value: AssistantWorkspace) => { if (alive) setWorkspace(value); };
    const off = bridge.onWorkspaceChanged(apply);
    void bridge.getWorkspace().then(r => { if (r.ok) apply(r.value); else if (alive) setError(r.error.message); }).catch(() => { if (alive) setError('Local history is unavailable. Restart MoMo.'); });
    return () => { alive = false; off(); };
  }, [bridge]);
  const start = useCallback(async (input: RunRequest) => {
    if (!bridge || locked.current) return false;
    locked.current = true; setPending(true); setError('');
    try {
      const result = await bridge.startRun(input);
      if (!result.ok) {setError(result.error.message);return false;}
      else { const current = await bridge.getWorkspace(); if (current.ok) setWorkspace(current.value); return true; }
    } catch { setError('The request could not reach MoMo. Check history before trying again.'); return false; }
    finally { locked.current = false; setPending(false); }
  }, [bridge]);
  const task = useCallback(async (command: TaskCommand) => {
    if (!bridge) return false;
    setError('');
    try { const result = await bridge.taskCommand(command); if (result.ok) { setWorkspace(result.value); return true; } setError(result.error.message); }
    catch { setError('The task could not be saved. Refresh before trying again.'); }
    return false;
  }, [bridge]);
  const cancel = async (id: string) => { const result = await bridge?.cancelRun(id); if (result && !result.ok) setError(result.error.message); };
  return { workspace, error, setError, start, task, cancel, pending };
}
export type AssistantController = ReturnType<typeof useAssistantWorkspace>;

export function TaskBoard({controller,timezone,draftTitle,clearDraft}:{controller:AssistantController;timezone:string;draftTitle:string|null;clearDraft():void}) {
  const [editing,setEditing]=useState<LocalTask|null>(null); const [open,setOpen]=useState(false); const [title,setTitle]=useState(''); const [kind,setKind]=useState<'none'|'date'|'instant'>('none'); const [date,setDate]=useState(''); const [at,setAt]=useState(''); const [saving,setSaving]=useState(false);
  const createId=useRef(crypto.randomUUID());
  useEffect(()=>{if(draftTitle!==null){setOpen(true);setEditing(null);setTitle(draftTitle);setKind('none');setDate('');setAt('');createId.current=crypto.randomUUID();}},[draftTitle]);
  const begin=(task?:LocalTask)=>{clearDraft();setEditing(task??null);setTitle(task?.title??'');setKind(task?.due.kind??'none');setDate(task?.due.kind==='date'?task.due.date:'');const instant=task?.due.kind==='instant'?new Date(task.due.at):null;setAt(instant?new Date(+instant-instant.getTimezoneOffset()*60000).toISOString().slice(0,16):'');setOpen(true);createId.current=crypto.randomUUID();};
  const save=async()=>{if(saving||!title.trim())return;const computerZone=Intl.DateTimeFormat().resolvedOptions().timeZone;const due:TaskDraft['due']=kind==='date'?{kind,date,timezone}:kind==='instant'?{kind,at:new Date(at).toISOString(),timezone:computerZone}:{kind:'none'};setSaving(true);try{const draft={title:title.trim(),due};const ok=await controller.task(editing?{action:'update',id:editing.id,expectedRevision:editing.revision,draft,status:editing.status}:{action:'create',id:createId.current,draft});if(ok){setOpen(false);clearDraft();}}finally{setSaving(false);}};
  return <section className="task-board"><div className="section-heading"><h2>Local tasks & reminders</h2><button className="secondary small" onClick={()=>begin()}><Plus size={14}/> Add task</button></div><p className="fine-print">Reminders appear here while MoMo is open. Tasks stay on this computer.</p>
    {open && <form className="task-form" onSubmit={e=>{e.preventDefault();void save();}}><label>Task<input autoFocus aria-label="Task title" value={title} maxLength={240} required onChange={e=>setTitle(e.target.value)}/></label><div className="task-form-row"><label>When<select aria-label="Task due kind" value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="none">No due date</option><option value="date">On a date</option><option value="instant">At a time</option></select></label>{kind==='date'&&<label>Date · {timezone}<input type="date" aria-label="Task due date" required value={date} onChange={e=>setDate(e.target.value)}/></label>}{kind==='instant'&&<label>Time · this computer<input type="datetime-local" aria-label="Task due time" required value={at} onChange={e=>setAt(e.target.value)}/></label>}</div><div className="task-form-row"><button className="primary small" disabled={saving||!title.trim()}>Save local task</button><button type="button" className="secondary small" disabled={saving} onClick={()=>{setOpen(false);clearDraft();}}>Cancel</button></div></form>}
    {!controller.workspace.tasks.length && <p className="task-empty">No tasks yet. Add one here or review a suggestion from Mo.</p>}
    <div className="task-list">{controller.workspace.tasks.map(task=><div className={'task-row '+(task.status==='done'?'is-done':'')} key={task.id}><button aria-label={(task.status==='done'?'Reopen ':'Complete ')+task.title} className="task-check" onClick={()=>void controller.task({action:'update',id:task.id,expectedRevision:task.revision,draft:{title:task.title,due:task.due},status:task.status==='done'?'open':'done'})}>{task.status==='done'&&<Check size={14}/>}</button><div><strong>{task.title}</strong><small>{task.due.kind==='none'?'No due date':task.due.kind==='date'?task.due.date+' · '+task.due.timezone:new Intl.DateTimeFormat('en-GB',{timeZone:task.due.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(task.due.at))+' · '+task.due.timezone}</small></div><button className="text-button" onClick={()=>begin(task)}>Edit</button><button className="icon-button" aria-label={'Delete '+task.title} onClick={()=>{if(window.confirm('Delete this local task?'))void controller.task({action:'delete',id:task.id,expectedRevision:task.revision});}}><X size={14}/></button></div>)}</div></section>;
}
export function DueReminders({controller}:{controller:AssistantController}) {
  const [now,setNow]=useState(new Date());useEffect(()=>{const timer=setInterval(()=>setNow(new Date()),30000);return()=>clearInterval(timer);},[]);
  const due=controller.workspace.tasks.filter(t=>taskDue(t,now));
  return due.length ? <div className="reminder-banner" role="status"><strong>{due.length} task{due.length===1?'':'s'} due</strong>{due.slice(0,3).map(task=><div key={task.id}><span>{task.title}</span><button className="text-button" onClick={()=>void controller.task({action:'dismiss',id:task.id,expectedRevision:task.revision})}>Dismiss reminder</button></div>)}</div>:null;
}
export function HistoryList({controller,accountId,open}:{controller:AssistantController;accountId:string|null;open(id:string):void}) {
  const runs=controller.workspace.runs.filter(r=>r.accountId===accountId);
  return <section className="history-list"><div className="section-heading"><h2>Recent conversations</h2><span>Saved for 30 days</span></div>{!runs.length?<p className="fine-print">Your conversations and briefing results will appear here.</p>:runs.slice(0,12).map(run=><button key={run.id} onClick={()=>open(run.conversationId)}><span>{run.prompt}</span><small>{run.provider} · {run.status} · {new Date(run.createdAt).toLocaleDateString()}</small></button>)}</section>;
}
export function ProviderSettings({snapshot,busy,save,credential,saveKey,controller}:{snapshot:Snapshot;busy:boolean;save:SettingsSave;credential(provider:'deepseek'|'jev'|'openai',remove:boolean):void;saveKey(provider:'deepseek'|'jev'|'openai',secret:string):Promise<void>;controller:AssistantController}) {
 const providers=[{id:'deepseek',label:'DeepSeek',description:'deepseek-flash · conversation & briefings'},{id:'jev',label:'Jev',description:'jev-latest · workflow decisions & quality review'},{id:'openai',label:'OpenAI',description:'GPT-6 Luna · optional Mo Executive'}] as const;
 return <section className="settings-card"><h2>AI providers</h2><p>Mo’s Executive model coordinates requests. DeepSeek remains the specialist model; Jev supplies bounded advisory signals. Saving a key never activates Luna.</p>
  {providers.map(({id:provider,label,description})=>{const isOpenAI=provider==='openai',enabled=provider==='deepseek'?snapshot.settings.values.deepseekEnabled:provider==='jev'?snapshot.settings.values.jevEnabled:false,configured=snapshot.credentials[provider]==='configured',verification=snapshot.openaiVerification;
   const latest=controller.workspace.runs.find(r=>r.provider===provider&&r.accountId===null);
   return <div className="provider-block" data-provider={provider} key={provider}>
    <div className="provider-row"><div><strong>{label}</strong><small>{description}</small><span className="provider-state">{configured?(isOpenAI?'Key saved':enabled?'Key saved · requests enabled':'Key saved · requests off'):snapshot.credentials[provider]==='error'?'Saved key unavailable':'No key saved'}</span>{isOpenAI&&configured&&<span className="provider-verification">{verification?.status==='succeeded'?'API access verified by an explicit test':verification?.status==='running'?'Testing API access…':verification?'API access not verified · last test '+verification.status:'API access not tested in this app'}</span>}</div><button className="secondary small" disabled={busy||!snapshot.protectionAvailable} onClick={()=>credential(provider,false)}>Import key file</button></div>
    <details><summary>Save or replace {label} key</summary><form className="key-form" onSubmit={e=>{e.preventDefault();const input=e.currentTarget.elements.namedItem('secret') as HTMLInputElement;const secret=input.value.trim();input.value='';void saveKey(provider,secret);}}><label>{label} API key<input type="password" name="secret" aria-label={label+' API key'} placeholder="Paste a key to save or replace it" autoComplete="off" spellCheck={false} minLength={8} maxLength={2048} required disabled={busy||!snapshot.protectionAvailable}/></label><button className="secondary small" disabled={busy||!snapshot.protectionAvailable}>Save key</button></form></details>
    {isOpenAI?<label className="setting-row"><span>Mo Executive model<small>Applies to new Mo requests. Existing specialist workflows keep their model.</small></span><select aria-label="Mo Executive model" value={snapshot.settings.values.executiveModel} disabled={busy||controller.workspace.runs.some(r=>r.status==='running')} onChange={e=>save({executiveModel:e.target.value as 'deepseek-flash'|'gpt-6-luna'})}><option value="deepseek-flash">DeepSeek Flash</option><option value="gpt-6-luna" disabled={!configured}>GPT-6 Luna</option></select></label>:<label className="setting-row"><span>Enable {label} requests<small>{provider==='deepseek'?'Messages and selected Google summaries go to DeepSeek when requested.':'Direct urgency assessment shares a selected snippet; workflows use their saved sharing policy.'}</small></span><input aria-label={'Enable '+label+' requests'} type="checkbox" checked={enabled} disabled={busy||!configured} onChange={e=>save({[provider==='deepseek'?'deepseekEnabled':'jevEnabled']:e.target.checked})}/></label>}
    <div className="provider-test-row"><button className="secondary small" disabled={(isOpenAI?busy||!configured:!enabled)||provider==='deepseek'&&snapshot.settings.values.executiveModel!=='deepseek-flash'||controller.pending||controller.workspace.runs.some(r=>r.status==='running')} onClick={()=>void controller.start({id:crypto.randomUUID(),conversationId:crypto.randomUUID(),accountId:null,includeGoogle:false,mode:isOpenAI?'openai-test':provider==='jev'?'classify':'chat',prompt:isOpenAI?'Test OpenAI access with one fixed, non-private request.':provider==='jev'?'Synthetic test: Please review the sample report by tomorrow.':'Synthetic connection test. Reply briefly that you can respond. No private data is included.'})}>Test {label} · one request</button>{snapshot.credentials[provider]!=='missing'&&<button className="text-button" disabled={busy} onClick={()=>credential(provider,true)}>Remove key</button>}<small>{isOpenAI?'Paid request · fixed test only · up to 512 output tokens':(controller.workspace.callsToday[provider]??0)+' direct attempts today · shared totals above'}</small></div>
    {isOpenAI?verification&&<p className="fine-print" role="status">Last OpenAI request: {verification.status} · {new Date(verification.at).toLocaleString()}</p>:latest&&<p className="fine-print" role="status">Last text-only {label} request: {latest.status}{latest.error?' · '+latest.error:''}</p>}
   </div>;
  })}
  {controller.error&&<p role="alert">{controller.error}</p>}
  <p className="fine-print">Provider enablement saves immediately. Saving or importing a key makes no API request. Tests are paid and start only when pressed, with no automatic retry. OpenAI tests use fixed non-private input, a 30-second timeout and existing usage accounting; costs without a verified tariff remain unpriced. Key fields clear on saving; stored keys are never shown again.</p>
 </section>;
}
