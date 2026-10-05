// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,readdirSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SettingsDatabase } from '../electron/storage/database';
import { costSummary,reserveCost,settleCost,registerRates } from '../electron/agent/usage';
import { aiLimitsSchema,personalLimits,pricedTokens,seedRates,formatCost,costRange,recommendLimits,type Costs } from '../src/shared/usage';
import { settingsUpdateSchema } from '../src/shared/contracts';
import { initialAgentState } from '../src/shared/orchestration';
import { runSchema } from '../src/shared/assistant';

const at='2026-09-23T16:00:00.000Z';
const attempt=(id=randomUUID())=>({id,runId:id,provider:'deepseek' as const,requestedModel:'deepseek-flash',at,maxTokens:8192,profile:'normal',purpose:'ordinary' as const,dispatched:true});
function database(){const app=new SettingsDatabase(':memory:');const raw=(app as unknown as {db:Database.Database}).db;return {app,raw};}
it('uses non-overlapping cache categories and reasoning stays within completion totals at sub-cent precision',()=>{
 const price=pricedTokens({input:1000,cacheHit:200,cacheMiss:800,output:100},seedRates[0]);expect(price).toEqual({low:180600,high:361200});expect(formatCost(price!.high)).toBe('less than $0.01');
 expect(pricedTokens({input:1000,output:100},seedRates[0])).toEqual({low:63000,high:420000});
 expect(pricedTokens({input:1000,output:9000},seedRates[1])).toEqual({low:42000,high:42000});
 expect(pricedTokens({input:100,cacheHit:80,cacheMiss:80,output:1},seedRates[0])).toBeNull();
});
it('preserves settings patch omission, permissions, the old 50 guard and counters across preset application',()=>{
 const {app}=database();try{const state=initialAgentState();state.revision=1;state.config={...state.config,dailyCalls:50,enabled:true,shareGoogle:true};app.agent('saveState',state);
 expect(settingsUpdateSchema.parse({patch:{theme:'light'},expectedRevision:0}).patch).toEqual({theme:'light'});
 const r=runSchema.parse({id:randomUUID(),conversationId:randomUUID(),fingerprint:'a',mode:'chat',provider:'deepseek',requestedModel:'deepseek-flash',reportedModel:null,prompt:'fictional',accountId:null,includeGoogle:false,createdAt:at,finishedAt:null,status:'running',stage:'prepare',error:null,result:null,sources:[],warnings:[],usage:null,inputBytes:0,maxOutputTokens:2048,classification:null});app.startRun(r,20);
 const before=app.agent('usage');app.update({patch:{aiLimits:personalLimits},expectedRevision:0});app.update({patch:{theme:'light'},expectedRevision:1});expect(app.get().values.aiLimits).toEqual(personalLimits);expect(app.get().values.spending.stop).toBeNull();expect(app.agent('usage')).toEqual(before);expect(app.agent('state')).toEqual(state);
 }finally{app.close();}
});
it('reserves concurrent exposure transactionally, retains interruptions and prevents duplicate attempts',()=>{
 const {app,raw}=database();try{app.update({patch:{spending:{mode:'hard-stop',currency:'USD',warning:'0.01',stop:'0.02'}},expectedRevision:0});
 const a=attempt();raw.transaction(()=>reserveCost(raw,a)).immediate();expect(()=>raw.transaction(()=>reserveCost(raw,attempt())).immediate()).toThrow('spending stop');
 settleCost(raw,a.id,{usage:null,model:null,outcome:'interrupted',dispatched:true,terminal:true});expect(costSummary(raw,at).monthToDate).toMatchObject({attempts:1,provisional:1,priced:0});expect(()=>reserveCost(raw,a)).toThrow('already reserved');
 settleCost(raw,a.id,{usage:{input:1000,output:100,cacheHit:200,cacheMiss:800,reasoning:50},model:'deepseek-flash',outcome:'review',dispatched:true,terminal:true});
 const before=costSummary(raw,at);expect(before.monthToDate).toMatchObject({attempts:1,priced:1,provisional:0,high:361200});settleCost(raw,a.id,{usage:{input:9999,output:9999},model:'deepseek-flash',outcome:'review',dispatched:true,terminal:true});expect(costSummary(raw,at)).toEqual(before);
 reserveCost(raw,attempt());expect(costSummary(raw,at).monthToDate.attempts).toBe(2);
 }finally{app.close();}
});
it('releases only genuinely undispatched reservations and keeps usage without pricing unknown',()=>{
 const {app,raw}=database();try{const a={...attempt(),dispatched:false};reserveCost(raw,a);settleCost(raw,a.id,{usage:null,model:null,outcome:'cancelled',dispatched:false,terminal:true});expect(costSummary(raw,at).monthToDate.exposure).toBe(0);
 const b={...attempt(),requestedModel:'unverified-model'};reserveCost(raw,b);settleCost(raw,b.id,{usage:{input:100,output:10},model:'unverified-model',outcome:'failed',dispatched:true,terminal:true});expect(costSummary(raw,at).monthToDate.unknown).toBe(1);expect(costSummary(raw,at).recent.find(r=>r.id===b.id)?.input).toBe(100);
 }finally{app.close();}
});
it('pins historical versions and rejects implicit currencies and contradictory rate versions',()=>{
 const {app,raw}=database();try{const a=attempt();reserveCost(raw,a);const newRate={...seedRates[0],id:'flash-new',usableFrom:at,input:'9'};registerRates(raw,[newRate]);settleCost(raw,a.id,{usage:{input:1000,output:100},model:'deepseek-flash',outcome:'held',dispatched:true,terminal:true});expect(costSummary(raw,at).recent[0].rateId).toBe(seedRates[0].id);expect(costSummary(raw,at).recent[0].high).toBe(420000);
 expect(()=>registerRates(raw,[{...newRate,input:'8'}])).toThrow('immutable');expect(()=>registerRates(raw,[{...newRate,id:'cny',currency:'CNY'} as never])).toThrow();expect(costSummary(raw,at).forecast).toBeNull();
 }finally{app.close();}
});
it('uses UTC period boundaries regardless of display timezone and separates development totals',()=>{
 const {app,raw}=database();try{const before={...attempt(),at:'2026-09-30T23:59:59.999Z',purpose:'development' as const};reserveCost(raw,before);settleCost(raw,before.id,{usage:{input:100,output:50},model:'deepseek-flash',outcome:'complete',dispatched:true,terminal:true});const after={...attempt(),at:'2026-10-01T00:00:00.000Z'};reserveCost(raw,after);
 expect(costSummary(raw,before.at).monthToDate).toMatchObject({attempts:1,development:1});expect(costSummary(raw,after.at).monthToDate).toMatchObject({attempts:1,development:0});app.update({patch:{timezone:'Pacific/Auckland'},expectedRevision:0});expect(costSummary(raw,before.at).monthToDate.attempts).toBe(1);
 }finally{app.close();}
});
it('backs up schema 5 additively and preserves unpriced usage and new reservations across restart',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'momo-cost-migration-')),file=path.join(dir,'momo.sqlite');let app:SettingsDatabase|undefined;
 try{app=new SettingsDatabase(file);const saved=app.get();app.close();app=undefined;let raw=new Database(file);raw.exec('DROP TABLE relay_events; DELETE FROM schema_migrations WHERE version=9; DROP TABLE activity_archives; DROP TABLE budget_boundaries; DELETE FROM schema_migrations WHERE version=8; DROP TABLE mail_discard_receipts; DELETE FROM schema_migrations WHERE version=7; DROP TABLE usage_costs;DROP TABLE usage_rates;DELETE FROM schema_migrations WHERE version=6;PRAGMA user_version=5');raw.prepare('INSERT INTO agent_usage VALUES (?,?,?,?)').run(randomUUID(),randomUUID(),'jev',at);raw.close();app=new SettingsDatabase(file);expect(app.get()).toEqual(saved);expect(readdirSync(dir).some(n=>n.includes('before-v6'))).toBe(true);raw=(app as unknown as {db:Database.Database}).db;reserveCost(raw,attempt());const costs=costSummary(raw,at);expect(costs.monthToDate).toMatchObject({attempts:2,unknown:1,provisional:1});app.close();app=new SettingsDatabase(file);expect(costSummary((app as unknown as {db:Database.Database}).db,at)).toEqual(costs);expect((app.agent('costs') as Costs).rates).toHaveLength(seedRates.length);
 }finally{app?.close();if(!path.resolve(dir).startsWith(path.join(os.tmpdir(),'momo-cost-migration-')))throw new Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}
});
it('keeps higher custom capacities when previewing recommendations',()=>{const higher={...personalLimits,daily:1000,normalTokens:32000,callsPerWorkflow:20,normalSeconds:400};const proposed=recommendLimits(higher);expect(proposed).toMatchObject({daily:null,normalTokens:32000,callsPerWorkflow:20,normalSeconds:400});expect(aiLimitsSchema.safeParse(proposed).success).toBe(true);});
it('shows meaningful sub-cent precision without duplicate rounded endpoints or false zero',()=>{
 expect(costRange({attempts:3,priced:3,low:1333470,high:2541822})).toBe('$0.0013 – $0.0025');
 expect(costRange({attempts:1,priced:1,low:101000,high:102000})).toBe('$0.0001');
 expect(costRange({attempts:1,priced:1,low:1,high:42})).toBe('less than $0.0001');
 expect(costRange({attempts:1,priced:0,low:0,high:0})).toBe('Not priced');
 expect(costRange({attempts:0,priced:0,low:0,high:0})).toBe('$0.00');
});
it('adds new bundled tariffs on upgrade without repricing history or replacing a newer imported tariff',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'momo-rates-upgrade-')),file=path.join(dir,'momo.sqlite');let app:SettingsDatabase|undefined;
 try{
  app=new SettingsDatabase(file);let raw=(app as unknown as {db:Database.Database}).db;
  const luna=seedRates.find(r=>r.provider==='openai')!;
  raw.prepare('DELETE FROM usage_rates WHERE id=?').run(luna.id);
  const old={...attempt(),at:'2026-10-02T12:00:00.000Z',provider:'openai' as const,requestedModel:'gpt-6-luna'};
  reserveCost(raw,old);settleCost(raw,old.id,{usage:{input:1000,output:100},model:'gpt-6-luna',outcome:'complete',dispatched:true,terminal:true});
  const recorded=raw.prepare('SELECT payload FROM usage_costs').all();
  registerRates(raw,[{...luna,id:'owner-newer-luna',usableFrom:'2026-10-02T00:00:00.000Z',input:'0.2'}]);
  app.close();app=new SettingsDatabase(file);raw=(app as unknown as {db:Database.Database}).db;
  expect(raw.prepare('SELECT payload FROM usage_costs').all()).toEqual(recorded);
  expect(costSummary(raw,old.at).rates.map(r=>r.id)).toContain(luna.id);
  const next={...old,id:randomUUID()};reserveCost(raw,next);
  expect(costSummary(raw,old.at).recent.find(r=>r.id===next.id)?.rateId).toBe('owner-newer-luna');
  app.close();app=new SettingsDatabase(file);
  expect((app.agent('costs') as Costs).rates.filter(r=>r.id===luna.id)).toHaveLength(1);
 }finally{app?.close();if(!path.resolve(dir).startsWith(path.join(os.tmpdir(),'momo-rates-upgrade-')))throw new Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}
});
