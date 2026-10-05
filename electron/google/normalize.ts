import { z } from 'zod';
import { calendarEventSchema, dateSchema, type CalendarEvent, type Mail } from '../../src/shared/google';
const messageInput = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), threadId: z.string().max(128), internalDate: z.string().regex(/^\d{1,16}$/),
  labelIds: z.array(z.string()).max(200).default([]), snippet: z.string().max(10000).default(''),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).max(1000).default([]) }).passthrough().default({ headers: [] }),
});
export function normalizeMail(raw: unknown): Mail {
  const input = messageInput.parse(raw);
  const header = (name: string, limit: number) => (input.payload.headers.find(h => h.name.toLowerCase() === name)?.value ?? '').slice(0, limit);
  return { id: input.id, threadId: input.threadId, subject: header('subject', 2000) || '(No subject)', from: header('from', 2000), to: header('to', 4000), snippet: input.snippet.slice(0, 2000), receivedAt: new Date(Number(input.internalDate)).toISOString(), unread: input.labelIds.includes('UNREAD') };
}
export function plainText(raw: unknown): { text: string; textAvailable: boolean; truncated: boolean } {
  const chunks: string[] = []; let nodes = 0; let truncated = false;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 500 || depth > 20) { truncated = true; return; }
    const part = z.object({ mimeType: z.string().optional(), filename: z.string().optional(), headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(), body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(), parts: z.array(z.unknown()).optional() }).safeParse(value);
    if (!part.success || part.data.filename || part.data.headers?.some(header => header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value))) return;
    if (part.data.mimeType === 'text/plain' && part.data.body?.data) chunks.push(Buffer.from(part.data.body.data, 'base64url').toString('utf8'));
    for (const child of part.data.parts ?? []) visit(child, depth + 1);
  };
  const body = z.object({ payload: z.unknown() }).parse(raw);
  visit(body.payload, 0);
  const text = chunks.join('\n\n').replace(/\u0000/g, '');
  return { text: text.slice(0, 100000), textAvailable: chunks.length > 0, truncated: truncated || text.length > 100000 };
}
const pointSchema = z.object({ date: dateSchema.optional(), dateTime: z.string().datetime({ offset: true }).optional(), timeZone: z.string().max(80).optional() });
export function normalizeEvent(raw: unknown): CalendarEvent | null {
  const input = z.object({
    id: z.string().max(1024), etag:z.string().max(240).optional(), status: z.enum(['confirmed', 'tentative', 'cancelled']).default('confirmed'),
    summary: z.string().default('(Untitled event)'), location: z.string().default(''),
    start: pointSchema.optional(), end: pointSchema.optional(),
    recurringEventId: z.string().max(1024).optional(), originalStartTime: pointSchema.optional(),
  }).parse(raw);
  if (input.status === 'cancelled') return null;
  if (!input.start || !input.end) throw new Error('Missing event bounds');
  const time = input.start.date && input.end.date
    ? { kind: 'allDay' as const, startDate: input.start.date, endDate: input.end.date }
    : { kind: 'timed' as const, start: input.start.dateTime, end: input.end.dateTime, startTimezone: input.start.timeZone ?? null, endTimezone: input.end.timeZone ?? null };
  const event = calendarEventSchema.parse({ id: input.id, ...(input.etag?{etag:input.etag}:{}), title: input.summary.slice(0, 2000), location: input.location.slice(0, 2000), status: input.status, recurringEventId: input.recurringEventId ?? null, originalStart: input.originalStartTime?.dateTime ?? input.originalStartTime?.date ?? null, time });
  if (event.time.kind === 'allDay' ? event.time.endDate <= event.time.startDate : +new Date(event.time.end) < +new Date(event.time.start)) throw new Error('Invalid event duration');
  return event;
}
