import { homeCommandSchema,homeSnapshotSchema } from '../../src/shared/home-automation';
import { relayCommandSchema,relaySnapshotSchema } from '../../src/shared/relay';
import { mailCommandSchema,mailResultSchema } from '../../src/shared/mail';
import { situationCommandSchema,situationSnapshotSchema } from '../../src/shared/situation';
import { agentCommandSchema,agentSnapshotSchema } from '../../src/shared/orchestration';
import { calendarActionCommandSchema, calendarActionResultSchema } from '../../src/shared/calendar-actions';
import { z } from 'zod';
import { channels, providerSchema, settingsUpdateSchema, snapshotSchema, saveCredentialSchema, type Result } from '../../src/shared/contracts';
import { workspaceSchema, runRequestSchema, runSchema, taskCommandSchema, uuidSchema, taskReceiptSchema } from '../../src/shared/assistant';
import { googleCommandSchema, inboxQuerySchema, inboxSchema, messageQuerySchema, messageSchema, calendarQuerySchema, calendarSchema } from '../../src/shared/google';
import { AppError, failure } from '../errors';
import { observationCommandSchema, desktopObservationStateSchema, desktopObservationLimits } from '../../src/shared/desktop-observation';
const schemas: Record<string, { input: z.ZodType; output: z.ZodType }> = {
  'momo:home:command':{input:homeCommandSchema,output:homeSnapshotSchema},
  'momo:relay:command':{input:relayCommandSchema,output:relaySnapshotSchema},
  'momo:desktop-observation:command': { input: observationCommandSchema, output: desktopObservationStateSchema },
  'momo:situation:command':{input:situationCommandSchema,output:situationSnapshotSchema},
  'momo:mail:command':{input:mailCommandSchema,output:mailResultSchema},
  'momo:conversation:clear':{input:z.object({id:uuidSchema}).strict(),output:workspaceSchema},
  'momo:task:receipt':{input:z.object({id:uuidSchema}).strict(),output:taskReceiptSchema},
  [channels.agent]:{input:agentCommandSchema,output:agentSnapshotSchema},
  [channels.calendarAction]:{input:calendarActionCommandSchema,output:calendarActionResultSchema},
  'momo:credentials:save': { input: saveCredentialSchema, output: snapshotSchema },
  [channels.workspace]: { input: z.undefined(), output: workspaceSchema },
  [channels.startRun]: { input: runRequestSchema, output: runSchema },
  [channels.cancelRun]: { input: z.object({ id: uuidSchema }).strict(), output: workspaceSchema },
  [channels.task]: { input: taskCommandSchema, output: workspaceSchema },
  [channels.snapshot]: { input: z.undefined(), output: snapshotSchema },
  [channels.settings]: { input: settingsUpdateSchema, output: snapshotSchema },
  [channels.importCredential]: { input: z.object({ provider: providerSchema }).strict(), output: snapshotSchema },
  [channels.removeCredential]: { input: z.object({ provider: providerSchema }).strict(), output: snapshotSchema },
  [channels.google]: { input: googleCommandSchema, output: snapshotSchema },
  [channels.inbox]: { input: inboxQuerySchema, output: inboxSchema },
  [channels.message]: { input: messageQuerySchema, output: messageSchema },
  [channels.calendar]: { input: calendarQuerySchema, output: calendarSchema },
};
export async function invokeOperation(channel: string, raw: unknown, trusted: boolean, execute: (input: unknown) => Promise<unknown>): Promise<Result<unknown>> {
  if (!trusted) return failure(new AppError('permission_denied', 'This window cannot access MoMo.'));
  const schema = schemas[channel];
  if (!schema) return failure(new AppError('invalid_input', 'Unknown operation.'));
  try {
    if (channel === 'momo:desktop-observation:command' && Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > desktopObservationLimits.requestBytes) return failure(new AppError('invalid_input', 'Desktop observation request is invalid (REQUEST_INVALID).'));
    if (raw !== undefined && JSON.stringify(raw).length > (channel==='momo:mail:command'?72000:channel==='momo:situation:command'?24000:4096)) return failure(new AppError('invalid_input', 'The request is too large.'));
    const parsed = schema.input.safeParse(raw);
    if (!parsed.success) return failure(new AppError('invalid_input', 'The request is invalid.'));
    const value = schema.output.parse(await execute(parsed.data));
    if (channel === 'momo:desktop-observation:command' && Buffer.byteLength(JSON.stringify({ ok: true, value }), 'utf8') > desktopObservationLimits.responseBytes) return failure(new AppError('unavailable', 'Desktop observation failed validation (RESPONSE_INVALID).'));
    return { ok: true, value };
  } catch (error) { return failure(error); }
}
