import type { AssistantRun } from '../../src/shared/assistant';

/** Model-authored answers have no execution receipt; native action results bypass this path. */
export function preparedVoiceAnswer(result:NonNullable<AssistantRun['result']>){
 const proposal=result.reply?'I prepared a reply for your review.':result.responsibility?'I prepared a tracking proposal for your review.':result.suggestions.length?'I prepared a task proposal for your review.':'';
 const sentences=result.answer.split(/(?<=[.!?])\s+|\n+/);
 const duplicateNotice=/^(?:I(?:['’]ve| have)? (?:prepared|drafted) (?:a|the|your) (?:reply|task proposal|tracking proposal)(?: for (?:your )?review)?|(?:The|Your) (?:reply|draft|task proposal|tracking proposal) is ready for (?:your )?review)[.!]?$/i;
 const executionClaim=/(?:\bI(?:['’]ve| have)?|\bwe(?:['’]ve| have)?|\bMo)\s+(?:(?:already|successfully|just)\s+)?(?:sent|created|updated|saved|scheduled|deleted|enabled|started tracking|am (?:tracking|monitoring)|will (?:send|create|update|track|monitor))\b|\b(?:I['’]m|I am|we['’]re|we are|Mo is)\s+(?:still\s+)?(?:working on|creating|scheduling|booking|saving|processing)\b|\b(?:hang on|bear with me|one moment)\b|^(?:Done|Created|Scheduled|Booked|All set|Consider it done)[!.]?$/i;
 const unsupportedStatus=/\b(?:has|have) been (?:\w+\s+)?(?:sent|created|updated|scheduled|enabled|added|booked|saved)\b|\b(?:reply|email|task|calendar|event|appointment|meeting|tracking|monitoring)\b.{0,100}\b(?:is|was|is now)\s+(?:(?:successfully|already|now)\s+)?(?:sent|created|updated|enabled|active|scheduled|booked|added|saved|confirmed|all set)\b/i;
 const safe=sentences.filter(s=>!executionClaim.test(s)&&(!unsupportedStatus.test(s)||result.citations.length>0)).filter(s=>!proposal||!duplicateNotice.test(s.trim())).join(' ');
 return [proposal,safe||(!proposal?'No action was taken.':null)].filter(Boolean).join(' ');
}

export function spokenText(text:string){
 const clean=text.replace(/\[[METWS]\d{1,2}(?:\s*,\s*[METWS]\d{1,2})*\]/g,'').replace(/https?:\/\/\S+/g,'').replace(/\b(?:[a-f0-9]{8}-[a-f0-9-]{27,}|(?:CA|AC|SM)[a-f0-9]{32}|[METWS]\d{1,2})\b/gi,'').replace(/<[^>]*>/g,'').replace(/^[\s]*(?:[-*#]+|\d+[.)])\s*/gm,'').replace(/[<>&|`*_#]/g,' ').replace(/\s+/g,' ').trim();
 const sentences=clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g)??[];
 let answer='';for(const sentence of sentences.slice(0,4)){if((answer+' '+sentence).trim().split(/\s+/).length>100)break;answer+=(answer?' ':'')+sentence.trim();}
 if(!answer&&clean)answer=clean.split(/\s+/).slice(0,80).join(' ')+'.';
 if(answer.length>1400)answer=answer.slice(0,1400).replace(/\s+\S*$/,'').trim()+'.';
 return answer.length<clean.length?answer+' There is more detail if you need it.':answer;
}
