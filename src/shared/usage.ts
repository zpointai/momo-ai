import { z } from 'zod';

// Optional capacity settings supersede legacy prototype controls only after a user saves them.
const count = z.number().int().min(1).max(100000);
const tokens = z.number().int().min(256).max(65536);
export const aiLimitsSchema = z.object({
  daily: count.nullable(), deepseekDaily: count.nullable(), jevDaily: count.nullable(),
  shortTokens: tokens, normalTokens: tokens, complexTokens: tokens,
  callsPerWorkflow: z.number().int().min(1).max(24), workflowTokens: z.number().int().min(256).max(262144),
  normalSeconds: z.number().int().min(15).max(600), complexSeconds: z.number().int().min(15).max(600),
  profile: z.enum(['normal','complex']), preset: z.enum(['personal','custom']),
}).strict();
export type AiLimits = z.infer<typeof aiLimitsSchema>;
export const personalLimits: AiLimits = { daily:null,deepseekDaily:null,jevDaily:null,shortTokens:4096,normalTokens:8192,complexTokens:16384,callsPerWorkflow:12,workflowTokens:32768,normalSeconds:180,complexSeconds:300,profile:'normal',preset:'personal' };
export function recommendLimits(current:AiLimits,_preserveOverrides=true):AiLimits {
  return {...personalLimits,deepseekDaily:null,jevDaily:null,daily:null,shortTokens:Math.max(4096,current.shortTokens),normalTokens:Math.max(8192,current.normalTokens),complexTokens:Math.max(16384,current.complexTokens),callsPerWorkflow:Math.max(12,current.callsPerWorkflow),workflowTokens:Math.max(32768,current.workflowTokens),normalSeconds:Math.max(180,current.normalSeconds),complexSeconds:Math.max(300,current.complexSeconds)};
}
export function effectiveLimits(settings:{aiLimits?:AiLimits|null;dailyCallLimit:number},config:{dailyCalls:number;maxCallsPerRun:number;maxOutputTokens:number;maxRunSeconds:number}):AiLimits {
  return {...(settings.aiLimits??{daily:null,deepseekDaily:null,jevDaily:null,shortTokens:Math.min(2048,config.maxOutputTokens),normalTokens:config.maxOutputTokens,complexTokens:config.maxOutputTokens,callsPerWorkflow:config.maxCallsPerRun,workflowTokens:config.maxOutputTokens*2,normalSeconds:config.maxRunSeconds,complexSeconds:config.maxRunSeconds,profile:'normal' as const,preset:'custom' as const}),daily:null,deepseekDaily:null,jevDaily:null};
}
export function generationTokens(limits:AiLimits,kind:'short'|'normal'|'complex') { return kind==='short'?limits.shortTokens:kind==='complex'?limits.complexTokens:limits.normalTokens; }
const money = z.string().regex(/^\d{1,6}(\.\d{1,6})?$/);
export const spendingSchema = z.object({ mode:z.enum(['monitor','warn','hard-stop']).optional(),currency:z.literal('USD'),warning:money.nullable(),stop:money.nullable() }).strict().refine(s=>s.mode!=='warn'||s.warning!==null,'Set a warning amount.').refine(s=>s.mode!=='hard-stop'||s.stop!==null,'Set a hard-stop amount.');
export type Spending = z.infer<typeof spendingSchema>;
export const rateSchema = z.object({
  id:z.string().min(1).max(100),provider:z.enum(['deepseek','jev','openai']),models:z.array(z.string().min(1).max(100)).min(1).max(10),currency:z.literal('USD'),unit:z.literal('per-million-tokens'),
  source:z.url().refine(v=>['api-docs.deepseek.com','docs.typesafe.ai','developers.openai.com'].includes(new URL(v).hostname)),verifiedAt:z.string().datetime(),effectiveFrom:z.string().datetime().nullable(),
  // usableFrom is local observation/activation, never a claim about historical provider applicability.
  usableFrom:z.string().datetime(),input:money,cacheHit:money.nullable(),cacheWrite:money.optional(),output:money,
  offPeak:z.object({input:money,cacheHit:money,output:money}).strict().nullable(),schedule:z.string().max(300).nullable(),
}).strict();
export type Rate = z.infer<typeof rateSchema>;
export const seedRates:Rate[]=[
 {id:'deepseek-flash-usd-2026-09-23',provider:'deepseek',models:['deepseek-flash','deepseek-v4-flash','DeepSeek-V4.1-Flash'],currency:'USD',unit:'per-million-tokens',source:'https://api-docs.deepseek.com/quick_start/pricing/',verifiedAt:'2026-09-23T14:45:00.000Z',effectiveFrom:null,usableFrom:'2026-09-23T14:45:00.000Z',input:'0.30',cacheHit:'0.006',output:'1.20',offPeak:{input:'0.15',cacheHit:'0.003',output:'0.60'},schedule:'Peak 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri except Chinese public holidays. Boundary/holiday settlement is unverified; show range.'},
 {id:'jev-1.13-usd-2026-09-23',provider:'jev',models:['jev-latest','jev-1.13.0'],currency:'USD',unit:'per-million-tokens',source:'https://docs.typesafe.ai/models',verifiedAt:'2026-09-23T14:45:00.000Z',effectiveFrom:null,usableFrom:'2026-09-23T14:45:00.000Z',input:'0.042',cacheHit:null,output:'0',offPeak:null,schedule:null},
 {id:'gpt-6-luna-usd-2026-10-01',provider:'openai',models:['gpt-6-luna'],currency:'USD',unit:'per-million-tokens',source:'https://developers.openai.com/api/docs/models/gpt-6-luna',verifiedAt:'2026-10-01T14:30:00.000Z',effectiveFrom:null,usableFrom:'2026-10-01T14:30:00.000Z',input:'0.10',cacheHit:'0.01',cacheWrite:'0.125',output:'0.50',offPeak:null,schedule:'Standard Responses requests only, below 272K input tokens; no regional processing or built-in tools.'},
];
export function dollarsToNano(value:string):number {const [whole,fraction='']=value.split('.');return Number(BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0')));}
// Rate decimal -> integer millionths of a dollar/Mtok; aggregate at picodollar precision.
function categoryCost(tokens:number,rate:string):bigint {const [whole,fraction='']=rate.split('.');return BigInt(tokens)*(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')));}
export function pricedTokens(usage:{input:number;output:number;cacheHit?:number;cacheMiss?:number;cacheWrite?:number},rate:Rate):{low:number;high:number}|null {
  if(usage.cacheHit!==undefined&&usage.cacheHit>usage.input)return null;
  if(usage.cacheMiss!==undefined&&usage.cacheMiss>usage.input)return null;
  if(usage.cacheHit!==undefined&&usage.cacheMiss!==undefined&&usage.cacheHit+usage.cacheMiss!==usage.input)return null;
  if((usage.cacheWrite??0)+(usage.cacheHit??0)>usage.input)return null;
 const hit=usage.cacheHit??(usage.cacheMiss!==undefined?usage.input-usage.cacheMiss:undefined);
  const charge=(r:{input:string;cacheHit:string|null;cacheWrite?:string;output:string},low:boolean)=>{
    const w=usage.cacheWrite??0,h=r.cacheHit===null?0:hit??(low?usage.input-w:0);
    const pico=categoryCost(usage.input-h-w,r.input)+categoryCost(h,r.cacheHit??r.input)+categoryCost(w,r.cacheWrite??r.input)+categoryCost(usage.output,r.output);
    return Number((pico+999n)/1000n);
  };
  return {low:charge(rate.offPeak??rate,true),high:charge(rate,false)};
}
const integer=z.number().int().nonnegative().safe();
export const costPeriodSchema=z.object({attempts:integer,priced:integer,unknown:integer,provisional:integer,low:integer,high:integer,exposure:integer,development:integer,developmentHigh:integer}).strict();
export type CostPeriod=z.infer<typeof costPeriodSchema>;
export const costEntrySchema=z.object({id:z.string(),runId:z.string(),provider:z.enum(['deepseek','jev','openai']),requestedModel:z.string(),reportedModel:z.string().nullable(),profile:z.string(),purpose:z.enum(['ordinary','development','unclassified']),at:z.string(),outcome:z.string(),availability:z.enum(['reported','unknown','not-dispatched']),input:integer.nullable(),output:integer.nullable(),cacheHit:integer.nullable(),cacheMiss:integer.nullable(),cacheWrite:integer.nullable().optional(),reasoning:integer.nullable(),rateId:z.string().nullable(),low:integer.nullable(),high:integer.nullable(),reservation:integer.nullable(),dispatched:z.boolean()}).strict();
export type CostEntry=z.infer<typeof costEntrySchema>;
export const budgetBoundarySchema=z.object({id:z.string().uuid(),at:z.string().datetime(),settingsRevision:integer,previousId:z.string().uuid().nullable(),legacyIds:z.array(z.string()).max(100000)}).strict();
export type BudgetBoundary=z.infer<typeof budgetBoundarySchema>;
export const costsSchema=z.object({enforcement:z.object({boundary:budgetBoundarySchema.nullable(),historicalUnknown:integer,month:costPeriodSchema}).strict().optional(),day:z.string(),month:z.string(),today:costPeriodSchema,monthToDate:costPeriodSchema,rates:z.array(rateSchema),recent:z.array(costEntrySchema),forecast:z.object({high:integer,completedDays:integer,remainingDays:integer}).nullable(),warning:z.boolean(),stopped:z.boolean()}).strict();
export type Costs=z.infer<typeof costsSchema>;
export function formatCost(nano:number,digits=2):string { const format=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:digits,maximumFractionDigits:digits});if(nano>0&&nano<1e9/10**digits)return 'less than '+format.format(1/10**digits);return format.format(nano/1e9); }
export function costRange(period:Pick<CostPeriod,'low'|'high'|'priced'|'attempts'>):string {
 if(!period.attempts)return '$0.00';if(!period.priced)return 'Not priced';if(!period.high)return '$0.00';
 const digits=period.high<1e9?4:2,low=formatCost(period.low,digits),high=formatCost(period.high,digits);
 return low===high?high:low+' – '+high;
}
