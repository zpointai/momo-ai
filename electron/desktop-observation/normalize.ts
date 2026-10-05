import { z } from 'zod';
import { contentBoundaryRoles, desktopObservationLimits as limits, functionalLabelRoles, observationText,
  observationTreeDataSchema, windowObservationSchema, observationReasonSchema, observationLimitSchema, observationStatusSchema,
  type NodeObservation } from '../../src/shared/desktop-observation';
import { AppError } from '../errors';

export const nativeWindowSchema = windowObservationSchema.omit({ targetId: true }).extend({ nativeId: z.string().uuid() }).strict();
export const nativeCatalogSchema = z.object({
  status: observationStatusSchema, reasons: z.array(observationReasonSchema).max(12),
  limitsHit: z.array(observationLimitSchema).max(8), elapsedMs: z.number().min(0).max(limits.requestMs),
  windows: z.array(nativeWindowSchema).max(limits.windows),
  examinedCandidates: z.number().int().min(0).max(limits.candidates),
}).strict();
export type NativeCatalog = z.infer<typeof nativeCatalogSchema>;
export type NativeTree = z.infer<typeof observationTreeDataSchema>;
export const invalidObservation = () => new AppError('unavailable', 'Desktop observation failed validation (RESPONSE_INVALID).');
export function boundedJson(value: unknown, maximum: number = limits.responseBytes) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > maximum) throw invalidObservation();
  return encoded;
}
function boundedStrings(values: unknown[]) {
  let bytes = 0;
  for (const value of values) if (value && typeof value === 'object' && 'state' in value && value.state === 'known' && 'value' in value && typeof value.value === 'string') {
    bytes += Buffer.byteLength(value.value, 'utf8');
    if (bytes > limits.stringBytes) throw invalidObservation();
  }
}
export function normalizeCatalog(raw: unknown): NativeCatalog {
  boundedJson(raw);
  const parsed = nativeCatalogSchema.safeParse(raw);
  if (!parsed.success) throw invalidObservation();
  const value = parsed.data;
  if (new Set(value.windows.map(w => w.nativeId)).size !== value.windows.length || value.examinedCandidates < value.windows.length) throw invalidObservation();
  if (!['AVAILABLE', 'PARTIAL'].includes(value.status) && value.windows.length) throw invalidObservation();
  for (const w of value.windows) {
    // Application identity is a basename only, never a path/title/command line.
    if (w.application.state === 'known' && (!observationText(80).safeParse(w.application.value).success || /[\\/:]/u.test(w.application.value))) throw invalidObservation();
  }
  boundedStrings(value.windows.map(w => w.application));
  return value;
}
export function mayCollectStrings(node: Pick<NodeObservation, 'role' | 'protectedContent'>): boolean {
  return node.protectedContent.state === 'known' && !node.protectedContent.value && functionalLabelRoles.includes(node.role);
}
export function normalizeTree(raw: unknown): NativeTree {
  boundedJson(raw);
  const parsed = observationTreeDataSchema.safeParse(raw);
  if (!parsed.success) throw invalidObservation();
  const value = parsed.data;
  if (value.visitedNodes < value.nodes.length || !['AVAILABLE', 'PARTIAL'].includes(value.status) && value.nodes.length) throw invalidObservation();
  const nodes = new Map<string, { depth: number; boundary: boolean; focused: boolean }>();
  const strings: unknown[] = [];
  for (const [index, node] of value.nodes.entries()) {
    if (nodes.has(node.id) || (index === 0 ? node.parentId !== null : node.parentId === null)) throw invalidObservation();
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    // Parent-before-child rejects cycles, orphan roots and foreign graph references.
    if (node.parentId !== null && (!parent || parent.boundary)) throw invalidObservation();
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > limits.depth) throw invalidObservation();
    const protectedOrUnknown = node.protectedContent.state !== 'known' || node.protectedContent.value;
    const boundary = protectedOrUnknown || contentBoundaryRoles.includes(node.role);
    if (!mayCollectStrings(node)) {
      node.name = { state: 'redacted' }; node.automationId = { state: 'redacted' }; node.className = { state: 'redacted' };
    }
    nodes.set(node.id, { depth, boundary, focused: node.hasKeyboardFocus.state === 'known' && node.hasKeyboardFocus.value });
    strings.push(node.name, node.automationId, node.className);
  }
  if (value.focus.state === 'in-target' && (!nodes.get(value.focus.nodeId)?.focused || value.foreground.state !== 'known' || !value.foreground.value || value.containsKeyboardFocus.state !== 'known' || !value.containsKeyboardFocus.value)) throw invalidObservation();
  boundedStrings(strings);
  return value;
}
