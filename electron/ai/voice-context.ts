import type { AssistantSource } from '../../src/shared/assistant';
export interface VoiceCallContext {mailCandidates:AssistantSource[];selectedMail:AssistantSource|null;mailChoiceRequired?:boolean}
export const emptyVoiceCallContext=():VoiceCallContext=>({mailCandidates:[],selectedMail:null});
const followup=/\b(that (?:email|message|thread)|the (?:first|second|third|fourth|last) (?:one|email|message)|(?:what|which).*(?:it about|they asking|he mean|she mean|should I reply|attachment.*about)|(?:prepare|draft|shorten|make).*(?:reply|response)|make it shorter|summarize (?:it|that|the thread)|read.*latest message)\b/i;
export const voiceReplyIntent=(text:string)=>/\b(?:prepare|draft|write|compose|shorten|revise|rewrite)\b.*\b(?:reply|response|back)\b|\b(?:reply|respond|write back)\s+to\b|\bmake (?:it|the reply|the response) (?:shorter|longer|warmer|friendlier)\b/i.test(text);
export function voiceMailReference(text:string,context:VoiceCallContext):{source:AssistantSource|null;clarify:boolean}{
 if(!followup.test(text)&&!voiceReplyIntent(text))return {source:null,clarify:false};
 const ordinal=/\b(first|second|third|fourth|last)\b/i.exec(text)?.[1].toLowerCase();
 if(ordinal){const index=ordinal==='last'?context.mailCandidates.length-1:['first','second','third','fourth'].indexOf(ordinal);const source=context.mailCandidates[index]??null;return {source,clarify:!source};}
 const source=context.mailChoiceRequired?null:context.selectedMail??(context.mailCandidates.length===1?context.mailCandidates[0]:null);
 return {source,clarify:!source};
}
export function rememberVoiceMail(context:VoiceCallContext,sources:AssistantSource[],search:boolean,selectedId?:string|null,requiresChoice=false){
 const mail=sources.filter(s=>s.kind==='mail').slice(0,8);
 if(search){context.mailCandidates=structuredClone(mail);context.mailChoiceRequired=requiresChoice;context.selectedMail=mail.length===1&&!requiresChoice?structuredClone(mail[0]):null;}
 else if(selectedId){context.selectedMail=structuredClone(mail.find(s=>s.resourceId===selectedId)??null);context.mailChoiceRequired=false;}
 else if(mail.length){context.mailCandidates=structuredClone(mail);context.selectedMail=mail.length===1?structuredClone(mail[0]):null;context.mailChoiceRequired=false;}
}
