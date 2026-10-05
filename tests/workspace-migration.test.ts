// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect,it } from 'vitest';
import { mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SettingsDatabase } from '../electron/storage/database';
import { initialAgentState } from '../src/shared/orchestration';

it('migrates a populated v4 profile with a consistent backup and preserves settings, policies, tasks and usage',()=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'momo-v4-migration-')),filename=path.join(directory,'momo.sqlite');
 let app:SettingsDatabase|undefined,raw:Database.Database|undefined,backup:Database.Database|undefined;
 try{
  app=new SettingsDatabase(filename);app.update({patch:{theme:'light',sidebarCollapsed:true,dailyCallLimit:20},expectedRevision:0});
  const state=initialAgentState();state.revision=1;state.config={...state.config,enabled:true,dailyCalls:50,shareGoogle:true};
  state.policies=[{id:randomUUID(),accountId:'fictional-account',family:'email',enabled:true,level:'L1',version:2,maxLocalPerDay:1,schedule:{enabled:false,hour:9,minute:0,timezone:'Europe/Amsterdam'},updatedAt:new Date().toISOString()}];
  app.agent('saveState',state);const taskId=randomUUID();app.taskCommand({action:'create',id:taskId,accountId:'fictional-account',draft:{title:'Existing fictional task',due:{kind:'none'}}});
  const conversationId=randomUUID(),id=randomUUID();app.startRun({id,conversationId,fingerprint:'migration-fixture',mode:'chat',provider:'deepseek',requestedModel:'deepseek-flash',reportedModel:null,prompt:'Fictional existing conversation',accountId:null,includeGoogle:false,createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),status:'succeeded',stage:'Complete',error:null,result:null,sources:[],warnings:[],usage:null,inputBytes:0,maxOutputTokens:100,classification:null},20);
  const settings=app.get(),tasks=app.workspace().tasks;app.close();app=undefined;
  raw=new Database(filename);raw.prepare('INSERT INTO agent_usage VALUES (?,?,?,?)').run(randomUUID(),randomUUID(),'jev',new Date().toISOString());
  // Reconstruct the exact v4 table boundary in a disposable profile only.
  raw.exec('DROP TABLE relay_events; DELETE FROM schema_migrations WHERE version=9; DROP TABLE activity_archives; DROP TABLE budget_boundaries; DELETE FROM schema_migrations WHERE version=8; DROP TABLE mail_discard_receipts; DELETE FROM schema_migrations WHERE version=7; DROP TABLE usage_costs; DROP TABLE usage_rates; DELETE FROM schema_migrations WHERE version=6; DROP TABLE assistant_usage; DROP TABLE cleared_conversations; DROP TABLE task_receipts; DROP TABLE mail_drafts; DROP TABLE mail_actions; DROP TABLE mail_action_audit; DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4;');raw.close();raw=undefined;
  app=new SettingsDatabase(filename);expect(app.get()).toEqual(settings);expect(app.agent('state')).toEqual(state);expect(app.workspace().tasks).toEqual(tasks);expect(app.taskReceipt(taskId).existed).toBe(true);expect(app.agent('usage')).toMatchObject({deepseek:1,jev:1,total:2});
  app.clearConversation(conversationId);expect(app.workspace().runs).toEqual([]);expect(app.agent('usage')).toMatchObject({deepseek:1,jev:1,total:2});app.close();app=undefined;
  const backups=readdirSync(directory).filter(name=>name.includes('.before-v5-'));expect(backups).toHaveLength(1);backup=new Database(path.join(directory,backups[0]),{readonly:true});expect(backup.pragma('user_version',{simple:true})).toBe(4);expect(backup.prepare('SELECT COUNT(*) AS n FROM assistant_runs').get()).toEqual({n:1});expect(JSON.parse((backup.prepare('SELECT payload FROM agent_state').get() as {payload:string}).payload)).toEqual(state);expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='mail_drafts'").get()).toBeUndefined();backup.close();backup=undefined;
  app=new SettingsDatabase(filename);expect(app.get()).toEqual(settings);expect(app.agent('usage')).toMatchObject({total:2});expect(app.taskReceipt(taskId).task).toEqual(tasks[0]);expect(readdirSync(directory).filter(name=>name.includes('.before-v5-'))).toHaveLength(1);
 }finally{app?.close();raw?.close();backup?.close();const resolved=path.resolve(directory);if(!resolved.startsWith(path.join(os.tmpdir(),'momo-v4-migration-')))throw new Error('Unsafe cleanup');rmSync(resolved,{recursive:true,force:true});}
});
