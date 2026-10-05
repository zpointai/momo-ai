import { calendarWriteScope } from '../../src/shared/calendar-actions';
import { z } from 'zod';
import { GoogleHttp, GoogleHttpError } from './http';
import { authorize, googleScopes, type Authorization } from './oauth';
import { clientSchema, type GoogleVault, type StoredAccount, type VaultData } from './vault';
import { normalizeEvent, normalizeMail, plainText } from './normalize';
import { AppError } from '../errors';
import { gmailComposeScope,gmailSendScope,gmailModifyScope,mailThreadSchema,type MailThread } from '../../src/shared/mail';
import { normalizeThreadMessage } from '../mail/mime';
import { addDays, calendarQuerySchema, calendarSchema, eventOnDate, inboxQuerySchema, inboxSchema, messageQuerySchema, messageSchema, type CalendarData, type CalendarQuery, type GoogleState, type InboxData, type InboxQuery, type MessageData, type MessageQuery } from '../../src/shared/google';
const tokenResponse = z.object({ access_token: z.string().min(1).max(8192), token_type: z.string().refine(value => value.toLowerCase() === 'bearer'), expires_in: z.number().int().min(1).max(86400), refresh_token: z.string().min(1).max(8192).optional(), scope: z.string().max(4096).optional() });
type AuthFlow = (clientId: string, openBrowser: (url: string) => Promise<void>, signal: AbortSignal, scopes?:string[]) => Promise<Authorization>;
export class GoogleService {
  private nativeObservation?: (value:InboxData|CalendarData)=>void;
  setNativeObservation(listener:(value:InboxData|CalendarData)=>void){this.nativeObservation=listener;}

