import type { AgentRun, ProcessingResult } from '../../src/shared/orchestration';
import { processingResultSchema } from '../../src/shared/orchestration';
import type { AgentWorkItem, EvidenceLedger } from '../../src/shared/agent-team';
import { assertWorkItem } from './team';

export function sameCalendarTime(a: Record<string, unknown>, b: Record<string, unknown>) {
  if (a.kind !== b.kind) return false;
  return a.kind === 'allDay' ? a.startDate === b.startDate && a.endDate === b.endDate :
    typeof a.start === 'string' && typeof a.end === 'string' && typeof b.start === 'string' && typeof b.end === 'string' && Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
}

/** Native evidence/protocol checks run before optional semantics. This is not a truth oracle. */
export function evidenceLedger(run: AgentRun, work: AgentWorkItem, output: unknown, now: number): EvidenceLedger {
  const checks: EvidenceLedger['checks'] = [];
  const check = (code: string, ok: boolean, detail: string) => checks.push({ code, status: ok ? 'pass' : 'reject', detail });
  const parsed = processingResultSchema.safeParse(output);
  check('RESULT_SCHEMA', parsed.success, 'The registered result schema must parse exactly.');
  try { assertWorkItem(work, run, now); check('SOURCE_REVISIONS', true, 'Source scope, revision and freshness bindings match.'); }
  catch { check('SOURCE_REVISIONS', false, 'Source scope, revision or freshness binding failed.'); }
  check('REQUIRED_SOURCES', work.requiredEvidenceIds.every(id => work.context.bindings.some(b => b.evidenceId === id && b.delivery.mode === 'FULL' && !b.delivery.coverage.sourcePartial)), 'Required current-thread evidence must remain complete and FULL.');
  check('TOOL_COMPLETION', work.requiredTools.every(t => run.team?.toolCompletions.some(c => c.tool === t && c.workItemId === work.id)), 'Required native tool completions must be recorded.');
  if (parsed.success) {
    const r = parsed.data, ids = new Set(work.context.bindings.filter(b => b.delivery.mode !== 'REFERENCE_ONLY').map(b => b.evidenceId));
    check('EVIDENCE_IDS', [...r.evidence, ...r.reminders.map(m => m.sourceId), ...(r.calendarProposal?.evidence ?? [])].every(id => ids.has(id)) && (!ids.size || !!r.evidence.length), 'Citations and proposals must use delivered factual evidence IDs.');
    check('DELIVERABLES', !work.deliverables.includes('reply-or-clarification') || !!r.draft || !!r.clarification, 'A requested reply must supply a draft or a specific clarification.');
    check('CLARIFICATION', !(r.clarification && (r.draft || r.reminders.length || r.calendarProposal)), 'Missing owner information cannot accompany an action proposal.');
    check('EXACT_ACTION_SCOPE', (!run.background || !r.reminders.length) && (!r.draft || work.permission.actions.includes('local-reply')) && (!r.calendarProposal || work.permission.actions.includes('calendar-proposal') && r.calendarProposal.draft.accountId === work.accountId), 'Only the exact permitted proposal type and account are allowed.');
    const supplied = run.event.prompt + '\n' + run.context.items.filter(s => ids.has(s.id)).map(s => s.text).join('\n');
    const promises = r.draft?.match(/\b(?:I|we)(?: will|'ll)\s+(?:attend|deliver|send|complete|finish|pay|book|schedule|join)\b/gi) ?? [];
    check('OWNER_COMMITMENT', promises.every(p => run.event.prompt.toLowerCase().includes(p.toLowerCase())), 'Explicit first-person promises in a draft require the owner to supply that commitment.');
    check('CLAIMED_EXECUTION', !/\bI (?:have )?(?:sent|deleted|scheduled|booked|created the|created a)\b/i.test(r.text), 'This read-only specialist has no completed external action to claim.');
    const time = r.calendarProposal?.draft.time;
    check('EVENT_TIME_EVIDENCE', !time || (time.kind === 'timed' ? [time.start, time.end] : [time.startDate, time.endDate]).every(t => supplied.includes(t)), 'Exact proposed start and end must occur in permitted source evidence or the owner request. Unknown duration needs clarification.');
    const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const tasks = new Set(run.context.items.filter(s => s.kind === 'task').map(s => normalize(s.title)));
    check('DUPLICATE_TASK', new Set(r.reminders.map(m => normalize(m.title))).size === r.reminders.length && !r.reminders.some(m => tasks.has(normalize(m.title))), 'Normalized existing and repeated task titles are rejected.');
    check('DUPLICATE_EVENT', !r.calendarProposal || !run.context.items.some(s => {
      if (s.kind !== 'calendar' || normalize(s.title) !== normalize(r.calendarProposal!.draft.title)) return false;
      try { return sameCalendarTime(JSON.parse(s.text).time, r.calendarProposal!.draft.time); } catch { return false; }
    }), 'Exact event title/time duplicates are rejected.');
    const commitments = r.commitments ?? [];
    check('EXPLICIT_COMMITMENTS', commitments.every(c => {
      const s = run.context.items.find(s => s.id === c.sourceId && ids.has(s.id));
      return !!s && s.text.includes(c.quote) && c.quote.includes(c.text);
    }), 'Structured commitment claims need exact supporting source quotations.');
    checks.push({ code: 'SEMANTIC_CORRECTNESS', status: 'unknown', detail: 'ID and exact-match checks do not prove prose correctness, attendance, commitments or completeness.' });
  }
  return { workItemId: work.id, at: new Date(now).toISOString(), passed: !checks.some(c => c.status === 'reject'), checks, semantic: 'not-requested' };
}

export function deterministicPlanner(run: AgentRun): ProcessingResult {
  if (/^list my tasks$/i.test(run.event.prompt.trim())) {
    const tasks = run.context.items.filter(s => s.kind === 'task' && s.delivery?.mode === 'FULL');
    return { text: (tasks.map(s => s.title).join('\n') || 'No account-scoped tasks were supplied.') + (run.context.available.tasks ? '' : '\nTask coverage is incomplete or unavailable.'), draft: null, evidence: tasks.map(s => s.id), reminders: [] };
  }
  const events = run.context.items.filter(s => s.kind === 'calendar' && s.delivery?.mode === 'FULL').flatMap(s => {
    try { const data = JSON.parse(s.text); return data.status === 'cancelled' ? [] : [{ source: s, time: data.time as { kind: string; start?: string; end?: string; startDate?: string; endDate?: string } }]; } catch { return []; }
  });
  const lines: string[] = [];
  for (let i = 0; i < events.length; i++) for (const b of events.slice(i + 1)) {
    const a = events[i]; if (a.time.kind !== 'timed' || b.time.kind !== 'timed') continue;
    const startA = Date.parse(a.time.start ?? ''), startB = Date.parse(b.time.start ?? ''), endA = Date.parse(a.time.end ?? ''), endB = Date.parse(b.time.end ?? '');
    if (startA < endB && startB < endA) lines.push(`Possible conflict: ${a.source.title} [${a.source.id}] and ${b.source.title} [${b.source.id}]. Attendance is unknown.`);
    else if (!Number.isFinite(endA) && startA >= startB && startA < endB || !Number.isFinite(endB) && startB >= startA && startB < endA) lines.push(`Possible conflict: ${a.source.title} [${a.source.id}] and ${b.source.title} [${b.source.id}]. One duration is unknown.`);
  }
  lines.push(run.context.available.calendar ? 'This is a bounded calendar conflict check; attendance and commitments are not established.' : 'Calendar coverage is incomplete or unavailable; free time cannot be established.');
  if (events.some(e => e.time.kind !== 'timed' || !e.time.end)) lines.push('All-day entries or unknown durations do not establish timed attendance or availability.');
  return { text: lines.join('\n'), draft: null, evidence: events.map(e => e.source.id), reminders: [] };
}
