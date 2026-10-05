import type { AssistantRun } from '../../src/shared/assistant';

export function hasVoiceProposal(run:AssistantRun){return !!(run.result?.reply||run.result?.responsibility||run.result?.suggestions.length);}
/** Keep normal accounting and requested Work artifacts, never an opt-out call transcript. */
export function retainedVoiceRun(run:AssistantRun):AssistantRun {
 if(run.channel?.voice?.retention!=='ephemeral')return run;
 const saved=structuredClone(run),proposal=run.status==='succeeded'&&hasVoiceProposal(run);
 saved.prompt='Authenticated voice request (ephemeral)';saved.warnings=[];delete saved.contextSelection;
 saved.error=run.error?'Voice request did not complete. No automatic retry was made.':null;
 saved.result=proposal?{answer:'Prepared from an authenticated voice request. Review the proposed action.',citations:[],suggestions:run.result!.suggestions,reply:run.result!.reply,responsibility:run.result!.responsibility}:null;
 const needed=new Set([run.result?.reply?.sourceId,run.result?.responsibility?.sourceId,...run.result?.suggestions.flatMap(s=>s.sourceIds)??[]]);
 saved.sources=proposal?run.sources.filter(s=>needed.has(s.id)):[];
 return saved;
}
