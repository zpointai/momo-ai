import type Database from 'better-sqlite3';
import { archivableWorkflow,terminalConversationStatus,terminalNativeStatus } from '../../src/shared/activity';
import { agentRunSchema,agentStateSchema,initialAgentState } from '../../src/shared/orchestration';
import { AppError } from '../errors';

export function activityArchives(db:Database.Database){return db.prepare("SELECT id,NULLIF(account_id,'') AS accountId FROM activity_archives").all();}
export function archiveActivity(db:Database.Database,input:{accountId:string|null;ids:string[]},at:string){
 return db.transaction(()=>{
  const stored=db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as {payload:string}|undefined;const state=stored?agentStateSchema.parse(JSON.parse(stored.payload)):initialAgentState();
  for(const key of new Set(input.ids)){
   const [kind,id]=key.split(':');const table=({workflow:'agent_runs',mail:'mail_actions',calendar:'calendar_actions',conversation:'assistant_runs'} as Record<string,string>)[kind];
   if(!table)throw new AppError('invalid_input','Unknown activity type.');
   const row=db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id) as {payload:string}|undefined;
   if(!row)throw new AppError('conflict','Activity changed. Refresh before archiving.');
   const record=JSON.parse(row.payload);const account=kind==='workflow'?record.event.accountId:kind==='calendar'?record.draft.accountId:record.accountId;
   const eligible=kind==='workflow'?archivableWorkflow(agentRunSchema.parse(record),state.feedback):kind==='conversation'?terminalConversationStatus(record.status):terminalNativeStatus(record.status);
   const unscoped=kind==='conversation'&&account===null&&!record.includeGoogle;
   if((account!==input.accountId&&!unscoped)||!eligible)throw new AppError('conflict','Pending, running, uncertain and needs-review work must remain visible. Refresh Activity.');
   db.prepare('INSERT OR IGNORE INTO activity_archives VALUES (?,?,?)').run(key,input.accountId??'',at);
  }
 }).immediate();
}
export function restoreActivity(db:Database.Database,accountId:string|null){db.prepare('DELETE FROM activity_archives WHERE account_id=?').run(accountId??'');}
