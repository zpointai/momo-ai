import { calendarActionsSchema, calendarActionSchema, type CalendarAction } from '../../src/shared/calendar-actions';
import { Worker } from 'node:worker_threads';
import { settingsRecordSchema, type Result, type SettingsRecord, type SettingsUpdate } from '../../src/shared/contracts';
import { AppError } from '../errors';
import { runSchema, workspaceSchema, type AssistantRun, type TaskCommand } from '../../src/shared/assistant';
export class StorageClient {
  private worker: Worker;
  private serial = 0;
  private failed = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  readonly ready: Promise<void>;
  constructor(workerPath: string, filename: string, preserveHistory = false) {
    this.worker = new Worker(workerPath, { workerData: { filename, preserveHistory } });
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.stop(new AppError('unavailable', 'Local storage did not start. Restart MoMo.')); reject(new AppError('unavailable', 'Local storage did not start. Restart MoMo.')); }, 10000);
      this.worker.once('message', message => {
        clearTimeout(timeout);
        if (message.ready) resolve(); else reject(new AppError('unavailable', message.error?.error?.message ?? 'Local storage could not open. Your data is preserved.'));
      });
      this.worker.once('error', () => { clearTimeout(timeout); reject(new AppError('unavailable', 'Local storage could not start.')); });
    });
    this.worker.on('message', (message: { id?: number; result?: Result<unknown> }) => {
      if (message.id === undefined) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.result?.ok) request.resolve(message.result.value);
      else request.reject(new AppError(message.result?.error.code ?? 'internal', message.result?.error.message ?? 'Local storage failed.'));
    });
    this.worker.on('error', () => this.stop(new AppError('unavailable', 'Local storage stopped. Restart MoMo.')));
    this.worker.on('exit', () => this.stop(new AppError('unavailable', 'Local storage is closed.')));
  }
  private stop(error: AppError) { this.failed = true; for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); }
  private async request(operation: string, input?: unknown): Promise<unknown> {
    await this.ready;
    if (this.failed) throw new AppError('unavailable', 'Local storage is unavailable. Restart MoMo.');
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError('unavailable', 'Local storage timed out. Reload settings before trying again.')); }, 5000);
      this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, operation, input });
    });
  }
  async mail(operation:string,input?:unknown):Promise<unknown>{return this.request('mail',{operation,input});}
  async agent(operation:string,input?:unknown):Promise<unknown>{return this.request('agent',{operation,input});}
  async calendarActions() { return calendarActionsSchema.parse(await this.request('calendarActions')); }
  async putCalendarAction(action:CalendarAction, expectedStatus:CalendarAction['status']|null) { return calendarActionSchema.parse(await this.request('putCalendarAction', {action,expectedStatus})); }
  async get(): Promise<SettingsRecord> { return settingsRecordSchema.parse(await this.request('get')); }
  async workspace() { return workspaceSchema.parse(await this.request('workspace')); }
  async clearConversation(id:string){return workspaceSchema.parse(await this.request('clearConversation',id));}
  async taskReceipt(id:string){return this.request('taskReceipt',id);}
  async getRun(id: string) { return runSchema.nullable().parse(await this.request('getRun', id)); }
  async startRun(run: AssistantRun, limit: number) { return runSchema.parse(await this.request('startRun', { run, limit })); }
  async saveRun(run: AssistantRun) { return runSchema.parse(await this.request('saveRun', run)); }
  async reserveAssistantCall(id:string,callId:string){return runSchema.parse(await this.request('reserveAssistantCall',{id,callId}));}
  async taskCommand(input: TaskCommand) { return workspaceSchema.parse(await this.request('task', input)); }
  async update(input: SettingsUpdate): Promise<SettingsRecord> { return settingsRecordSchema.parse(await this.request('update', input)); }
  async close() { try { if (!this.failed) await this.request('close'); } finally { await this.worker.terminate(); } }
}
