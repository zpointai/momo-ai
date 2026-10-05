import { createHash } from 'node:crypto';
import { contextBudgetSchema, contextChunkSchema, contextDiagnosticsSchema, type ContextBudget, type ContextChunk, type ContextCoverage, type ContextDiagnostics, type ContextMode, type ContextSize, type ContextToolDescriptor, type ContextWorkflow } from '../../src/shared/context';
import type { ModuleId, ResourceRef } from '../../src/shared/modules';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const resourceKey = (ref: ResourceRef) => digest([ref.profile, ref.accountId, ref.connector, ref.module, ref.type, ref.id]);
export const measure = (text: string): ContextSize => ({ characters: text.length, bytes: Buffer.byteLength(text, 'utf8'), estimatedTokens: Math.ceil(text.length / 4) });
const emptySize = (): ContextSize => ({ characters: 0, bytes: 0, estimatedTokens: 0 });
const addSize = (a: ContextSize, b: ContextSize): ContextSize => ({ characters: a.characters + b.characters, bytes: a.bytes + b.bytes, estimatedTokens: a.estimatedTokens + b.estimatedTokens });

export interface ContextDelivery {
  chunk: ContextChunk;
  mode: Exclude<ContextMode, 'EXCLUDE'>;
  text: string;
  coverage: ContextCoverage;
}
/** Created only by native loaders. Neither a renderer nor a provider supplies these facts. */
export interface ContextCandidate {
  chunk: ContextChunk;
  text: string;
  relation: 'current-thread' | 'selected' | 'snapshot' | 'required-proposal' | 'candidate';
  required?: boolean;
  fineDetail?: boolean;
  partial?: boolean;
  structured?: boolean;
  preferredMode?: Exclude<ContextMode, 'EXCLUDE'>;
  requiredCapabilities?: readonly string[];
  requiredTools?: readonly string[];
  /** Measures exactly the existing provider-facing item, including its metadata. */
  encode(delivery: ContextDelivery): unknown;
}
export function makeChunk(input: Omit<ContextChunk, 'id' | 'size'>, text: string): ContextChunk {
  return contextChunkSchema.parse({ ...input, id: digest([resourceKey(input.ref), input.category]), size: measure(input.descriptor + text) });
}
export interface ContextWorkItem {
  id: string;
  workflow: ContextWorkflow;
  objective: string;
  accountId: string | null;
  profile: ResourceRef['profile'];
  destination: 'provider' | 'local';
  enabled: boolean;
  budget: ContextBudget;
  now: number;
  maxAgeMs: number;
  disabledModules: readonly ModuleId[];
  capabilities: readonly string[];
  allowedTools: readonly string[];
  requiredCapabilities?: readonly string[];
  requiredTools?: readonly string[];
  /** Native resource bindings, not model-selected source IDs. */
  references: readonly string[];
  requiredReferences?: readonly string[];
  /** Independently constructed from current native permissions and source revisions. */
  grants: ReadonlyMap<string, { revision: string; provider: boolean }>;
  allowRetained: boolean;
  categoryLimits?: Partial<Record<ContextChunk['category'], number>>;
}
export interface ContextRelevanceAdvisor {
  /** Only permitted descriptors reach this seam. No authority fields can be returned. */
  assess(objective: string, candidates: readonly Pick<ContextChunk, 'id' | 'category' | 'descriptor'>[]): readonly {
    id: string; signal: 'relevant' | 'irrelevant' | 'uncertain';
  }[];
}
export interface ContextSelection {
  deliveries: ContextDelivery[];
  diagnostics: ContextDiagnostics;
  tools: ContextToolDescriptor[];
}

