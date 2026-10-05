import { createHash } from 'node:crypto';
import type { MailThread } from '../../src/shared/mail';
/** Ignore fetch time; bind every message, body and reply header in the retrieved thread. */
export function threadRevision(thread:MailThread){return createHash('sha256').update(JSON.stringify({accountId:thread.accountId,id:thread.id,truncated:thread.truncated,messages:thread.messages.map(({labels:_labels,message,...content})=>({message:{...message,unread:undefined},...content}))})).digest('hex');}
