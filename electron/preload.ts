import { homeSnapshotSchema } from '../src/shared/home-automation';
import { relaySnapshotSchema } from '../src/shared/relay';
import { mailResultSchema } from '../src/shared/mail';
import { situationSnapshotSchema } from '../src/shared/situation';
import { agentSnapshotSchema } from '../src/shared/orchestration';
import { calendarActionResultSchema } from '../src/shared/calendar-actions';
import { contextBridge, ipcRenderer } from 'electron';
import { desktopObservationStateSchema } from '../src/shared/desktop-observation';
import { z } from 'zod';
import { channels, resultSchema, snapshotSchema, type DesktopBridge, type Result } from '../src/shared/contracts';
import { inboxSchema, messageSchema, calendarSchema } from '../src/shared/google';
import { workspaceSchema, runSchema, taskReceiptSchema } from '../src/shared/assistant';
const call = async <T extends z.ZodType>(channel: string, schema: T, input?: unknown): Promise<Result<z.output<T>>> => {
  try { return resultSchema(schema).parse(await ipcRenderer.invoke(channel, input)) as Result<z.output<T>>; }
  catch { return { ok: false, error: { code: 'unavailable', message: 'MoMo could not reach its local service.' } }; }
};
const bridge: DesktopBridge = {
  homeCommand:input=>call('momo:home:command',homeSnapshotSchema,input),
  relayCommand:input=>call('momo:relay:command',relaySnapshotSchema,input),
  desktopObservation: input => call('momo:desktop-observation:command', desktopObservationStateSchema, input),
  situationCommand:input=>call('momo:situation:command',situationSnapshotSchema,input),
  onClockChanged:listener=>{const handler=()=>listener();ipcRenderer.on('momo:clock:changed',handler);return()=>ipcRenderer.removeListener('momo:clock:changed',handler);},
  mailCommand:input=>call('momo:mail:command',mailResultSchema,input),
  clearConversation:id=>call('momo:conversation:clear',workspaceSchema,{id}),
  taskReceipt:id=>call('momo:task:receipt',taskReceiptSchema,{id}),
  agentCommand:input=>call(channels.agent,agentSnapshotSchema,input),
  onAgentChanged:listener=>{const handler=(_event:unknown,raw:unknown)=>{const value=agentSnapshotSchema.safeParse(raw);if(value.success)listener(value.data);};ipcRenderer.on(channels.agentChanged,handler);return()=>ipcRenderer.removeListener(channels.agentChanged,handler);},
  calendarAction: input => call(channels.calendarAction, calendarActionResultSchema, input),
  saveCredential: input => call('momo:credentials:save', snapshotSchema, input),
  getWorkspace: () => call(channels.workspace, workspaceSchema),
  startRun: input => call(channels.startRun, runSchema, input),
  cancelRun: id => call(channels.cancelRun, workspaceSchema, { id }),
  taskCommand: input => call(channels.task, workspaceSchema, input),
  onWorkspaceChanged: listener => {
    const handler = (_event: unknown, raw: unknown) => { const value = workspaceSchema.safeParse(raw); if (value.success) listener(value.data); };
    ipcRenderer.on(channels.workspaceChanged, handler); return () => ipcRenderer.removeListener(channels.workspaceChanged, handler);
  },
  getSnapshot: () => call(channels.snapshot, snapshotSchema),
  updateSettings: input => call(channels.settings, snapshotSchema, input),
  importCredential: provider => call(channels.importCredential, snapshotSchema, { provider }),
  removeCredential: provider => call(channels.removeCredential, snapshotSchema, { provider }),
  googleCommand: command => call(channels.google, snapshotSchema, command),
  readInbox: query => call(channels.inbox, inboxSchema, query),
  readMessage: query => call(channels.message, messageSchema, query),
  readCalendar: query => call(channels.calendar, calendarSchema, query),
  onChanged: listener => {
    const handler = (_event: unknown, raw: unknown) => { const value = snapshotSchema.safeParse(raw); if (value.success) listener(value.data); };
    ipcRenderer.on(channels.changed, handler); return () => ipcRenderer.removeListener(channels.changed, handler);
  },
};
contextBridge.exposeInMainWorld('momo', Object.freeze(bridge));
