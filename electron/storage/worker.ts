import type { CalendarAction } from '../../src/shared/calendar-actions';
import { parentPort, workerData } from 'node:worker_threads';
import { SettingsDatabase } from './database';
import { failure } from '../errors';
const port = parentPort!;
try {
  const db = new SettingsDatabase(workerData.filename, workerData.preserveHistory === true);
  port.postMessage({ ready: true });
  port.on('message', (message: { id: number; operation: string; input?: unknown }) => {
    try {
      if (message.operation === 'get') port.postMessage({ id: message.id, result: { ok: true, value: db.get() } });
      else if (message.operation === 'update') port.postMessage({ id: message.id, result: { ok: true, value: db.update(message.input) } });
      else if (message.operation === 'workspace') port.postMessage({ id: message.id, result: { ok: true, value: db.workspace() } });
      else if (message.operation === 'clearConversation') port.postMessage({id:message.id,result:{ok:true,value:db.clearConversation(String(message.input))}});
      else if (message.operation === 'taskReceipt') port.postMessage({id:message.id,result:{ok:true,value:db.taskReceipt(String(message.input))}});
      else if (message.operation === 'getRun') port.postMessage({ id: message.id, result: { ok: true, value: db.getRun(String(message.input)) } });
      else if (message.operation === 'startRun') { const input = message.input as { run: unknown; limit: number }; port.postMessage({ id: message.id, result: { ok: true, value: db.startRun(input.run, input.limit) } }); }
      else if (message.operation === 'saveRun') port.postMessage({ id: message.id, result: { ok: true, value: db.saveRun(message.input) } });
      else if (message.operation === 'reserveAssistantCall') {const input=message.input as {id:string;callId:string};port.postMessage({id:message.id,result:{ok:true,value:db.reserveAssistantCall(input.id,input.callId)}});}
      else if (message.operation === 'task') port.postMessage({ id: message.id, result: { ok: true, value: db.taskCommand(message.input) } });
      else if (message.operation === 'mail') {const input=message.input as {operation:string;input?:unknown};port.postMessage({id:message.id,result:{ok:true,value:db.mail(input.operation,input.input)}});}
      else if (message.operation === 'agent') {const input=message.input as {operation:string;input?:unknown};port.postMessage({id:message.id,result:{ok:true,value:db.agent(input.operation,input.input)}});}
      else if (message.operation === 'calendarActions') port.postMessage({id:message.id,result:{ok:true,value:db.calendarActions()}});
      else if (message.operation === 'putCalendarAction') {const input=message.input as {action:unknown;expectedStatus:CalendarAction['status']|null};port.postMessage({id:message.id,result:{ok:true,value:db.putCalendarAction(input.action,input.expectedStatus)}});}
      else if (message.operation === 'close') { db.close(); port.postMessage({ id: message.id, result: { ok: true, value: null } }); port.close(); }
      else port.postMessage({ id: message.id, result: { ok: false, error: { code: 'invalid_input', message: 'Unknown storage operation.' } } });
    } catch (error) { port.postMessage({ id: message.id, result: failure(error) }); }
  });
} catch (error) { port.postMessage({ ready: false, error: failure(error) }); port.close(); }
