import { readFile,writeFile,rename,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { insightSchema,type BackgroundInsight } from '../../src/shared/background';
import { resourceKey } from '../context/manager';
const schema=z.object({version:z.literal(1),insights:z.array(insightSchema).max(10000)}).strict();
/** Local evidence history; no authority, source bodies, provider keys, scheduler or executor. */
export class BackgroundStore{
 private records:BackgroundInsight[]=[];private ready:Promise<void>;private queue:Promise<unknown>=Promise.resolve();
 constructor(private filename?:string){this.ready=this.load();}
 private async load(){if(!this.filename)return;try{this.records=schema.parse(JSON.parse(await readFile(this.filename,'utf8'))).insights;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 async all(){await this.ready;await this.queue;return structuredClone(this.records);}
 private mutate(fn:(records:BackgroundInsight[])=>void){const task=this.queue.then(async()=>{await this.ready;const next=structuredClone(this.records);fn(next);const parsed=schema.parse({version:1,insights:next});if(this.filename){await mkdir(path.dirname(this.filename),{recursive:true});await writeFile(this.filename+'.tmp',JSON.stringify(parsed));await rename(this.filename+'.tmp',this.filename);}this.records=parsed.insights;});this.queue=task.catch(()=>{});return task;}
 private transition(i:BackgroundInsight,status:BackgroundInsight['status'],now:number,reason:string){if(i.status===status)return;i.status=status;if(i.transitions.length<100)i.transitions.push({at:new Date(now).toISOString(),status,reason});}
 async invalidate(accountId:string|null,authority:string,now:number,refs?:Map<string,string>){
  const values=await this.all();if(!values.some(i=>i.status==='active'&&(i.accountId!==accountId||i.provenance.authorityRevision!==authority||(i.expiresAt!==null&&Date.parse(i.expiresAt)<=now)||refs&&i.sources.some(r=>refs.get(resourceKey(r))!==r.revision))))return;
  return this.mutate(records=>{for(const i of records)if(i.status==='active'&&(i.accountId!==accountId||i.provenance.authorityRevision!==authority||(i.expiresAt!==null&&Date.parse(i.expiresAt)<=now)||refs&&i.sources.some(r=>refs.get(resourceKey(r))!==r.revision)))this.transition(i,'stale',now,'Source, account, permission or presentation expiry changed.');});
 }
 async commit(values:BackgroundInsight[],accountId:string,authority:string,now:number,refs:Map<string,string>){
  if(values.some(i=>i.accountId!==accountId||i.provenance.authorityRevision!==authority||i.sources.some(r=>r.accountId!==accountId||refs.get(resourceKey(r))!==r.revision)))throw Error('Insight source scope or revision mismatch');
  await this.invalidate(accountId,authority,now,refs);
  await this.mutate(records=>{for(const raw of values){const i=insightSchema.parse(raw);const same=records.find(p=>p.revisionIdentity===i.revisionIdentity&&p.provenance.authorityRevision===authority);
   if(same){if(same.status==='active'||same.status==='stale'){same.expiresAt=i.expiresAt;same.lastCheckedAt=i.lastCheckedAt??i.observedAt;if(same.status==='stale')this.transition(same,'active',now,'Same source revalidated; no new attention item.');}continue;}
   const old=[...records].reverse().find(p=>p.identity===i.identity);if(old){i.supersedes=old.id;if(old.status==='active'||old.status==='stale')this.transition(old,'superseded',now,'A newer source revision replaced this observation.');}
   // A fresh authority revision alone cannot undo a dismissal of unchanged source facts.
   const dismissed=records.find(p=>p.revisionIdentity===i.revisionIdentity&&['dismissed','resolved'].includes(p.status));if(dismissed)continue;
   records.push(i);
  }});
 }
 async disposition(id:string,accountId:string,status:'dismissed'|'resolved',now:number){await this.mutate(records=>{const i=records.find(i=>i.id===id&&i.accountId===accountId);if(!i)throw Error('Insight unavailable for this account');this.transition(i,status,now,status==='resolved'?'Owner reported this was resolved elsewhere; no Mo completion claimed.':'Owner marked this observation as not relevant.');});}
 async sourceRefresh(type:string,accountId:string|null,revisions:{id:string;revision:string}[],now:number){
  const changed=(i:BackgroundInsight)=>i.status==='active'&&i.accountId===accountId&&i.sources.some(r=>r.type===type&&revisions.some(v=>v.id===r.id&&v.revision!==r.revision));
  if(!(await this.all()).some(changed))return;
  await this.mutate(records=>{for(const i of records)if(changed(i))this.transition(i,'stale',now,'A refreshed source revision changed.');});
 }
 async reconcile(completed:Set<string>,now:number){const invalid=(i:BackgroundInsight)=>i.status==='active'&&!completed.has(i.runId);if(!(await this.all()).some(invalid))return;await this.mutate(records=>{for(const i of records)if(invalid(i))this.transition(i,'stale',now,'The originating reviewed run is not complete or is outside retained workflow history.');});}
}
