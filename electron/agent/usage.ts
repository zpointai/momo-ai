import { randomUUID } from 'node:crypto';
import { budgetBoundarySchema,type BudgetBoundary } from '../../src/shared/usage';
import type Database from 'better-sqlite3';
import { AppError } from '../errors';
import { settingsSchema } from '../../src/shared/contracts';
import { costEntrySchema,costsSchema,dollarsToNano,pricedTokens,rateSchema,seedRates,type CostEntry,type CostPeriod,type Rate } from '../../src/shared/usage';
import type { Usage } from '../../src/shared/assistant';
import type { EligibilityIssue } from '../../src/shared/briefing';
export type UsageReservation={runId:string;id:string;provider:'jev'|'deepseek';daily:number;providerDaily:number;perRun:number;at:string;model?:string;profile?:string;purpose?:'ordinary'|'development';maxTokens?:number;dispatched?:boolean};
// v4 compatibility permits bounded maintenance/evaluation against the existing ledger
// without opening or migrating the user's content store. Normal startup migrates to v5.
function assistantTable(db:Database.Database){return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_usage'").get()?'assistant_usage':'assistant_runs';}
export function usageSummary(db:Database.Database,day=new Date().toISOString().slice(0,10)){
 const table=assistantTable(db);const count=(provider:string)=>(db.prepare(`SELECT (SELECT COUNT(*) FROM agent_usage WHERE at>=? AND provider=?)+(SELECT COUNT(*) FROM ${table} WHERE created_at>=? AND provider=?) AS n`).get(day,provider,day,provider) as {n:number}).n;
 const deepseek=count('deepseek'),jev=count('jev'),openai=count('openai');return{day,deepseek,jev,openai,total:deepseek+jev+openai};
}
/** The single transactional ledger reservation used by orchestration and the capped test harness. */
export function capacityIssue(db:Database.Database,input:UsageReservation):EligibilityIssue|null{
 const run=(db.prepare('SELECT COUNT(*) AS n FROM agent_usage WHERE run_id=?').get(input.runId) as {n:number}).n;
 const saved=db.prepare('SELECT value FROM settings WHERE id=1').get() as {value:string}|undefined;
 const limits=saved?settingsSchema.parse(JSON.parse(saved.value)).aiLimits:null;
 const message=run>=(limits?.callsPerWorkflow??input.perRun)?'This workflow’s request capacity is reached.':null;
 return message?{code:'capacity',message,target:'limits',label:'Review response capacity'}:null;
}
export class DispatchBlocked extends AppError{}
export function reserveAgentUsage(db:Database.Database,input:UsageReservation){return db.transaction(()=>{
 if(capacityIssue(db,input))throw new DispatchBlocked('unavailable','WORKFLOW_BUDGET_EXHAUSTED');
 if(input.model)reserveCost(db,{...input,requestedModel:input.model,profile:input.profile??'workflow',purpose:input.purpose??'ordinary',maxTokens:input.maxTokens??0,dispatched:true});
 db.prepare('INSERT INTO agent_usage VALUES (?, ?, ?, ?)').run(input.id,input.runId,input.provider,input.at);return true;
 }).immediate();}

export function registerRates(db:Database.Database,rates:Rate[]) {
 for(const value of rates){const rate=rateSchema.parse(value);const existing=db.prepare('SELECT payload FROM usage_rates WHERE id=?').get(rate.id) as {payload:string}|undefined;
  if(existing&&existing.payload!==JSON.stringify(rate))throw new AppError('conflict','A price version is immutable. Import the changed tariff with a new version ID.');
  db.prepare('INSERT OR IGNORE INTO usage_rates VALUES (?,?)').run(rate.id,JSON.stringify(rate));
 }
}
export function initializeCosts(db:Database.Database){
 db.exec('CREATE TABLE usage_rates (id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE usage_costs (id TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX usage_costs_at ON usage_costs(at)');
 registerRates(db,seedRates);
 // Existing durable attempts remain unknown: the new observation date does not establish historical pricing.
 for(const r of db.prepare(`SELECT id,run_id AS runId,provider,at FROM agent_usage UNION ALL SELECT id,id AS runId,provider,created_at AS at FROM assistant_usage`).all() as {id:string;runId:string;provider:'jev'|'deepseek';at:string}[]){
  const metadata=(db.prepare(`SELECT json_extract(c.value,'$.requestedModel') requestedModel,json_extract(c.value,'$.reportedModel') reportedModel,json_extract(c.value,'$.usage') usage,json_extract(c.value,'$.purpose') profile,json_extract(a.payload,'$.status') outcome FROM agent_runs a,json_each(a.payload,'$.calls') c WHERE json_extract(c.value,'$.id')=?`).get(r.id)??db.prepare(`SELECT json_extract(payload,'$.requestedModel') requestedModel,json_extract(payload,'$.reportedModel') reportedModel,json_extract(payload,'$.usage') usage,json_extract(payload,'$.mode') profile,json_extract(payload,'$.status') outcome FROM assistant_runs WHERE id=?`).get(r.id)) as {requestedModel:string;reportedModel:string|null;usage:string|null;profile:string;outcome:string}|undefined;
  const u:Usage|null=metadata?.usage?JSON.parse(metadata.usage):null;
  const entry:CostEntry={...r,requestedModel:metadata?.requestedModel??'historical — not retained in ledger',reportedModel:metadata?.reportedModel??null,profile:metadata?.profile??'historical',purpose:'unclassified',outcome:metadata?.outcome??'historical',availability:'unknown',input:u?.input??null,output:u?.output??null,cacheHit:u?.cacheHit??null,cacheMiss:u?.cacheMiss??null,reasoning:u?.reasoning??null,rateId:null,low:null,high:null,reservation:null,dispatched:true};
  db.prepare('INSERT OR IGNORE INTO usage_costs VALUES (?,?,?)').run(entry.id,entry.at,JSON.stringify(entry));
 }
}
function settings(db:Database.Database){const row=db.prepare('SELECT value FROM settings WHERE id=1').get() as {value:string};return settingsSchema.parse(JSON.parse(row.value));}
function activeBoundary(db:Database.Database):BudgetBoundary|null{
 const row=db.prepare('SELECT payload FROM budget_boundaries ORDER BY rowid DESC LIMIT 1').get() as {payload:string}|undefined;
 return row?budgetBoundarySchema.parse(JSON.parse(row.payload)):null;
}
function legacyUnknownIds(db:Database.Database,at:string){
 // Only settled legacy exposure is eligible. Reservations and unresolved work never cross this boundary.
 return (db.prepare('SELECT payload FROM usage_costs WHERE at<? ORDER BY id').all(at) as {payload:string}[]).map(r=>costEntrySchema.parse(JSON.parse(r.payload))).filter(r=>{
  if(r.purpose!=='unclassified'||r.high!==null||r.reservation!==null||['reserved','running','queued','unknown','interrupted'].includes(r.outcome))return false;
  const workflow=db.prepare('SELECT payload FROM agent_runs WHERE id=?').get(r.runId) as {payload:string}|undefined;
  const direct=db.prepare('SELECT payload FROM assistant_runs WHERE id=?').get(r.runId) as {payload:string}|undefined;
  return ![workflow,direct].some(row=>row&&['running','queued','interrupted'].includes(JSON.parse(row.payload).status));
 }).map(r=>r.id);
}
export function previewBudgetBoundary(db:Database.Database,at=new Date().toISOString()):BudgetBoundary{
 const row=db.prepare('SELECT revision FROM settings WHERE id=1').get() as {revision:number};
 return {id:randomUUID(),at,settingsRevision:row.revision,previousId:activeBoundary(db)?.id??null,legacyIds:legacyUnknownIds(db,at)};
}
export function applyBudgetBoundary(db:Database.Database,raw:unknown,now=Date.now()){
 const preview=budgetBoundarySchema.parse(raw);
 return db.transaction(()=>{
  const saved=db.prepare('SELECT payload FROM budget_boundaries WHERE id=?').get(preview.id) as {payload:string}|undefined;
  if(saved){if(saved.payload!==JSON.stringify(preview))throw new AppError('conflict','This boundary identity already exists.');return preview;}
  const current=previewBudgetBoundary(db,preview.at);
  if(Date.parse(preview.at)>now||now-Date.parse(preview.at)>300000||current.previousId!==preview.previousId||current.settingsRevision!==preview.settingsRevision||JSON.stringify(current.legacyIds)!==JSON.stringify(preview.legacyIds))throw new AppError('conflict','The budget preview expired or usage/settings changed. Review a fresh preview.');
  db.prepare('INSERT INTO budget_boundaries VALUES (?,?)').run(preview.id,JSON.stringify(preview));
  return preview;
 }).immediate();
}
function rates(db:Database.Database){return (db.prepare('SELECT payload FROM usage_rates ORDER BY rowid').all() as {payload:string}[]).map(r=>rateSchema.parse(JSON.parse(r.payload))).sort((a,b)=>a.usableFrom.localeCompare(b.usableFrom));}
type CostRequest={provider:'jev'|'deepseek'|'openai';requestedModel:string;at:string;maxTokens:number};
/** The reservation and non-billable eligibility view share this exact guard. */
export function costEligibility(db:Database.Database,input:CostRequest){
 const storedRates=rates(db),rate=storedRates.filter(r=>r.provider===input.provider&&r.models.includes(input.requestedModel)&&r.usableFrom<=input.at).at(-1);
 const bound=rate?pricedTokens({input:20512,output:input.maxTokens,...(rate.cacheWrite?{cacheWrite:20512}:{})},rate)?.high??null:null;
 const spending=settings(db).spending,summary=costSummary(db,input.at),month=summary.enforcement!.month;
 const end=new Date(Date.UTC(+summary.month.slice(0,4),+summary.month.slice(5,7),1)).toISOString();
 const unknown=(db.prepare('SELECT payload FROM usage_costs WHERE at>=? AND at<?').all(summary.month+'-01T00:00:00.000Z',end) as {payload:string}[]).map(r=>costEntrySchema.parse(JSON.parse(r.payload))).filter(r=>r.high===null&&r.reservation===null&&!summary.enforcement!.boundary?.legacyIds.includes(r.id));
 const tokensKnown=unknown.filter(r=>r.input!==null&&r.output!==null).length;
 const exposure={unknown:month.unknown,tokensKnown,tokensMissing:unknown.length-tokensKnown,provisional:month.provisional,missingHistoricRate:unknown.filter(r=>!storedRates.some(rate=>rate.provider===r.provider&&rate.models.includes(r.reportedModel??r.requestedModel)&&rate.usableFrom<=r.at)).length};
 const issues:EligibilityIssue[]=[];
 if(spending.mode==='hard-stop'&&spending.stop!==null){
  if(month.unknown>0)issues.push({code:'unpriced_exposure',message:`${month.unknown} records this month have unpriced exposure. The saved spending stop blocks new paid requests until that exposure can be bounded.`,target:'usage',label:'Review unpriced usage'});
  if(bound===null)issues.push({code:'next_rate_missing',message:'The next request has no supported price bound under the stored tariff. The spending stop blocks dispatch.',target:'usage',label:'Review price sources'});
  if(bound!==null&&month.exposure>=dollarsToNano(spending.stop)&&month.exposure+bound>dollarsToNano(spending.stop))issues.push({code:'spending_stop',message:'Known estimates and reserved exposure reach the saved monthly spending stop.',target:'limits',label:'Review spending controls'});
  else if(bound!==null&&month.exposure+bound>dollarsToNano(spending.stop))issues.push({code:'reservation_exceeds',message:'The next request’s conservative reservation would cross the saved monthly spending stop.',target:'limits',label:'Review spending controls'});
 }
 return{issues,exposure,rate,bound};
}
export function dispatchEligibility(db:Database.Database,input:UsageReservation){const capacity=capacityIssue(db,input),cost=costEligibility(db,{provider:input.provider,requestedModel:input.model!,maxTokens:input.maxTokens??0,at:input.at});return{issues:[...(capacity?[capacity]:[]),...cost.issues],exposure:cost.exposure};}
export function reserveCost(db:Database.Database,input:{id:string;runId:string;provider:'jev'|'deepseek'|'openai';requestedModel:string;at:string;maxTokens:number;profile:string;purpose:'ordinary'|'development';dispatched:boolean}){
 if(db.prepare('SELECT id FROM usage_costs WHERE id=?').get(input.id))throw new AppError('conflict','This paid attempt was already reserved.');
 const {rate,bound,issues}=costEligibility(db,input);
 if(issues.length)throw new DispatchBlocked('permission_denied',issues[0].message);
 const record:CostEntry={id:input.id,runId:input.runId,provider:input.provider,requestedModel:input.requestedModel,reportedModel:null,profile:input.profile,purpose:input.purpose,at:input.at,outcome:'reserved',availability:'unknown',input:null,output:null,cacheHit:null,cacheMiss:null,reasoning:null,rateId:rate?.id??null,low:null,high:null,reservation:bound,dispatched:input.dispatched};
 db.prepare('INSERT INTO usage_costs VALUES (?,?,?)').run(record.id,record.at,JSON.stringify(record));
}
export function settleCost(db:Database.Database,id:string,update:{usage:Usage|null;model:string|null;outcome:string;dispatched:boolean;terminal:boolean}){
 const row=db.prepare('SELECT payload FROM usage_costs WHERE id=?').get(id) as {payload:string}|undefined;if(!row)return;
 const old=costEntrySchema.parse(JSON.parse(row.payload));if(['reported','not-dispatched'].includes(old.availability)){db.prepare('UPDATE usage_costs SET payload=? WHERE id=?').run(JSON.stringify({...old,outcome:update.outcome}),id);return;}
 let next={...old,dispatched:old.dispatched||update.dispatched,outcome:update.outcome,reportedModel:update.model??old.reportedModel};
 if(update.usage){const u=update.usage;const rate=rates(db).find(r=>r.id===old.rateId&&(!next.reportedModel||r.models.includes(next.reportedModel)));const amount=rate?pricedTokens(u,rate):null;
  next={...next,input:u.input,output:u.output,cacheHit:u.cacheHit??null,cacheMiss:u.cacheMiss??null,...(u.cacheWrite!==undefined?{cacheWrite:u.cacheWrite}:{}),reasoning:u.reasoning??null,low:amount?.low??null,high:amount?.high??null,availability:amount?'reported':'unknown',reservation:amount?0:old.reservation};
 }else if(update.terminal&&!next.dispatched)next={...next,availability:'not-dispatched',low:0,high:0,reservation:0};
 // A dispatched interruption without usage keeps its conservative exposure indefinitely.
 db.prepare('UPDATE usage_costs SET payload=? WHERE id=?').run(JSON.stringify(next),id);
}
export function costSummary(db:Database.Database,at=new Date().toISOString()){
 const day=at.slice(0,10),month=at.slice(0,7),end=new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7),1)).toISOString();
 const entries=(db.prepare('SELECT payload FROM usage_costs WHERE at>=? AND at<? ORDER BY at DESC').all(month+'-01T00:00:00.000Z',end) as {payload:string}[]).map(r=>costEntrySchema.parse(JSON.parse(r.payload)));
 const total=(rows:CostEntry[]):CostPeriod=>rows.reduce<CostPeriod>((sum,r)=>{sum.attempts++;if(r.high!==null){sum.priced++;sum.low+=r.low??0;sum.high+=r.high;sum.exposure+=r.high;}else if(r.reservation!==null){sum.provisional++;sum.exposure+=r.reservation;}else sum.unknown++;if(r.purpose==='development'){sum.development++;sum.developmentHigh+=r.high??0;}return sum;},{attempts:0,priced:0,unknown:0,provisional:0,low:0,high:0,exposure:0,development:0,developmentHigh:0});
 const monthToDate=total(entries),today=total(entries.filter(r=>r.at.slice(0,10)===day));const spending=settings(db).spending;
 // Require seven completed, ordinary-use days and fully priced ordinary history. Development bursts are excluded.
 const ordinary=entries.filter(r=>r.purpose==='ordinary');const days=new Set(ordinary.filter(r=>r.at.slice(0,10)<day).map(r=>r.at.slice(0,10)));const completed=ordinary.filter(r=>r.at.slice(0,10)<day);const remainingDays=Number(new Date(+new Date(end)-86400000).getUTCDate())-Number(day.slice(8));
 const forecast=days.size>=7&&!entries.some(r=>r.purpose==='unclassified')&&ordinary.every(r=>r.high!==null)?{high:Math.ceil(ordinary.reduce((n,r)=>n+r.high!,0)+completed.reduce((n,r)=>n+r.high!,0)/days.size*remainingDays),completedDays:days.size,remainingDays}:null;
 const boundary=activeBoundary(db);const historicalUnknown=entries.filter(r=>boundary?.legacyIds.includes(r.id)&&r.high===null&&r.reservation===null).length;
 const enforced=total(entries.filter(r=>!(boundary?.legacyIds.includes(r.id)&&r.high===null&&r.reservation===null)));
 return costsSchema.parse({enforcement:{boundary,historicalUnknown,month:enforced},day,month,today,monthToDate,rates:rates(db),recent:entries.slice(0,50),forecast,warning:spending.mode!=='monitor'&&spending.mode!==undefined&&spending.warning!==null&&monthToDate.exposure>=dollarsToNano(spending.warning),stopped:spending.mode==='hard-stop'&&spending.stop!==null&&(enforced.unknown>0||enforced.exposure>=dollarsToNano(spending.stop))});
}
export function directLimit(db:Database.Database,_provider:'jev'|'deepseek'|'openai',_legacy:number){const raw=db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as {payload:string}|undefined;return {daily:Infinity,provider:Infinity,paused:!!(raw&&JSON.parse(raw.payload).config.paused)};}
