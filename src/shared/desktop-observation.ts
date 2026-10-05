import { z } from 'zod';

/** Owner/native capability only. Never register this with agent tools or WorkItems. */
export const desktopObservationLimits = Object.freeze({
  windows: 64, candidates: 1024, depth: 12, nodes: 512, properties: 32,
  stringBytes: 16384, responseBytes: 262144, requestBytes: 4096,
  nameCharacters: 160, identityCharacters: 80, requestMs: 3000,
  nodeMs: 500, treeMs: 2000, enumerationMs: 1000,
  connectionMs: 500, transactionMs: 250, intervalMs: 1000, perMinute: 30,
  catalogMs: 30000, treeTtlMs: 15000, sessionMs: 300000,
  diagnosticEvents: 200, diagnosticMs: 600000,
});
export const desktopObserverProtocol = 1;
export const desktopObserverVersion = '0.1.0';
export const observationStatusSchema = z.enum(['AVAILABLE', 'PARTIAL', 'RESTRICTED', 'UNAVAILABLE', 'STALE', 'ERROR']);
export type ObservationStatus = z.infer<typeof observationStatusSchema>;
export const observed = <T extends z.ZodType>(schema: T) => z.discriminatedUnion('state', [
  z.object({ state: z.literal('known'), value: schema }).strict(),
  z.object({ state: z.enum(['unknown', 'unsupported', 'unavailable', 'redacted']) }).strict(),
]);
export type Observed<T> = { state: 'known'; value: T } | { state: 'unknown' | 'unsupported' | 'unavailable' | 'redacted' };
export const observationReasonSchema = z.enum([
  'PERMISSION_DISABLED', 'GLOBAL_PAUSE', 'OWNER_DECLINED', 'SESSION_REQUIRED', 'SESSION_EXPIRED',
  'CONTEXT_CHANGED', 'RENDERER_CHANGED', 'SYSTEM_SESSION_CHANGED', 'SHUTDOWN', 'CANCELLED',
  'TARGET_REQUIRED', 'TARGET_UNKNOWN', 'TARGET_EXPIRED', 'TARGET_STALE', 'TARGET_CHANGED',
  'RATE_LIMITED', 'BUSY', 'REQUEST_REPLAY', 'REQUEST_INVALID', 'RESPONSE_INVALID',
  'HELPER_MISSING', 'HELPER_IDENTITY', 'HELPER_PROTOCOL', 'HELPER_TIMEOUT', 'HELPER_EXIT',
  'HELPER_UNAVAILABLE', 'SELF_ELEVATED', 'INPUT_DESKTOP_RESTRICTED', 'TARGET_RESTRICTED',
  'UIA_UNAVAILABLE', 'UIA_FAILURE', 'FOCUS_UNAVAILABLE', 'FOCUS_CHANGED',
  'PROTECTED_CONTENT', 'TEXT_WITHHELD', 'LIMIT_REACHED', 'INTERNAL_FAILURE',
]);
export type ObservationReason = z.infer<typeof observationReasonSchema>;
export const observationLimitSchema = z.enum(['WINDOWS', 'CANDIDATES', 'DEPTH', 'NODES', 'STRINGS', 'BYTES', 'TIME', 'PROPERTIES']);
export type ObservationLimit = z.infer<typeof observationLimitSchema>;
const id = z.string().uuid();
// Reject malformed Unicode, control characters and bidi overrides before rendering.
export const observationText = (max: number) => z.string().max(max).refine(value =>
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
export const observationRectSchema = z.object({
  x: z.number().finite().min(-1000000).max(1000000), y: z.number().finite().min(-1000000).max(1000000),
  width: z.number().finite().min(0).max(1000000), height: z.number().finite().min(0).max(1000000),
}).strict();
export const observationRoleSchema = z.enum(['button', 'calendar', 'checkbox', 'combobox', 'edit', 'hyperlink',
  'image', 'listitem', 'list', 'menu', 'menubar', 'menuitem', 'progressbar', 'radio', 'scrollbar',
  'slider', 'spinner', 'statusbar', 'tab', 'tabitem', 'text', 'toolbar', 'tooltip', 'tree', 'treeitem',
  'custom', 'group', 'thumb', 'datagrid', 'dataitem', 'document', 'splitbutton', 'window', 'pane', 'header',
  'headeritem', 'table', 'titlebar', 'separator', 'semanticzoom', 'appbar', 'unknown']);
export const observationPatternSchema = z.enum(['invoke', 'value', 'text', 'selection', 'selection-item', 'toggle', 'expand-collapse', 'scroll']);
export const functionalLabelRoles: readonly z.infer<typeof observationRoleSchema>[] = Object.freeze([
  'button', 'checkbox', 'menuitem', 'radio', 'tabitem', 'slider', 'spinner', 'splitbutton', 'scrollbar',
]);
export const contentBoundaryRoles: readonly z.infer<typeof observationRoleSchema>[] = Object.freeze([
  'edit', 'document', 'text', 'listitem', 'datagrid', 'dataitem', 'tooltip', 'image', 'custom', 'unknown',
]);
const boolean = observed(z.boolean());
export const windowObservationSchema = z.object({
  targetId: id, pid: z.number().int().positive().max(0xffffffff),
  application: observed(observationText(80)), windowOrdinal: z.number().int().min(1).max(64),
  visible: boolean, state: observed(z.enum(['normal', 'minimized', 'maximized'])),
  foreground: boolean, containsKeyboardFocus: boolean, bounds: observed(observationRectSchema),
  elevation: observed(z.enum(['standard', 'elevated'])),
  accessibility: z.union([z.literal('not-checked'), observationStatusSchema]),
}).strict();
export type WindowObservation = z.infer<typeof windowObservationSchema>;
export const nodeObservationSchema = z.object({
  id: z.string().regex(/^n(?:0|[1-9]\d{0,2})$/), parentId: z.string().regex(/^n(?:0|[1-9]\d{0,2})$/).nullable(),
  role: observationRoleSchema, name: observed(observationText(160)),
  automationId: observed(observationText(80)), className: observed(observationText(80)),
  enabled: boolean, offscreen: boolean, keyboardFocusable: boolean, hasKeyboardFocus: boolean,
  readOnly: boolean, selected: boolean,
  toggle: observed(z.enum(['on', 'off', 'indeterminate'])),
  expansion: observed(z.enum(['expanded', 'collapsed', 'partial', 'leaf'])),
  bounds: observed(observationRectSchema), patterns: observed(z.array(observationPatternSchema).max(8).refine(v => new Set(v).size === v.length)),
  protectedContent: boolean,
}).strict();
export type NodeObservation = z.infer<typeof nodeObservationSchema>;
export const observationFocusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('in-target'), nodeId: nodeObservationSchema.shape.id }).strict(),
  z.object({ state: z.enum(['outside-target', 'unknown', 'unavailable', 'omitted']) }).strict(),
]);
const metadata = {
  status: observationStatusSchema, reasons: z.array(observationReasonSchema).max(12),
  limitsHit: z.array(observationLimitSchema).max(8), elapsedMs: z.number().finite().min(0).max(3000),
};
export const observationTreeDataSchema = z.object({
  ...metadata, nodes: z.array(nodeObservationSchema).max(512), focus: observationFocusSchema,
  foreground: boolean, containsKeyboardFocus: boolean,
  visitedNodes: z.number().int().min(0).max(512),
}).strict();
export const observationCatalogSchema = z.object({
  ...metadata, version: z.literal(1), sessionId: id, requestId: id, catalogId: id,
  observedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  windows: z.array(windowObservationSchema).max(64), examinedCandidates: z.number().int().min(0).max(1024),
}).strict();
export const treeObservationSchema = observationTreeDataSchema.extend({
  version: z.literal(1), sessionId: id, requestId: id, snapshotId: id, targetId: id,
  startedAt: z.string().datetime(), completedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type TreeObservation = z.infer<typeof treeObservationSchema>;
export type ObservationCatalog = z.infer<typeof observationCatalogSchema>;
export const observationCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['status', 'begin']), requestId: id }).strict(),
  z.object({ action: z.enum(['end', 'list']), requestId: id, sessionId: id }).strict(),
  z.object({ action: z.enum(['authorize', 'observe']), requestId: id, sessionId: id, targetId: id }).strict(),
  // A pending begin has no session yet. Cancellation still requires its exact request and caller.
  z.object({ action: z.literal('cancel'), requestId: id, sessionId: id.optional(), cancelRequestId: id }).strict(),
]);
export type DesktopObservationCommand = z.infer<typeof observationCommandSchema>;
export const observationDiagnosticSchema = z.object({
  requestId: id, targetId: id.nullable(), operation: z.enum(['begin', 'list', 'authorize', 'observe', 'cancel']),
  at: z.string().datetime(), status: z.union([observationStatusSchema, z.literal('REQUESTED')]),
  reason: observationReasonSchema.nullable(), nodeCount: z.number().int().min(0).max(512),
  limitsHit: z.array(observationLimitSchema).max(8), elapsedMs: z.number().min(0).max(3000),
}).strict();
export type ObservationDiagnostic = z.infer<typeof observationDiagnosticSchema>;
export const desktopObservationStateSchema = z.object({
  capability: z.literal('desktop.observe'), enabled: z.boolean(), status: observationStatusSchema,
  reason: observationReasonSchema.nullable(),
  session: z.object({ id, expiresAt: z.string().datetime(), targetId: id.nullable() }).strict().nullable(),
  catalog: observationCatalogSchema.nullable(), tree: treeObservationSchema.nullable(),
  diagnostics: z.array(observationDiagnosticSchema).max(200),
}).strict();
export type DesktopObservationState = z.infer<typeof desktopObservationStateSchema>;
