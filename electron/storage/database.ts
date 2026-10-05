import { initializeCosts,registerRates,reserveCost,settleCost,directLimit } from '../agent/usage';
import { retainedVoiceRun } from '../ai/voice-retention';
import { hash } from '../agent/catalogue';
import { MailRepository } from '../mail/store';
import { agentRunSchema } from '../../src/shared/orchestration';
import { AgentRepository } from '../agent/store';
import { calendarActionSchema, type CalendarAction } from '../../src/shared/calendar-actions';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runSchema, taskSchema, taskCommandSchema, workspaceSchema, type AssistantRun, type AssistantWorkspace, type LocalTask } from '../../src/shared/assistant';
import { defaults, settingsSchema, settingsRecordSchema, settingsUpdateSchema, type SettingsRecord } from '../../src/shared/contracts';
import { AppError } from '../errors';
import { seedRates } from '../../src/shared/usage';
export class SettingsDatabase {
  private readonly db: Database.Database;
  private agentStore!: AgentRepository;
  private mailStore!: MailRepository;
  constructor(filename: string, private readonly preserveHistory = false) {
    this.db = new Database(filename, { timeout: 1500 });
    try {
      if (this.db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Invalid database');
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > 9) throw new AppError('unavailable', 'This database belongs to a newer MoMo version. Install that version to open it.');
      this.db.pragma('foreign_keys = ON'); this.db.pragma('journal_mode = WAL');
      if (version === 0) this.db.transaction(() => {
        this.db.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0)); CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
        this.db.prepare('INSERT INTO settings VALUES (1, ?, 0)').run(JSON.stringify(defaults));
        this.db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run('initial-local-settings-v1', new Date().toISOString());
        this.db.pragma('user_version = 1');
      })();
      if (version < 2) {
        // A consistent SQLite snapshot, including committed WAL data, before an additive migration.
        if (version === 1 && filename !== ':memory:') this.db.prepare('VACUUM INTO ?').run(filename + '.before-v2-' + randomUUID() + '.sqlite');
        this.db.transaction(() => {
          this.db.exec('CREATE TABLE assistant_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE local_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE request_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL)');
          this.db.prepare('INSERT INTO schema_migrations VALUES (2, ?, ?)').run('assistant-history-local-tasks-v2', new Date().toISOString());
          this.db.pragma('user_version = 2');
        })();
      }
      if (version < 3) {
        if (version === 2 && filename !== ':memory:') this.db.prepare('VACUUM INTO ?').run(filename + '.before-v3-' + randomUUID() + '.sqlite');
        this.db.transaction(() => {
          this.db.exec('CREATE TABLE calendar_actions (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE calendar_action_audit (sequence INTEGER PRIMARY KEY, action_id TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, payload_hash TEXT NOT NULL)');
          this.db.prepare('INSERT INTO schema_migrations VALUES (3, ?, ?)').run('approved-calendar-actions-v3', new Date().toISOString());
          this.db.pragma('user_version = 3');
        })();
      }
      if(version<4){
        if(version===3&&filename!==':memory:')this.db.prepare('VACUUM INTO ?').run(filename+'.before-v4-'+randomUUID()+'.sqlite');
        this.db.transaction(()=>{
          this.db.exec('CREATE TABLE agent_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE agent_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE agent_receipts (dedup TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE agent_usage (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider TEXT NOT NULL, at TEXT NOT NULL)');
          this.db.prepare('INSERT INTO schema_migrations VALUES (4, ?, ?)').run('orchestration-feedback-policy-v4',new Date().toISOString());this.db.pragma('user_version=4');
        })();
      }
      if(version<5){
        if(version>0&&filename!==':memory:')this.db.prepare('VACUUM INTO ?').run(filename+'.before-v5-'+randomUUID()+'.sqlite');
        this.db.transaction(()=>{
          this.db.exec(`CREATE TABLE assistant_usage (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT NOT NULL);
            INSERT INTO assistant_usage SELECT id,created_at,provider FROM assistant_runs;
            CREATE TABLE cleared_conversations (id TEXT PRIMARY KEY, cleared_at TEXT NOT NULL);
            CREATE TABLE task_receipts (id TEXT PRIMARY KEY, account_id TEXT, created_at TEXT NOT NULL);
            INSERT INTO task_receipts SELECT id,json_extract(payload,'$.accountId'),json_extract(payload,'$.createdAt') FROM local_tasks;
            CREATE TABLE mail_drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE mail_actions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE mail_action_audit (sequence INTEGER PRIMARY KEY, action_id TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, payload_hash TEXT NOT NULL);`);
          this.db.prepare('INSERT INTO schema_migrations VALUES (5, ?, ?)').run('workspace-mail-and-independent-usage-v5',new Date().toISOString());this.db.pragma('user_version=5');
        })();
      }
      if(version<6){
        if(version>0&&filename!==':memory:')this.db.prepare('VACUUM INTO ?').run(filename+'.before-v6-'+randomUUID()+'.sqlite');
        this.db.transaction(()=>{initializeCosts(this.db);this.db.prepare('INSERT INTO schema_migrations VALUES (6, ?, ?)').run('usage-cost-metadata-v6',new Date().toISOString());this.db.pragma('user_version=6');})();
      }
      if(version<7){
        if(version>0&&filename!==':memory:')this.db.prepare('VACUUM INTO ?').run(filename+'.before-v7-'+randomUUID()+'.sqlite');
        this.db.transaction(()=>{
          // Content-free receipts fence discarded identities against delayed/replayed creation.
          this.db.exec('CREATE TABLE mail_discard_receipts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revision INTEGER NOT NULL, discarded_at TEXT NOT NULL)');
          this.db.prepare('INSERT INTO schema_migrations VALUES (7, ?, ?)').run('local-mail-discard-lifecycle-v7',new Date().toISOString());this.db.pragma('user_version=7');
        })();
      }
      if(version<8){
        if(version>0&&filename!==':memory:')this.db.prepare('VACUUM INTO ?').run(filename+'.before-v8-'+randomUUID()+'.sqlite');
        this.db.transaction(()=>{
          this.db.exec('CREATE TABLE activity_archives (id TEXT NOT NULL, account_id TEXT NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(id,account_id)); CREATE TABLE budget_boundaries (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
          this.db.prepare('INSERT INTO schema_migrations VALUES (8, ?, ?)').run('activity-presentation-budget-boundary-v8',new Date().toISOString());this.db.pragma('user_version=8');
        })();
      }
      if(version<9){
        if(version===8&&filename!==':memory:')this.db.prepare('VACUUM INTO ?').run(filename+'.before-v9-'+randomUUID()+'.sqlite');
        this.db.transaction(()=>{
          this.db.exec('CREATE TABLE relay_events (id TEXT PRIMARY KEY, dedup TEXT UNIQUE NOT NULL, event_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
          this.db.prepare('INSERT INTO schema_migrations VALUES (9, ?, ?)').run('local-relay-receipts-v9',new Date().toISOString());this.db.pragma('user_version=9');
        })();
      }
      // An existing schema also needs tariffs for models added by newer app versions.
      this.db.transaction(()=>registerRates(this.db,seedRates))();
      this.mailStore=new MailRepository(this.db);this.mailStore.recover();
      this.agentStore=new AgentRepository(this.db);this.agentStore.recover();if(!this.preserveHistory)this.agentStore.prune(Date.now());
      for (const action of this.calendarActions()) if (action.status === 'dispatching') this.putCalendarAction({ ...action, status:'unknown', detail:'MoMo closed during an approved action. Check outcome before creating another event.' },'dispatching');
      this.prune();
      for (const run of this.runs()) if (run.status === 'running') this.saveRun({ ...run, status: 'interrupted', stage: 'Interrupted', finishedAt: new Date().toISOString(), error: 'MoMo closed during this request. It was not retried; provider usage may be unknown.' });
      this.get();
    } catch (error) { this.db.close(); throw error; }
  }
  private prune() {
    if(this.preserveHistory)return;
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    this.db.prepare('DELETE FROM assistant_runs WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM request_receipts WHERE created_at < ?').run(new Date(Date.now() - 90 * 86400000).toISOString());
    // Attempt history is independent of content retention and never resets with appearance or presets.
  }
  private runs(): AssistantRun[] {
    return (this.db.prepare('SELECT payload FROM assistant_runs ORDER BY created_at DESC, rowid DESC LIMIT 100').all() as { payload: string }[]).map(row => runSchema.parse(JSON.parse(row.payload)));
  }
  workspace(): AssistantWorkspace {
    this.prune();
    const tasks = (this.db.prepare('SELECT payload FROM local_tasks ORDER BY rowid DESC').all() as { payload: string }[]).map(row => taskSchema.parse(JSON.parse(row.payload)));
    const callsToday = { deepseek: 0, jev: 0, openai:0 };
    for (const row of this.db.prepare('SELECT provider, COUNT(*) AS count FROM assistant_usage WHERE created_at >= ? GROUP BY provider').all(new Date().toISOString().slice(0,10)) as { provider: 'deepseek'|'jev'|'openai'; count: number }[]) callsToday[row.provider] = row.count;
    return workspaceSchema.parse({ runs: this.runs(), tasks, callsToday });
  }
  getRun(id: string): AssistantRun | null {
    const row = this.db.prepare('SELECT payload FROM assistant_runs WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? runSchema.parse(JSON.parse(row.payload)) : null;
  }
  clearConversation(id:string):AssistantWorkspace {
    return this.db.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO cleared_conversations VALUES (?, ?)').run(id,new Date().toISOString());
      this.db.prepare('DELETE FROM assistant_runs WHERE json_extract(payload,\'$.conversationId\')=?').run(id);
      return this.workspace();
    })();
  }
  taskReceipt(id:string){
    const row=this.db.prepare('SELECT payload FROM local_tasks WHERE id=?').get(id) as {payload:string}|undefined;
    return {id,existed:!!this.db.prepare('SELECT id FROM task_receipts WHERE id=?').get(id),task:row?taskSchema.parse(JSON.parse(row.payload)):null};
  }
  startRun(raw: unknown, limit: number): AssistantRun {
    const run = runSchema.parse(raw);
    return this.db.transaction(() => {
      if(this.db.prepare('SELECT id FROM cleared_conversations WHERE id=?').get(run.conversationId))throw new AppError('conflict','This conversation was cleared. Start a new conversation.');
      const receipt = this.db.prepare('SELECT fingerprint FROM request_receipts WHERE id = ?').get(run.id) as { fingerprint: string } | undefined;
      if (receipt) {
        const previous = this.getRun(run.id);
        if (receipt.fingerprint !== run.fingerprint || !previous) throw new AppError('conflict', 'This request identifier was already used. Start a new request.');
        return previous;
      }
      const limits=directLimit(this.db,run.provider,limit);
      if(limits.paused)throw new AppError('unavailable','Global pause is on.');
      reserveCost(this.db,{id:run.id,runId:run.id,provider:run.provider,requestedModel:run.requestedModel,at:run.createdAt,maxTokens:run.maxOutputTokens,profile:run.profile??run.mode,purpose:run.accountingPurpose??'ordinary',dispatched:false});
      this.db.prepare('INSERT INTO request_receipts VALUES (?, ?, ?)').run(run.id, run.fingerprint, run.createdAt);
      this.db.prepare('INSERT INTO assistant_runs VALUES (?, ?, ?, ?)').run(run.id, run.createdAt, run.provider, JSON.stringify(retainedVoiceRun(run)));
      this.db.prepare('INSERT INTO assistant_usage VALUES (?, ?, ?)').run(run.id,run.createdAt,run.provider);
      return run;
    })();
  }
  saveRun(raw: unknown): AssistantRun {
    const run = runSchema.parse(raw);
    if(run.calls?.length){for(const call of run.calls)settleCost(this.db,call.id,{usage:call.usage,model:call.reportedModel,outcome:call.status==='complete'?run.status:call.status,dispatched:call.dispatched,terminal:run.status!=='running'});}
    else settleCost(this.db,run.id,{usage:run.usage,model:run.reportedModel,outcome:run.status,dispatched:!!run.dispatchedAt,terminal:run.status!=='running'});
    const result = this.db.prepare('UPDATE assistant_runs SET payload = ? WHERE id = ?').run(JSON.stringify(retainedVoiceRun(run)), run.id);
    if (result.changes !== 1) throw new AppError('conflict', 'This assistant request no longer exists.');
    return run;
  }
  reserveAssistantCall(id:string,callId:string){
    return this.db.transaction(()=>{
      const run=this.getRun(id);if(!run||run.status!=='running'||!['deepseek','openai'].includes(run.provider)||!run.calls?.length)throw new AppError('conflict','Mo request is no longer active.');
      if(run.calls.length>=Math.min(6,this.get().values.aiLimits?.callsPerWorkflow??6))throw new AppError('unavailable','Mo reached the saved request limit.');
      if(directLimit(this.db,run.provider,0).paused)throw new AppError('permission_denied','Global pause is on.');
      const at=new Date().toISOString();
      reserveCost(this.db,{id:callId,runId:id,provider:run.provider,requestedModel:run.requestedModel,at,maxTokens:run.maxOutputTokens,profile:run.profile??'chat',purpose:run.accountingPurpose??'ordinary',dispatched:false});
      this.db.prepare('INSERT INTO assistant_usage VALUES (?,?,?)').run(callId,at,run.provider);
      run.calls.push({id:callId,at,dispatched:false,usage:null,reportedModel:null,status:'reserved'});
      this.db.prepare('UPDATE assistant_runs SET payload=? WHERE id=?').run(JSON.stringify(run),id);
      return run;
    })();
  }
  taskCommand(raw: unknown): AssistantWorkspace {
    const command = taskCommandSchema.parse(raw);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM local_tasks WHERE id = ?').get(command.id) as { payload: string } | undefined;
      const current = row ? taskSchema.parse(JSON.parse(row.payload)) : null;
      if (command.action === 'create') {
        if (current) {
          if ((current.accountId??null)!==(command.accountId??null)||JSON.stringify({ title: current.title, due: current.due }) !== JSON.stringify(command.draft)) throw new AppError('conflict', 'This task identifier was already used.');
          return this.workspace();
        }
        if(this.taskReceipt(command.id).existed)throw new AppError('conflict','This proposal was already saved. Its task was subsequently removed.');
        if ((this.db.prepare('SELECT COUNT(*) AS count FROM local_tasks').get() as { count: number }).count >= 500) throw new AppError('unavailable', 'The local task limit is 500. Remove completed tasks before adding more.');
        const task: LocalTask = { ...command.draft, id: command.id, status: 'open', accountId:command.accountId??null, revision: 0, createdAt: new Date().toISOString(), remindedAt: null };
        this.db.prepare('INSERT INTO local_tasks VALUES (?, ?)').run(task.id, JSON.stringify(task));
        this.db.prepare('INSERT INTO task_receipts VALUES (?, ?, ?)').run(task.id,task.accountId??null,task.createdAt);
      } else {
        if (!current || current.revision !== command.expectedRevision) throw new AppError('conflict', 'This task changed. Refresh before trying again.');
        if (command.action === 'delete') this.db.prepare('DELETE FROM local_tasks WHERE id = ?').run(current.id);
        else {
          const next = command.action === 'dismiss' ? { ...current, revision: current.revision + 1, remindedAt: new Date().toISOString() }
            : { ...current, ...command.draft, status: command.status, revision: current.revision + 1, remindedAt: JSON.stringify(command.draft.due) !== JSON.stringify(current.due) || command.status !== current.status ? null : current.remindedAt };
          this.db.prepare('UPDATE local_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(taskSchema.parse(next)), current.id);
        }
      }
      return this.workspace();
    })();
  }
  calendarActions(): CalendarAction[] {
    return (this.db.prepare('SELECT payload FROM calendar_actions ORDER BY rowid DESC LIMIT 200').all() as {payload:string}[]).map(row=>calendarActionSchema.parse(JSON.parse(row.payload)));
  }
  putCalendarAction(raw:unknown, expectedStatus:CalendarAction['status']|null): CalendarAction {
    const action=calendarActionSchema.parse(raw);
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT payload FROM calendar_actions WHERE id = ?').get(action.id) as {payload:string}|undefined;
      const old=row?calendarActionSchema.parse(JSON.parse(row.payload)):null;
      if(expectedStatus===null) {
        if(old || action.status!=='pending') throw new AppError('conflict','This calendar proposal already exists.');
        if((this.db.prepare('SELECT COUNT(*) AS count FROM calendar_actions').get() as {count:number}).count>=200) throw new AppError('unavailable','Calendar action history is full (200). No new proposal was saved.');
        this.db.prepare('INSERT INTO calendar_actions VALUES (?, ?)').run(action.id,JSON.stringify(action));
      } else {
        if(!old || old.status!==expectedStatus) throw new AppError('conflict','This calendar proposal was already handled. Refresh its status.');
        const immutable=(a:CalendarAction)=>JSON.stringify({id:a.id,version:a.version,tool:a.tool,draft:a.draft,accountEmail:a.accountEmail,calendar:a.calendar,hash:a.hash,eventId:a.eventId,target:a.target,workflow:a.workflow,createdAt:a.createdAt,expiresAt:a.expiresAt});
        if(immutable(old)!==immutable(action)) throw new AppError('permission_denied','An approved proposal cannot be modified.');
        const allowed:Record<string,string[]>={pending:['dispatching','denied','expired'],dispatching:['succeeded','failed','unknown'],unknown:['succeeded','unknown']};
        if(!allowed[old.status]?.includes(action.status)) throw new AppError('conflict','This action cannot be dispatched again.');
        this.db.prepare('UPDATE calendar_actions SET payload = ? WHERE id = ?').run(JSON.stringify(action),action.id);
      }
      this.db.prepare('INSERT INTO calendar_action_audit (action_id, at, status, payload_hash) VALUES (?, ?, ?, ?)').run(action.id,new Date().toISOString(),action.status,action.hash);
      return action;
    })();
  }
  agent(operation:string,input?:unknown):unknown{
    if(operation==='applyVoiceLocal')return this.db.transaction(()=>{
      const run=agentRunSchema.parse(input),action=run.voiceAction,p=run.proposals[0],state=this.agentStore.state(),settings=this.get();
      const assistant=run.executive?this.getRun(run.executive.assistantRunId):null,session=assistant?.channel?.voice;
      const policy=state.policies.find(x=>x.id===run.policy.id),now=new Date().toISOString();
      if(!p||p.sourceId!=='owner'||p.sourceRevision!==hash(p.draft)||p.hash!==hash({id:p.id,taskId:p.taskId,accountId:p.accountId,draft:p.draft,sourceId:p.sourceId,sourceRevision:p.sourceRevision,expiresAt:p.expiresAt,policyVersion:p.policyVersion}))throw new AppError('permission_denied','The exact local task changed.');
      if(!action||action.status!=='confirmed'||!p||run.proposals.length!==1||p.id!==action.nonce||p.taskId!==action.taskId||p.accountId!==action.accountId||run.event.accountId!==action.accountId||p.expiresAt!==action.expiresAt||action.expiresAt<=now||Date.parse(action.confirmedAt)>Date.now()+1000||!session||assistant?.status!=='running'||assistant.accountId!==action.accountId||!assistant.includeLocal||assistant.channel?.authorization!=='authenticated-owner'||session.id!==action.sessionId||session.callSid!==action.callSid||session.ownerId!==action.ownerId||session.endedAt||session.expiresAt<=now||!state.config.enabled||state.config.paused||!state.config.shareTasks||state.revision!==action.authorityRevision||settings.revision!==action.settingsRevision||settings.values.disabledModules.some(m=>m==='dashboard'||m==='planner')||!policy?.enabled||policy.accountId!==action.accountId||policy.family!=='chat'||!['L1','L2'].includes(policy.level)||policy.version!==p.policyVersion||this.agentStore.get(run.id))throw new AppError('permission_denied','Voice confirmation or local task authority changed.');
      run.status='running';this.agentStore.enqueue(run);
      const applied=agentRunSchema.parse(this.agent('applyLocal',{runId:run.id,proposalId:p.id,hash:p.hash,authorization:'explicit',at:now}));
      applied.voiceAction!.status='created';applied.status='complete';applied.finishedAt=now;applied.checkpoint='Local task created by confirmed owner voice';
      if(applied.executive){applied.executive.state='completed';applied.executive.nextStep='Local task created';applied.executive.proposals=[];}
      return this.agentStore.update(applied);
    }).immediate();
    if(operation==='applyLocal')return this.db.transaction(()=>{
      const value=input as {runId:string;proposalId:string;hash:string;authorization:'explicit'|'L2';at:string};
      const run=this.agentStore.get(value.runId);const p=run?.proposals.find(p=>p.id===value.proposalId);const state=this.agentStore.state();const policy=state.policies.find(x=>x.id===run?.policy.id);
      if(!run||!p||p.status!=='pending'||p.hash!==value.hash||p.expiresAt<=value.at||!state.config.enabled||state.config.paused||!policy?.enabled||policy.version!==p.policyVersion)throw new AppError('permission_denied','Reminder approval or workflow authority changed.');
      if(value.authorization==='L2'){
        const count=this.agentStore.localCount(p.accountId,run.event.family,value.at);
        if(policy.level!=='L2'||count>=policy.maxLocalPerDay)throw new AppError('permission_denied','Local automation daily limit reached.');
      }
      this.taskCommand({action:'create',id:p.taskId,draft:p.draft,accountId:p.accountId});p.status='applied';p.authorization=value.authorization;return this.agentStore.update(agentRunSchema.parse(run));
    })();
    return this.agentStore.execute(operation,input);
  }
  mail(operation:string,input?:unknown):unknown{return this.mailStore.execute(operation,input);}
  get(): SettingsRecord {
    const row = this.db.prepare('SELECT value, revision FROM settings WHERE id = 1').get() as { value: string; revision: number };
    return settingsRecordSchema.parse({ values: JSON.parse(row.value), revision: row.revision });
  }
  update(raw: unknown): SettingsRecord {
    const input = settingsUpdateSchema.parse(raw);
    return this.db.transaction(() => {
      const current = this.get();
      if (current.revision !== input.expectedRevision) throw new AppError('conflict', 'Settings changed elsewhere. Reload them and try again.');
      const next = settingsRecordSchema.parse({ values: { ...current.values, ...input.patch }, revision: current.revision + 1 });
      registerRates(this.db,settingsSchema.parse({ ...current.values, ...input.patch }).importedRates);
      this.db.prepare('UPDATE settings SET value = ?, revision = ? WHERE id = 1').run(JSON.stringify(next.values), next.revision);
      return next;
    })();
  }
  close() { this.db.close(); }
}
