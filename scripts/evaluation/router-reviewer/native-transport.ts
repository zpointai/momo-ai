import { createHash } from 'node:crypto';
import type { CredentialStore } from '../../../electron/credentials/store';
import { parseProviderJson } from './strict-json';

// Benchmark-only: never imported by main/preload/renderer; no credential getter,
// environment export, file credential, logging, telemetry or production registration.
const endpoints = {
  'jev-1.13.0': ['jev', 'https://api.typesafe.ai/v1/systemone'],
  'deepseek-flash': ['deepseek', 'https://api.deepseek.com/chat/completions'],
  'gpt-6-luna': ['openai', 'https://api.openai.com/v1/responses'],
} as const;
export type AdvisoryModel = keyof typeof endpoints;
export type LockedAdvisoryRequest = { id: string; model: AdvisoryModel; body: unknown; bodySha256: string; reservation: { usd: number } };
export type NativeApproval = { benchmark: 'momo-router-reviewer-v1'; ownerApproved: boolean; manifestSha256: string; expiresAt: number; ceilingUsd: number };
export interface NativeRequestJournal {
  // Must atomically reject replay, exhausted budget/time/count and unknown exposure.
  // Called before credential access. Receives no secret, headers or provider body.
  reserve(input: { requestId: string; requestSha256: string; maximumUsd: number; ceilingUsd: number }): Promise<void>;
}
export class NativeCredentialBoundaryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NativeCredentialBoundaryError'; }
}
function reject(code: string): never { throw new NativeCredentialBoundaryError(code); }
const publicFailureCodes = new Set(['PROTECTED_CREDENTIAL_UNAVAILABLE', 'PROTECTED_CREDENTIAL_INVALID', 'CREDENTIAL_MATERIAL_REJECTED', 'PROVIDER_HTTP_FAILURE', 'RESPONSE_TOO_LARGE']);
export const publicRequestHash = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
function assertNoSecret(value: string, key: string) {
  const variants = [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), JSON.stringify(key).slice(1, -1)];
  if (variants.some(v => value.includes(v)) || /\bBearer\s+[A-Za-z0-9_./+\-=]{8,}|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/i.test(value)) reject('CREDENTIAL_MATERIAL_REJECTED');
}

export class NativeRouterReviewerDispatcher {
  private readonly attempted = new Set<string>();
  private readonly requests: Map<string, LockedAdvisoryRequest>;
  private readonly approval: NativeApproval | null;
  constructor(
    private readonly credentials: Pick<CredentialStore, 'read'>,
    private readonly manifestSha256: string,
    requests: readonly LockedAdvisoryRequest[],
    approval: NativeApproval | null,
    private readonly journal: NativeRequestJournal,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.requests = new Map(requests.map(r => [r.id, structuredClone(r)]));
    this.approval = approval ? structuredClone(approval) : null;
  }
  async dispatch(requestId: string, signal: AbortSignal): Promise<{ status: number; body: unknown; bytes: number; requestSha256: string }> {
    const approval = this.approval;
    if (!approval?.ownerApproved || approval.benchmark !== 'momo-router-reviewer-v1') reject('OWNER_APPROVAL_REQUIRED');
    if (approval.manifestSha256 !== this.manifestSha256) reject('MANIFEST_MISMATCH');
    if (approval.expiresAt <= this.now() || approval.expiresAt > this.now() + 24 * 3600 * 1000) reject('APPROVAL_EXPIRED_OR_INVALID');
    if (!Number.isFinite(approval.ceilingUsd) || approval.ceilingUsd <= 0 || approval.ceilingUsd > .45) reject('BUDGET_INVALID');
    const request = this.requests.get(requestId);
    if (!request || !Object.hasOwn(endpoints, request.model)) reject('REQUEST_NOT_LOCKED');
    if (this.attempted.has(requestId)) reject('DUPLICATE_DISPATCH');
    const encoded = JSON.stringify(request.body);
    if (Buffer.byteLength(encoded) > 14000 || publicRequestHash(request.body) !== request.bodySha256) reject('REQUEST_CHANGED');
    if (!Number.isFinite(request.reservation.usd) || request.reservation.usd <= 0 || request.reservation.usd > approval.ceilingUsd) reject('RESERVATION_INVALID');
    if (signal.aborted) reject('REQUEST_ABORTED');
    this.attempted.add(requestId);
    try { await this.journal.reserve({ requestId, requestSha256: request.bodySha256, maximumUsd: request.reservation.usd, ceilingUsd: approval.ceilingUsd }); }
    catch { reject('ADMISSION_OR_JOURNAL_FAILED'); }
    // No asynchronous step between final credential read and network dispatch.
    // No long-lived key map: rotation/removal takes effect on the next read.
    let key = '';
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [];
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    try {
      const [provider, endpoint] = endpoints[request.model];
      try { key = await this.credentials.read(provider); } catch { reject('PROTECTED_CREDENTIAL_UNAVAILABLE'); }
      if (!/^[\x21-\x7e]{8,2048}$/.test(key)) reject('PROTECTED_CREDENTIAL_INVALID');
      assertNoSecret(encoded, key);
      timeout.throwIfAborted();
      const response = await this.fetcher(endpoint, { method: 'POST', redirect: 'error', signal: timeout,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: encoded });
      // Never expose Response/Request objects or either direction's headers.
      if (!response.ok || !response.body) reject('PROVIDER_HTTP_FAILURE');
      reader = response.body.getReader();
      let bytes = 0;
      for (;;) {
        timeout.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 262144) { part.value.fill(0); reject('RESPONSE_TOO_LARGE'); }
        chunks.push(part.value);
      }
      const joined = Buffer.concat(chunks);
      let text: string;
      try { text = joined.toString('utf8'); } finally { joined.fill(0); }
      assertNoSecret(text, key);
      const body: unknown = parseProviderJson(text);
      // Decode JSON escapes before permitting diagnostics or downstream parsing.
      assertNoSecret(JSON.stringify(body), key);
      return { status: response.status, body, bytes, requestSha256: request.bodySha256 };
    } catch (error) {
      // Do not attach cause, original exception, URL, body or provider headers.
      const safe = error instanceof NativeCredentialBoundaryError && publicFailureCodes.has(error.code) ? error.code : timeout.aborted ? 'REQUEST_ABORTED_USAGE_UNKNOWN' : 'REQUEST_FAILED_USAGE_UNKNOWN';
      throw new NativeCredentialBoundaryError(safe);
    } finally {
      key = ''; // Release references. JS/native/OS memory cannot promise secure zeroization.
      for (const chunk of chunks) chunk.fill(0);
      if (reader) await reader.cancel().catch(() => undefined);
    }
  }
}
