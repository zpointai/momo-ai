import { z } from 'zod';
import { answerSchema, type Usage } from '../../src/shared/assistant';
import { AppError } from '../errors';
import { ProviderHttp, toolCallSchema, type MoMessage, type MoProvider } from './providers';

export const LUNA_MODEL = 'gpt-6-luna';
const count=z.number().int().nonnegative().safe();
const receiptSchema=z.object({model:z.string().max(100),usage:z.object({input_tokens:count,output_tokens:count,total_tokens:count,input_tokens_details:z.object({cached_tokens:count,cache_write_tokens:count.optional()}).optional(),output_tokens_details:z.object({reasoning_tokens:count}).optional()})});
const finalSchema={type:'object',properties:{answer:{type:'string'},citations:{type:'array',items:{type:'string'}},suggestions:{type:'array',items:{type:'object',properties:{title:{type:'string'},sourceIds:{type:'array',items:{type:'string'}}},required:['title','sourceIds'],additionalProperties:false}},clarification:{type:['string','null']},reply:{anyOf:[{type:'null'},{type:'object',properties:{sourceId:{type:'string'},body:{type:'string'}},required:['sourceId','body'],additionalProperties:false}]},responsibility:{anyOf:[{type:'null'},{type:'object',properties:{sourceId:{type:'string'},objective:{type:'string'}},required:['sourceId','objective'],additionalProperties:false}]},openSituation:{type:['string','null'],enum:['weather','traffic',null]}},required:['answer','citations','suggestions','clarification','reply','responsibility','openSituation'],additionalProperties:false};
const outputSchema=z.object({id:z.string(),object:z.literal('response'),status:z.literal('completed'),error:z.null().optional(),incomplete_details:z.null().optional(),output:z.array(z.object({type:z.enum(['message','function_call','reasoning']),id:z.string().optional(),call_id:z.string().optional(),name:z.string().optional(),arguments:z.string().optional(),role:z.literal('assistant').optional(),status:z.literal('completed').optional(),phase:z.enum(['commentary','final_answer']).nullable().optional(),content:z.array(z.object({type:z.literal('output_text'),text:z.string()})).optional()})).max(12)});

/** Stateless Responses continuation. Only native function tools; credentials stay in main. */
export class LunaProvider implements MoProvider {
  constructor(private http=new ProviderHttp()){}
  async turn(key:string,messages:MoMessage[],tools:unknown[],signal:AbortSignal,maxTokens:number,receipt:(usage:Usage,model:string)=>void,requiredTool?:string){
    const input=messages.flatMap((m):object[]=>m.role==='tool'?[{type:'function_call_output',call_id:m.tool_call_id,output:m.content}]:m.tool_calls?.length?m.tool_calls.map(c=>({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments})):[{role:m.role,content:m.content??''}]);
    const functions=tools.map(t=>{const f=(t as {function:{name:string;description:string;parameters:object}}).function;return {type:'function',...f,strict:true};});
    if(requiredTool&&!functions.some(f=>f.name===requiredTool))throw new AppError('invalid_input','Required capability is not offered.');
    const response=await this.http.post('openai',key,{model:LUNA_MODEL,store:false,stream:false,service_tier:'default',reasoning:{effort:'none'},max_output_tokens:maxTokens,input,tools:functions,parallel_tool_calls:false,...(functions.length?{tool_choice:requiredTool?{type:'function',name:requiredTool}:'auto'}:{}),text:{format:{type:'json_schema',name:'mo_answer',strict:true,schema:finalSchema}}},signal);
    const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>Math.max(65536,maxTokens*12))throw new AppError('unavailable','Mo response exceeded the limit.');chunks.push(next.value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const raw=Buffer.concat(chunks).toString('utf8');
    if([key,encodeURIComponent(key),Buffer.from(key).toString('base64')].some(v=>raw.includes(v)))throw new AppError('unavailable','Provider returned an unsafe response.');
    const value:unknown=JSON.parse(raw),r=receiptSchema.parse(value),u=r.usage;
    if(r.model!==LUNA_MODEL&&!/^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(r.model)||u.total_tokens!==u.input_tokens+u.output_tokens||(u.input_tokens_details?.cached_tokens??0)+(u.input_tokens_details?.cache_write_tokens??0)>u.input_tokens||(u.output_tokens_details?.reasoning_tokens??0)>u.output_tokens)throw new AppError('unavailable','Provider receipt was inconsistent.');
    receipt({input:u.input_tokens,output:u.output_tokens,...(u.input_tokens_details?{cacheHit:u.input_tokens_details.cached_tokens,...(u.input_tokens_details.cache_write_tokens!==undefined?{cacheWrite:u.input_tokens_details.cache_write_tokens}:{})}:{}),...(u.output_tokens_details?{reasoning:u.output_tokens_details.reasoning_tokens}:{})},r.model);
    signal.throwIfAborted();
    const parsed=outputSchema.parse(value),calls=parsed.output.filter(o=>o.type==='function_call'),finals=parsed.output.filter(o=>o.type==='message'&&o.phase!=='commentary');
    if(calls.length){
      if(calls.length!==1||finals.length||!functions.some(f=>f.name===calls[0].name))throw new AppError('unavailable','Mo requested an unsupported capability.');
      const call=toolCallSchema.parse({id:calls[0].call_id,type:'function',function:{name:calls[0].name,arguments:calls[0].arguments}});
      return {message:{role:'assistant' as const,content:null,tool_calls:[call]},call,result:null};
    }
    if(finals.length!==1||finals[0].role!=='assistant'||finals[0].status!=='completed'||!finals[0].content?.length)throw new AppError('unavailable','Mo did not return a complete final answer.');
    const content=finals[0].content.map(c=>c.text).join('');
    const result=JSON.parse(content);
    for(const field of ['clarification','reply','responsibility','openSituation'])if(result[field]===null)delete result[field];
    return {message:{role:'assistant' as const,content},call:null,result:answerSchema.parse(result)};
  }
}
