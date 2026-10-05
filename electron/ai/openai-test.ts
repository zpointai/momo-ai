import { z } from 'zod';
import { AppError } from '../errors';
import { ProviderHttp,type ProviderResult } from './providers';
import type { Usage } from '../../src/shared/assistant';

export const OPENAI_TEST_MODEL='gpt-6-luna';
export const OPENAI_TEST_TOKENS=512;
export const OPENAI_TEST_PROMPT='Test OpenAI access with one fixed, non-private request.';
export const openAITestBody={model:OPENAI_TEST_MODEL,store:false,stream:false,service_tier:'default',reasoning:{effort:'none'},max_output_tokens:OPENAI_TEST_TOKENS,tools:[],input:[{role:'user',content:'Connection test only. Return the JSON object {"status":"ready"}.'}],text:{format:{type:'json_schema',name:'momo_connection_test',strict:true,schema:{type:'object',properties:{status:{type:'string',enum:['ready']}},required:['status'],additionalProperties:false}}}};
const count=z.number().int().nonnegative().safe();
const usageSchema=z.object({input_tokens:count,output_tokens:count.max(OPENAI_TEST_TOKENS),total_tokens:count,input_tokens_details:z.object({cached_tokens:count.optional()}).optional(),output_tokens_details:z.object({reasoning_tokens:count.optional()}).optional()}).refine(u=>u.total_tokens===u.input_tokens+u.output_tokens&&(u.input_tokens_details?.cached_tokens??0)<=u.input_tokens&&(u.output_tokens_details?.reasoning_tokens??0)<=u.output_tokens);
// Independent production parser: no evaluation modules or credentials enter this graph.
function strictJson(text:string):unknown{
 const tokens=text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)??[],stack:(Set<string>|null)[]=[];
 for(let n=0;n<tokens.length;n++){const t=tokens[n];if(t==='{')stack.push(new Set());else if(t==='[')stack.push(null);else if(t==='}'||t===']')stack.pop();else if(t.startsWith('"')&&tokens[n+1]===':'){const keys=stack.at(-1),key=JSON.parse(t) as string;if(!keys||keys.has(key))throw Error('Duplicate JSON key');keys.add(key);}}
 return JSON.parse(text) as unknown;
}
const envelope=z.object({id:z.string().min(1),object:z.literal('response'),status:z.string(),model:z.string(),error:z.unknown().nullable().optional(),incomplete_details:z.unknown().nullable().optional(),usage:usageSchema,output:z.array(z.object({type:z.string(),role:z.string().optional(),status:z.string().optional(),phase:z.string().nullable().optional(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional()}))});
/** Settings-only probe: no general prompt, tools, continuation, retry or production route. */
export class OpenAIConnectionTest{
 constructor(private http=new ProviderHttp()){}
 async complete(key:string,signal:AbortSignal,usageReceived:(usage:Usage,model:string)=>void):Promise<ProviderResult>{
  try{
   const response=await this.http.post('openai',key,openAITestBody,signal),reader=response.body!.getReader();let bytes=0;const chunks:Uint8Array[]=[];
   try{while(true){signal.throwIfAborted();const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>65536)throw Error('Response bound');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
   const raw=Buffer.concat(chunks).toString('utf8');
   if([key,encodeURIComponent(key),Buffer.from(key).toString('base64'),[...key].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')].some(v=>raw.includes(v)))throw Error('Credential echo');
   const parsed=envelope.parse(strictJson(raw));
   if(parsed.model!==OPENAI_TEST_MODEL&&!/^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(parsed.model))throw Error('Model mismatch');
   const u=parsed.usage,usage:Usage={input:u.input_tokens,output:u.output_tokens,...(u.input_tokens_details?.cached_tokens!==undefined?{cacheHit:u.input_tokens_details.cached_tokens}:{}),...(u.output_tokens_details?.reasoning_tokens!==undefined?{reasoning:u.output_tokens_details.reasoning_tokens}:{})};
   // Trustworthy usage survives a failed/held output; it never establishes API verification.
   usageReceived(usage,parsed.model);
   if(parsed.status!=='completed'||parsed.error||parsed.incomplete_details)throw Error('Incomplete response');
   if(parsed.output.some(o=>!['message','reasoning'].includes(o.type)))throw Error('Unexpected output');
   const messages=parsed.output.filter(o=>o.type==='message');
   if(messages.some(m=>m.role!=='assistant'||m.status!=='completed'||!['commentary','final_answer',null,undefined].includes(m.phase)))throw Error('Invalid message');
   const finals=messages.filter(m=>m.phase!=='commentary');
   if(finals.length!==1||finals[0].content?.length!==1||finals[0].content[0].type!=='output_text')throw Error('Ambiguous final');
   z.object({status:z.literal('ready')}).strict().parse(strictJson(finals[0].content[0].text??''));signal.throwIfAborted();
   return{reportedModel:parsed.model,usage,result:{answer:'OpenAI connection test succeeded.',citations:[],suggestions:[]}};
  }catch{throw new AppError('unavailable','OpenAI test did not return a verified complete response. Check the key and API access. No automatic retry was made; usage may be charged.');}
 }
}