  private data?: VaultData;
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private connection?: AbortController;
  private reads = new AbortController();
  private generation = 0;
  private refreshes = new Map<string, Promise<string>>();
  private cache = new Map<string, { until: number; saved: number; value: InboxData | MessageData | CalendarData }>();
  private inflight = new Map<string, Promise<InboxData | MessageData | CalendarData>>();
  private cooldown = new Map<string, number>();
  constructor(private vault: GoogleVault, private http: GoogleHttp, private openBrowser: (url: string) => Promise<void>, private changed: () => void, private auth: AuthFlow = (id, open, signal, scopes) => authorize(id,open,signal,180000,scopes), private now = Date.now) {
    this.ready = vault.read().then(value => { this.data = value; });
    void this.ready.catch(() => undefined);
  }
  async state(): Promise<GoogleState> {
    try { await this.ready; return { configuration: this.data!.client ? 'configured' : 'missing', connecting: !!this.connection, activeAccountId: this.data!.activeAccountId, accounts: this.data!.accounts.map(({ id, email, status, token }) => ({ id, email, status, calendarWrite:token.scopes.includes(calendarWriteScope),mailCompose:[gmailComposeScope,gmailModifyScope].some(s=>token.scopes.includes(s)),mailSend:[gmailSendScope,gmailComposeScope,gmailModifyScope].some(s=>token.scopes.includes(s)),mailModify:token.scopes.includes(gmailModifyScope) })) }; }
    catch { return { configuration: 'error', connecting: false, activeAccountId: null, accounts: [] }; }
  }
  private mutate(change: (current: VaultData) => VaultData) {
    const operation = this.queue.then(async () => { await this.ready; const next = change(this.data!); await this.vault.write(next); this.data = next; });
    this.queue = operation.catch(() => undefined); return operation;
  }
  async importClient(raw: unknown) {
    await this.ready;
    if (this.connection || this.data!.accounts.length) throw new AppError('conflict', 'Disconnect all Google accounts before replacing the desktop client.');
    const parsed = z.object({ installed: clientSchema }).safeParse(raw);
    if (!parsed.success) throw new AppError('invalid_input', 'Choose the JSON file for a Google OAuth Desktop app client.');
    await this.mutate(current => {
      if (this.connection || current.accounts.length) throw new AppError('conflict', 'Finish sign-in or disconnect Google accounts before replacing the desktop client.');
      return { ...current, client: parsed.data.installed };
    });
    this.changed();
  }
  calendarEpoch() {return this.generation;}
  async connect(writeAccount?:string,mailUpgrade?:'compose'|'modify') {
    await this.ready;
    if (this.connection) throw new AppError('conflict', 'Google sign-in is already open.');
    if (!this.data!.client) throw new AppError('unavailable', 'Import your Google Desktop OAuth client JSON first.');
    if(writeAccount && writeAccount!==this.data!.activeAccountId) throw new AppError('permission_denied','Choose the account to enable Calendar creation.');
    const prior=writeAccount?this.data!.accounts.find(a=>a.id===writeAccount):undefined;
    const requestedScopes=writeAccount?[...new Set([...googleScopes,...(prior?.token.scopes??[]),mailUpgrade?(mailUpgrade==='compose'?gmailComposeScope:gmailModifyScope):calendarWriteScope])]:googleScopes;
    this.invalidate();
    const client = this.data!.client;
    const controller = new AbortController(); this.connection = controller; this.changed();
    try {
      const authorization = await this.auth(client.client_id, this.openBrowser, controller.signal, requestedScopes);
      const raw = await this.http.json('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), grant_type: 'authorization_code', code: authorization.code, code_verifier: authorization.verifier, redirect_uri: authorization.redirectUri }), signal: controller.signal });
      const token = tokenResponse.parse(raw);
      const scopes = (token.scope ?? '').split(' ');
      if (!googleScopes.every(scope => scopes.includes(scope) || scope === 'email' && scopes.includes('https://www.googleapis.com/auth/userinfo.email'))) throw new AppError('permission_denied', 'Gmail and Calendar read permissions are needed. Connect again and select both permissions.');
      if (!token.refresh_token) throw new AppError('unavailable', 'Google did not issue offline access. Reconnect and approve access again.');
      // Identity comes from Google's authenticated UserInfo endpoint, never a decoded/unverified ID token.
      const identity = z.object({ sub: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), email: z.string().email().max(320), email_verified: z.literal(true) }).parse(await this.http.json('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token }, signal: controller.signal }));
      if(writeAccount && identity.sub!==writeAccount) throw new AppError('permission_denied','Choose the same Google account when enabling Calendar creation.');
      if(writeAccount && !scopes.includes(mailUpgrade?(mailUpgrade==='compose'?gmailComposeScope:gmailModifyScope):calendarWriteScope)) throw new AppError('permission_denied','The requested permission was not granted. Existing access is unchanged.');
      const equivalentScope=(scope:string)=>scope==='email'?'https://www.googleapis.com/auth/userinfo.email':scope;
      if(prior&&!prior.token.scopes.every(scope=>scopes.map(equivalentScope).includes(equivalentScope(scope))))throw new AppError('permission_denied','Existing permissions were not all returned. Existing access is unchanged; reconnect with the current permissions selected.');
      const account: StoredAccount = { id: identity.sub, email: identity.email, status: 'connected', token: { access: token.access_token, refresh: token.refresh_token, expiresAt: this.now() + token.expires_in * 1000, scopes } };
      await this.mutate(current => {
        if (controller.signal.aborted) throw new AppError('cancelled', 'Google sign-in cancelled.');
        const others = current.accounts.filter(value => value.id !== account.id);
        if (others.length >= 8) throw new AppError('invalid_input', 'MoMo supports up to eight Google accounts. Disconnect one first.');
        return { ...current, activeAccountId: account.id, accounts: [...others, account] };
      });
      this.invalidate();
    } finally { if (this.connection === controller) this.connection = undefined; this.changed(); }
  }
  cancel() { this.connection?.abort(); }
  close() { this.cancel(); this.invalidate(); }
  private invalidate() { this.generation++; this.reads.abort(); this.reads = new AbortController(); this.cache.clear(); this.inflight.clear(); }
  async select(id: string) {
    await this.mutate(current => { if (!current.accounts.some(account => account.id === id)) throw new AppError('invalid_input', 'Choose a connected account.'); return { ...current, activeAccountId: id }; });
    this.invalidate(); this.changed();
  }
  async disconnect(id: string) {
    this.cancel();
    // No revocation network call: explicit local removal, with Google account revocation documented in the UI.
    await this.mutate(current => {
      const accounts = current.accounts.filter(account => account.id !== id);
      return { ...current, accounts, activeAccountId: current.activeAccountId === id ? accounts[0]?.id ?? null : current.activeAccountId };
    });
    this.invalidate(); this.changed();
  }
  private async reconnect(account: StoredAccount) {
    await this.mutate(current => ({ ...current, accounts: current.accounts.map(value => value.id === account.id && value.token.access === account.token.access ? { ...value, status: 'reconnect' as const } : value) }));
    this.invalidate(); this.changed();
  }
  private async access(id: string): Promise<string> {
    await this.ready;
    const account = this.data!.accounts.find(value => value.id === id);
    if (!account || account.status === 'reconnect') throw new AppError('unavailable', 'Reconnect this Google account in Settings.');
    if (account.token.expiresAt > this.now() + 60000) return account.token.access;
    const existing = this.refreshes.get(id); if (existing) return existing;
    const operation = (async () => {
      try {
        const client = this.data!.client!;
        const token = tokenResponse.parse(await this.http.json('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), grant_type: 'refresh_token', refresh_token: account.token.refresh }) }));
        await this.mutate(current => {
          const present = current.accounts.find(value => value.id === id);
          if (!present || present.token.access !== account.token.access || present.token.refresh !== account.token.refresh) throw new AppError('cancelled', 'The Google account changed during refresh.');
          return { ...current, accounts: current.accounts.map(value => value.id !== id ? value : { ...value, token: { ...value.token, access: token.access_token, refresh: token.refresh_token ?? value.token.refresh, expiresAt: this.now() + token.expires_in * 1000, scopes:token.scope?token.scope.split(' '):value.token.scopes } }) };
        });
        return token.access_token;
      } catch (error) { if (error instanceof GoogleHttpError && (error.reason === 'invalid_grant' || error.status === 401)) await this.reconnect(account); throw error; }
    })();
    this.refreshes.set(id, operation);
    try { return await operation; } finally { if (this.refreshes.get(id) === operation) this.refreshes.delete(id); }
  }
  private async get(id: string, url: string, signal: AbortSignal) {
    if ((this.cooldown.get(id) ?? 0) > this.now()) throw new AppError('unavailable', 'Google is limiting requests. Wait a minute, then refresh.');
    const access = await this.access(id);
    if (signal.aborted) throw new AppError('cancelled', 'The account changed. Refresh this view.');
    try { return await this.http.json(url, { headers: { Authorization: 'Bearer ' + access }, signal }); }
    catch (error) {
      if (error instanceof GoogleHttpError && error.status === 429) this.cooldown.set(id, this.now() + 60000);
      if (error instanceof GoogleHttpError && error.status === 401) { const account = this.data!.accounts.find(value => value.id === id); if (account?.token.access === access) await this.reconnect(account); }
      throw error;
    }
  }
  private async read<T extends InboxData | MessageData | CalendarData>(accountId: string, key: string, refresh: boolean, fetchData: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.ready;
    if (accountId !== this.data!.activeAccountId || !this.data!.accounts.some(a => a.id === accountId && a.status === 'connected')) throw new AppError('permission_denied', 'Choose a connected Google account first.');
    const generation = this.generation;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now() && (!refresh || this.now() - cached.saved < 10000)) return { ...cached.value, cached: true } as T;
    const existing = this.inflight.get(key); if (existing) return existing as Promise<T>;
    const signal = this.reads.signal;
    const operation = fetchData(signal).then(value => {
      if (this.generation !== generation || signal.aborted) throw new AppError('cancelled', 'The account changed. Refresh this view.');
      if (this.cache.size >= 60) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, saved: this.now(), until: this.now() + 300000 }); if('messages' in value||'events' in value)this.nativeObservation?.(value); return value;
    });
    this.inflight.set(key, operation);
    try { return await operation; } finally { if (this.inflight.get(key) === operation) this.inflight.delete(key); }
  }
  async insertApprovedEvent(accountId:string, body:object, epoch:number, approvalValid:()=>boolean, beforeDispatch?:()=>Promise<void>):Promise<unknown> {
    await this.ready;
    const access=await this.access(accountId);
    const account=this.data!.accounts.find(a=>a.id===accountId);
    await beforeDispatch?.();
    // No await between the final authority check and dispatch.
    if(epoch!==this.generation || !approvalValid() || this.data!.activeAccountId!==accountId || account?.status!=='connected' || !account.token.scopes.includes(calendarWriteScope)) throw new AppError('permission_denied','Calendar permission or account changed before dispatch.');
    try {
      const result=await this.http.json('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none',{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify(body),signal:this.reads.signal});
      this.cache.clear(); return result;
    } catch(error) { if(error instanceof GoogleHttpError && error.status===401) await this.reconnect(account); throw error; }
  }
  async findApprovedEvent(accountId:string, eventId:string):Promise<unknown> {
    await this.ready;
    if(accountId!==this.data!.activeAccountId || !/^[A-Za-z0-9_-]{1,1024}$/.test(eventId)) throw new AppError('permission_denied','Choose the original account to check this event.');
    return this.get(accountId,'https://www.googleapis.com/calendar/v3/calendars/primary/events/'+encodeURIComponent(eventId),this.reads.signal);
  }
  async updateApprovedEvent(accountId:string,eventId:string,etag:string,body:object,epoch:number,approvalValid:()=>boolean):Promise<unknown>{
    await this.ready;
    if(!/^[A-Za-z0-9_-]{1,1024}$/.test(eventId)||!etag||/[\r\n]/.test(etag))throw new AppError('permission_denied','Invalid exact event revision.');
    const point=z.object({dateTime:z.string().datetime(),timeZone:z.string().max(80)}).strict();
    const patch=z.object({start:point,end:point}).strict().parse(body);
    if(Date.parse(patch.end.dateTime)<=Date.parse(patch.start.dateTime))throw new AppError('invalid_input','Invalid update interval.');
    const access=await this.access(accountId),account=this.data!.accounts.find(a=>a.id===accountId);
    if(epoch!==this.generation||!approvalValid()||this.data!.activeAccountId!==accountId||account?.status!=='connected'||!account.token.scopes.includes(calendarWriteScope))throw new AppError('permission_denied','Calendar permission or account changed before dispatch.');
    try{
      const result=await this.http.json('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+encodeURIComponent(eventId)+'?sendUpdates=none',{method:'PATCH',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json','If-Match':etag},body:JSON.stringify(patch),signal:this.reads.signal});
      this.cache.clear();return result;
    }catch(error){if(error instanceof GoogleHttpError&&error.status===401)await this.reconnect(account);throw error;}
  }
  inbox(raw: InboxQuery): Promise<InboxData> {
    const q = inboxQuerySchema.parse(raw);
    return this.read(q.accountId, JSON.stringify(['inbox-v2', q.accountId, q.pageToken,q.folder,q.query]), !!q.refresh, async signal => {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.search = new URLSearchParams({ ...((q.folder??'inbox')==='all'?{}:{labelIds:({inbox:'INBOX',sent:'SENT',trash:'TRASH',unread:'UNREAD',drafts:'DRAFT',all:''} as const)[q.folder??'inbox']}), ...(q.query?{q:q.query}:{}), ...(q.folder==='trash'?{includeSpamTrash:'true'}:{}), maxResults: '25', ...(q.pageToken ? { pageToken: q.pageToken } : {}) }).toString();
      const list = z.object({ messages: z.array(z.object({ id: messageQuerySchema.shape.id })).max(25).default([]), nextPageToken: z.string().max(2048).optional() }).parse(await this.get(q.accountId, url.toString(), signal));
      const messages: InboxData['messages'] = []; let failed = 0;
      for (let offset = 0; offset < list.messages.length; offset += 5) {
        const results = await Promise.allSettled(list.messages.slice(offset, offset + 5).map(async ({ id }) => normalizeMail(await this.get(q.accountId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To', signal))));
        for (const result of results) { if (result.status === 'fulfilled') messages.push(result.value); else failed++; }
      }
      return inboxSchema.parse({ accountId: q.accountId, fetchedAt: new Date(this.now()).toISOString(), cached: false, messages, nextPageToken: list.nextPageToken ?? null, failed });
    });
  }
  async readMailMessage(accountId:string,id:string){
    messageQuerySchema.parse({accountId,id});await this.ready;const epoch=this.generation;
    if(this.data!.activeAccountId!==accountId)throw new AppError('permission_denied','Select the original account.');
    const value=normalizeThreadMessage(await this.get(accountId,'https://gmail.googleapis.com/gmail/v1/users/me/messages/'+id+'?format=full',this.reads.signal));
    if(epoch!==this.generation||value.message.id!==id)throw new AppError('cancelled','The selected message or account changed.');return value;
  }
  async readMailThread(accountId:string,id:string):Promise<MailThread>{
    messageQuerySchema.parse({accountId,id});await this.ready;const epoch=this.generation;
    if(this.data!.activeAccountId!==accountId)throw new AppError('permission_denied','Select the original account.');
    const raw=z.object({id:messageQuerySchema.shape.id,messages:z.array(z.unknown()).default([])}).parse(await this.get(accountId,'https://gmail.googleapis.com/gmail/v1/users/me/threads/'+id+'?format=full',this.reads.signal));
    if(epoch!==this.generation||raw.id!==id)throw new AppError('cancelled','The selected thread or account changed.');
    const messages:MailThread['messages']=[];let invalid=0;for(const value of raw.messages.slice(0,50)){try{const m=normalizeThreadMessage(value);if(m.message.threadId!==id)throw new Error('Thread mismatch');messages.push(m);}catch{invalid++;}}
    return mailThreadSchema.parse({accountId,id,fetchedAt:new Date(this.now()).toISOString(),messages,truncated:raw.messages.length>50||invalid>0});
  }
  async writeMail(accountId:string,kind:'send'|'saveDraft'|'archive'|'read'|'unread'|'trash'|'restore'|'undo',input:{id?:string;raw?:string;threadId?:string;add?:string[];remove?:string[]},epoch:number,valid:()=>boolean):Promise<unknown>{
    await this.ready;const access=await this.access(accountId);const account=this.data!.accounts.find(a=>a.id===accountId);const scopes=account?.token.scopes??[];
    const permitted=kind==='send'?[gmailSendScope,gmailComposeScope,gmailModifyScope].some(s=>scopes.includes(s)):kind==='saveDraft'?[gmailComposeScope,gmailModifyScope].some(s=>scopes.includes(s)):scopes.includes(gmailModifyScope);
    if(input.id)messageQuerySchema.shape.id.parse(input.id);if(input.threadId)messageQuerySchema.shape.id.parse(input.threadId);
    if(input.raw&&!/^[A-Za-z0-9_-]{1,180000}$/.test(input.raw))throw new AppError('invalid_input','Invalid MIME message.');
    let suffix='',method='POST',body:object|undefined;
    if(kind==='saveDraft'){suffix='drafts'+(input.id?'/'+input.id:'');method=input.id?'PUT':'POST';body={...(input.id?{id:input.id}:{}),message:{raw:input.raw,...(input.threadId?{threadId:input.threadId}:{})}};}
    else if(kind==='send'){if(!input.raw)throw new AppError('invalid_input','An exact approved MIME message is required.');const message={raw:input.raw,...(input.threadId?{threadId:input.threadId}:{})};suffix=input.id?'drafts/send':'messages/send';body=input.id?{id:input.id,message}:message;}
    else {if(!input.id)throw new AppError('invalid_input','Select one message.');suffix='messages/'+input.id+'/'+(kind==='trash'?'trash':kind==='restore'?'untrash':'modify');if(!['trash','restore'].includes(kind)){const labels=['INBOX','UNREAD','TRASH'];if([...(input.add??[]),...(input.remove??[])].some(l=>!labels.includes(l)))throw new AppError('permission_denied','This label operation is not supported.');body={addLabelIds:input.add??[],removeLabelIds:input.remove??[]};}}
    // Credential refresh precedes the final account/scope/approval check. There is no await before dispatch.
    if(!permitted||epoch!==this.generation||this.data!.activeAccountId!==accountId||account?.status!=='connected'||!valid())throw new AppError('permission_denied','Mail permission, account or approval changed before dispatch.');
    try{const result=await this.http.json('https://gmail.googleapis.com/gmail/v1/users/me/'+suffix,{method,headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:this.reads.signal});this.cache.clear();return result;}catch(error){if(error instanceof GoogleHttpError&&error.status===401)await this.reconnect(account);throw error;}
  }
  async findSentMessage(accountId:string,messageId:string){
    if(!/^<momo\.[a-f0-9-]+\.\d+@momo\.local>$/.test(messageId))throw new AppError('invalid_input','Invalid sent-message identifier.');await this.ready;if(this.data!.activeAccountId!==accountId)throw new AppError('permission_denied','Select the original account.');
    return z.object({messages:z.array(z.object({id:messageQuerySchema.shape.id})).max(2).default([])}).parse(await this.get(accountId,'https://gmail.googleapis.com/gmail/v1/users/me/messages?'+new URLSearchParams({q:'in:sent rfc822msgid:'+messageId.slice(1,-1),maxResults:'2'}),this.reads.signal));
  }
  message(raw: MessageQuery): Promise<MessageData> {
    const q = messageQuerySchema.parse(raw);
    return this.read(q.accountId, JSON.stringify(['message-v1', q.accountId, q.id]), false, async signal => {
      const value = await this.get(q.accountId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + q.id + '?format=full', signal);
      return messageSchema.parse({ accountId: q.accountId, fetchedAt: new Date(this.now()).toISOString(), cached: false, message: normalizeMail(value), ...plainText(value) });
    });
  }
  summary(raw: MessageQuery, fresh=false): Promise<InboxData> {
    const q = messageQuerySchema.parse(raw);
    if(fresh)this.cache.delete(JSON.stringify(['summary-v1',q.accountId,q.id]));
    return this.read(q.accountId, JSON.stringify(['summary-v1',q.accountId,q.id]), false, async signal => {
      const value = await this.get(q.accountId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + q.id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To', signal);
      return inboxSchema.parse({ accountId:q.accountId, fetchedAt:new Date(this.now()).toISOString(), cached:false, messages:[normalizeMail(value)], nextPageToken:null, failed:0 });
    });
  }
  calendar(raw: CalendarQuery, fresh=false): Promise<CalendarData> {
    const q = calendarQuerySchema.parse(raw);
    if(fresh)this.cache.delete(JSON.stringify(['calendar-v1', q.accountId, q.startDate, q.endDate, q.timezone]));
    return this.read(q.accountId, JSON.stringify(['calendar-v1', q.accountId, q.startDate, q.endDate, q.timezone]), !!q.refresh, async signal => {
      // UTC envelope covers local dates through DST and UTC-12..UTC+14; filter exact local-date overlap below.
      const params = new URLSearchParams({ timeMin: addDays(q.startDate, -1) + 'T00:00:00Z', timeMax: addDays(q.endDate, 1) + 'T00:00:00Z', timeZone: q.timezone, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', showDeleted: 'false' });
      const events: CalendarData['events'] = []; const ids = new Set<string>(); let next: string | undefined; let skipped = 0;
      for (let page = 0; page < 4; page++) {
        if (next) params.set('pageToken', next);
        const result = z.object({ items: z.array(z.unknown()).max(250).default([]), nextPageToken: z.string().max(2048).optional() }).parse(await this.get(q.accountId, 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params, signal));
        for (const item of result.items) {
          try {
            const event = normalizeEvent(item);
            if (!event || ids.has(event.id)) continue;
            let overlaps = false;
            for (let day = q.startDate; day < q.endDate; day = addDays(day, 1)) if (eventOnDate(event, day, q.timezone)) { overlaps = true; break; }
            if (overlaps) { events.push(event); ids.add(event.id); }
          } catch { skipped++; }
        }
        next = result.nextPageToken; if (!next) break;
      }
      return calendarSchema.parse({ accountId: q.accountId, fetchedAt: new Date(this.now()).toISOString(), cached: false, timezone: q.timezone, startDate: q.startDate, endDate: q.endDate, events, truncated: !!next, skipped });
    });
  }
}