function policyReason(c: ContextCandidate, w: ContextWorkItem): string | null {
  const { ref } = c.chunk;
  if (!w.enabled) return 'WORKFLOW_DISABLED';
  if (ref.profile !== w.profile) return 'PROFILE_MISMATCH';
  if (ref.accountId !== w.accountId) return 'ACCOUNT_MISMATCH';
  if (w.disabledModules.includes(ref.module)) return 'MODULE_DISABLED';
  const grant = w.grants.get(resourceKey(ref));
  if (!grant) return 'INACCESSIBLE_SOURCE';
  if (w.destination === 'provider' && (!grant.provider || c.chunk.sharing === 'local-only' || c.chunk.sensitivity === 'restricted')) return 'DISCLOSURE_DENIED';
  if (grant.revision !== ref.revision) return 'REVISION_MISMATCH';
  if (ref.retention.expiresAt && Date.parse(ref.retention.expiresAt) <= w.now) return 'SOURCE_EXPIRED';
  if ([...(w.requiredCapabilities ?? []), ...(c.requiredCapabilities ?? [])].some(v => !w.capabilities.includes(v))) return 'CAPABILITY_UNAVAILABLE';
  if ([...(w.requiredTools ?? []), ...(c.requiredTools ?? [])].some(v => !w.allowedTools.includes(v))) return 'TOOL_UNAVAILABLE';
  if (c.chunk.freshness === 'unavailable') return 'SOURCE_UNAVAILABLE';
  if (c.chunk.freshness === 'stale' || (c.chunk.freshness === 'retained' && !w.allowRetained) || (c.chunk.freshness === 'current' && Math.abs(w.now - Date.parse(c.chunk.observedAt)) > w.maxAgeMs)) return 'SOURCE_STALE';
  if ((c.required || c.fineDetail) && c.partial) return 'INCOMPLETE_REQUIRED_SOURCE';
  return null;
}
const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'your', 'about', 'please', 'what', 'when', 'which', 'would', 'could', 'should', 'reply', 'message', 'email', 'calendar', 'event', 'task']);
/** Small, replaceable native relevance rule; never an access check. */
export function lexicalRelevance(objective: string, descriptor: string): number {
  const words = (s: string) => new Set((s.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(v => !stopWords.has(v)));
  const query = words(objective), source = words(descriptor);
  return [...query].filter(v => source.has(v)).length;
}
function rank(c: ContextCandidate, w: ContextWorkItem): { score: number; reason: string } {
  if (c.required || w.requiredReferences?.includes(resourceKey(c.chunk.ref))) return { score: 10000, reason: 'REQUIRED_SOURCE' };
  if (w.references.includes(resourceKey(c.chunk.ref)) || c.relation === 'selected') return { score: 9000, reason: 'EXPLICIT_REFERENCE' };
  if (c.relation === 'current-thread') return { score: 8000, reason: 'CURRENT_THREAD' };
  if (c.relation === 'required-proposal') return { score: 7500, reason: 'WORKFLOW_PROPOSAL' };
  if (c.relation === 'snapshot') return { score: 7000, reason: 'CURRENT_SNAPSHOT' };
  const score = lexicalRelevance(w.objective, c.chunk.descriptor);
  return { score: Math.min(score, 100), reason: score ? 'NATIVE_RELEVANCE' : 'UNRELATED_SOURCE' };
}
function deliver(c: ContextCandidate, mode: ContextDelivery['mode'], summaryCharacters: number): ContextDelivery {
  let text = c.text;
  let method: ContextCoverage['method'] = 'source';
  if (mode === 'REFERENCE_ONLY') { text = ''; method = 'reference'; }
  if (mode === 'SUMMARY') {
    // Exact excerpts only. Structured objects are never cut into misleading partial JSON.
    text = c.structured ? '' : c.text.slice(0, summaryCharacters);
    if (/^[\s\S]*[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    method = 'extractive';
  }
  const omittedCharacters = c.text.length - text.length;
  return { chunk: c.chunk, mode, text, coverage: { status: c.partial || omittedCharacters ? 'partial' : 'complete', suppliedCharacters: text.length, omittedCharacters, sourcePartial: !!c.partial, method } };
}
/** Policy and budget selection is synchronous and deterministic; no retrieval or inference. */
export function selectContext(work: ContextWorkItem, candidates: readonly ContextCandidate[], advisor?: ContextRelevanceAdvisor, descriptors: readonly ContextToolDescriptor[] = []): ContextSelection {
  if (candidates.length > 100) throw new Error('Context candidate bound exceeded.');
  const budget = contextBudgetSchema.parse(work.budget);
  const rows = candidates.map(c => ({ c, reason: policyReason(c, work), ranking: rank(c, work) }));
  const permitted = rows.filter(r => !r.reason);
  const advisory = new Map<string, 'relevant' | 'irrelevant' | 'uncertain'>();
  if (advisor) {
    try {
      const permittedIds = new Set(permitted.map(r => r.c.chunk.id));
      for (const a of advisor.assess(work.objective, permitted.map(({ c }) => ({ id: c.chunk.id, category: c.chunk.category, descriptor: c.chunk.descriptor })))) {
        if (permittedIds.has(a.id) && ['relevant', 'irrelevant', 'uncertain'].includes(a.signal)) advisory.set(a.id, a.signal);
      }
    } catch { /* An unavailable advisory signal cannot change native authority or relevance. */ }
  }
  // A duplicate with conflicting content or policy must never win by input order.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const key = resourceKey(r.c.chunk.ref); groups.set(key, [...(groups.get(key) ?? []), r]); }
  for (const group of groups.values()) if (group.length > 1) {
    const identities = new Set(group.map(r => digest([r.c.chunk.ref.revision, r.c.text, r.c.chunk.sharing, r.reason, r.c.partial, r.c.fineDetail])));
    if (identities.size > 1) group.forEach(r => { r.reason = 'CONFLICTING_DUPLICATE'; });
  }
  const selected: ContextDelivery[] = [], seen = new Set<string>();
  const limits: Partial<Record<ContextChunk['category'], number>> = {};
  let used = emptySize(), blocked = !work.enabled || (work.requiredCapabilities ?? []).some(v => !work.capabilities.includes(v)) || (work.requiredTools ?? []).some(v => !work.allowedTools.includes(v));
  const diagnostics: ContextDiagnostics['candidates'] = [];
  // Advisory can order optional ties only. It cannot override explicit references or native exclusion.
  const advisoryScore = (id: string) => advisory.get(id) === 'relevant' ? 1 : 0;
  rows.sort((a, b) => b.ranking.score - a.ranking.score || (a.ranking.score < 7000 ? advisoryScore(b.c.chunk.id) - advisoryScore(a.c.chunk.id) : 0));
  for (const row of rows) {
    const { c, ranking } = row, required = c.required || work.requiredReferences?.includes(resourceKey(c.chunk.ref));
    let reason = row.reason, mode: ContextMode = 'EXCLUDE', deliveredSize = emptySize();
    if (!reason && seen.has(resourceKey(c.chunk.ref))) reason = 'DUPLICATE_REFERENCE';
    if (!reason) seen.add(resourceKey(c.chunk.ref));
    if (!reason && !ranking.score) reason = 'UNRELATED_SOURCE';
    if (!reason && (selected.length >= budget.maxChunks || (limits[c.chunk.category] ?? 0) >= (work.categoryLimits?.[c.chunk.category] ?? Infinity))) reason = 'CHUNK_LIMIT';
    if (!reason) {
      const preferred = c.preferredMode ?? 'FULL';
      const modes: ContextDelivery['mode'][] = c.fineDetail || required ? ['FULL'] : preferred === 'REFERENCE_ONLY' ? ['REFERENCE_ONLY'] : preferred === 'SUMMARY' ? ['SUMMARY', 'REFERENCE_ONLY'] : ['FULL', 'SUMMARY', 'REFERENCE_ONLY'];
      for (const choice of modes) {
        const delivery = deliver(c, choice, budget.summaryCharacters);
        if (choice === 'SUMMARY' && !delivery.coverage.omittedCharacters && preferred !== 'SUMMARY') continue;
        const size = measure(JSON.stringify(c.encode(delivery)));
        if (used.bytes + size.bytes > budget.maxBytes || used.estimatedTokens + size.estimatedTokens > budget.maxEstimatedTokens) continue;
        selected.push(delivery); used = addSize(used, size); deliveredSize = size; mode = choice;
        limits[c.chunk.category] = (limits[c.chunk.category] ?? 0) + 1;
        reason = choice === 'FULL' ? ranking.reason : choice === preferred ? 'WORKFLOW_DELIVERY_MODE' : choice === 'SUMMARY' ? 'BUDGET_SUMMARY' : 'BUDGET_REFERENCE';
        break;
      }
      reason ??= 'BUDGET_EXHAUSTED';
    }
    if (required && mode !== 'FULL' && reason !== 'DUPLICATE_REFERENCE') blocked = true;
    diagnostics.push({ id: c.chunk.id, category: c.chunk.category, revision: digest(c.chunk.ref.revision), observedAt: c.chunk.observedAt, freshness: c.chunk.freshness, mode, reason, advisory: advisory.get(c.chunk.id) ?? null, size: c.chunk.size, deliveredSize, reuse: c.chunk.reuse.state });
  }
  if (work.requiredReferences?.some(key => !selected.some(s => resourceKey(s.chunk.ref) === key && s.mode === 'FULL'))) blocked = true;
  const counts = { EXCLUDE: 0, REFERENCE_ONLY: 0, SUMMARY: 0, FULL: 0 };
  diagnostics.forEach(d => counts[d.mode]++);
  return {
    deliveries: selected,
    diagnostics: contextDiagnosticsSchema.parse({ version: 1, workItemId: work.id, workflow: work.workflow, at: new Date(work.now).toISOString(), budget, candidateSize: candidates.reduce((n, c) => addSize(n, measure(JSON.stringify(c.encode(deliver(c, 'FULL', budget.summaryCharacters))))), emptySize()), selectedSize: used, counts, reused: selected.filter(s => s.chunk.reuse.state === 'reused').length, loaded: selected.filter(s => s.chunk.reuse.state === 'loaded').length, blocked, candidates: diagnostics }),
    tools: !blocked ? descriptors.filter(d => work.allowedTools.includes(d.id) && work.capabilities.includes(d.capability)) : [],
  };
}
