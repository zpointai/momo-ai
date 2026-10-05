import { z } from 'zod';
export const accountIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(value + 'T00:00:00Z'); return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value; });
export const timezoneSchema = z.string().max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } });
export const googleStateSchema = z.object({
  configuration: z.enum(['missing', 'configured', 'error']), connecting: z.boolean(), activeAccountId: accountIdSchema.nullable(),
  accounts: z.array(z.object({ id: accountIdSchema, email: z.string().max(320), status: z.enum(['connected', 'reconnect']), calendarWrite:z.boolean().optional(),mailCompose:z.boolean().optional(),mailSend:z.boolean().optional(),mailModify:z.boolean().optional() }).strict()).max(8),
}).strict();
export type GoogleState = z.infer<typeof googleStateSchema>;
export const emptyGoogle: GoogleState = { configuration: 'missing', connecting: false, activeAccountId: null, accounts: [] };
export const googleCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['import', 'connect', 'cancel']) }).strict(),
  z.object({action:z.literal('connectWrite'),accountId:accountIdSchema}).strict(),
  z.object({action:z.literal('connectMail'),accountId:accountIdSchema,capability:z.enum(['compose','modify'])}).strict(),
  z.object({ action: z.enum(['select', 'disconnect']), accountId: accountIdSchema }).strict(),
]);
export type GoogleCommand = z.infer<typeof googleCommandSchema>;
export const inboxQuerySchema = z.object({ accountId: accountIdSchema, pageToken: z.string().min(1).max(2048).optional(), query:z.string().max(300).optional(), folder:z.enum(['inbox','sent','all','trash','unread','drafts']).optional(), refresh: z.boolean().optional() }).strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export const messageQuerySchema = z.object({ accountId: accountIdSchema, id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).strict();
export type MessageQuery = z.infer<typeof messageQuerySchema>;
export const calendarQuerySchema = z.object({ accountId: accountIdSchema, startDate: dateSchema, endDate: dateSchema, timezone: timezoneSchema, refresh: z.boolean().optional() }).strict().refine(q => {
  const days = (+new Date(q.endDate) - +new Date(q.startDate)) / 86400000; return days > 0 && days <= 42;
});
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
export const mailSchema = z.object({ id: messageQuerySchema.shape.id, threadId: z.string().max(128), subject: z.string().max(2000), from: z.string().max(2000), to: z.string().max(4000), snippet: z.string().max(2000), receivedAt: z.string().datetime(), unread: z.boolean() }).strict();
export type Mail = z.infer<typeof mailSchema>;
const sourceFields = { accountId: accountIdSchema, fetchedAt: z.string().datetime(), cached: z.boolean() };
export const inboxSchema = z.object({ ...sourceFields, messages: z.array(mailSchema).max(25), nextPageToken: z.string().max(2048).nullable(), failed: z.number().int().nonnegative() }).strict();
export type InboxData = z.infer<typeof inboxSchema>;
export const messageSchema = z.object({ ...sourceFields, message: mailSchema, text: z.string().max(100000), textAvailable: z.boolean(), truncated: z.boolean() }).strict();
export type MessageData = z.infer<typeof messageSchema>;
export const eventTimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allDay'), startDate: dateSchema, endDate: dateSchema }).strict(),
  z.object({ kind: z.literal('timed'), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), startTimezone: z.string().max(80).nullable(), endTimezone: z.string().max(80).nullable() }).strict(),
]);
export const calendarEventSchema = z.object({ id: z.string().max(1024), etag:z.string().max(240).optional(), title: z.string().max(2000), location: z.string().max(2000), status: z.enum(['confirmed', 'tentative']), recurringEventId: z.string().max(1024).nullable(), originalStart: z.string().max(128).nullable(), time: eventTimeSchema }).strict();
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export const calendarSchema = z.object({ ...sourceFields, timezone: timezoneSchema, startDate: dateSchema, endDate: dateSchema, events: z.array(calendarEventSchema).max(1000), truncated: z.boolean(), skipped: z.number().int().nonnegative() }).strict();
export type CalendarData = z.infer<typeof calendarSchema>;
export function dateInZone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
}
export function addDays(value: string, days: number): string { return new Date(+new Date(value + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10); }
export function eventOnDate(event: CalendarEvent, day: string, timezone: string): boolean {
  if (event.time.kind === 'allDay') return event.time.startDate <= day && event.time.endDate > day;
  return dateInZone(new Date(event.time.start), timezone) <= day && dateInZone(new Date(Math.max(+new Date(event.time.start), +new Date(event.time.end) - 1)), timezone) >= day;
}

