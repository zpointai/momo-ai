import { useEffect,useState } from 'react';
import type { DesktopBridge } from '../shared/contracts';
import type { MailAction } from '../shared/mail';
import { workspaceEvents,type ResourceRef } from '../shared/modules';
export function mailActionRef(action:MailAction):ResourceRef{return{module:'inbox',connector:'local',type:'mailAction',id:action.id,accountId:action.accountId,profile:'local',revision:action.hash,label:action.draft?.fields.subject||action.kind,provenance:{kind:'user',runId:null,fetchedAt:action.createdAt},access:'review',retention:{kind:'retained',expiresAt:null}};}
export function MailActivity({bridge,accountId,open}:{bridge:DesktopBridge;accountId:string|null;open(ref:ResourceRef):void}){
 const [actions,setActions]=useState<MailAction[]>([]);const [error,setError]=useState('');
 useEffect(()=>{let live=true;if(accountId)void bridge.mailCommand({action:'list',accountId}).then(r=>{if(live){if(r.ok)setActions(r.value.actions);else setError(r.error.message);}}).catch(()=>{if(live)setError('Mail action history unavailable.');});return()=>{live=false;};},[bridge,accountId]);
 return <>{error&&<p role="alert">{error}</p>}{actions.map(a=><article className="activity-item" key={a.id}><div className="card-heading"><strong>Mail · {a.kind}</strong><span className="tag subtle">{a.status==='pending'&&Date.parse(a.expiresAt)<Date.now()?'Review expired':a.status}</span></div><p>{a.draft?.fields.subject}</p><p>{a.detail}</p><small>{new Date(a.createdAt).toLocaleString()} · Selected message only</small><button className="secondary small" onClick={()=>open(mailActionRef(a))}>Inspect mail action</button></article>)}</>;
}
export function NativeApprovalSummary({bridge,accountId,open}:{bridge:DesktopBridge;accountId:string|null;open():void}){
 const [count,setCount]=useState<number|null>(null);const [revision,setRevision]=useState(0);
 useEffect(()=>workspaceEvents.subscribe(e=>{if(e.type==='resource.changed'&&e.resource.accountId===accountId)setRevision(n=>n+1);}),[accountId]);
 useEffect(()=>{let active=true;setCount(null);void Promise.all([bridge.calendarAction({action:'list'}),accountId?bridge.mailCommand({action:'list',accountId}):Promise.resolve(null)]).then(([calendar,mail])=>{if(!active)return;if(!calendar.ok||mail&&!mail.ok)return;setCount(calendar.value.actions.filter(a=>a.draft.accountId===accountId&&a.status==='pending'&&Date.parse(a.expiresAt)>Date.now()).length+(mail?.ok?mail.value.actions.filter(a=>a.kind==='send'&&a.status==='pending'&&Date.parse(a.expiresAt)>Date.now()).length:0));}).catch(()=>{});return()=>{active=false;};},[bridge,accountId,revision]);
 return <button className="text-button" onClick={open}>{count===null?'Inspect mail & Calendar approvals':`${count} mail & Calendar approvals`} · Work</button>;
}
