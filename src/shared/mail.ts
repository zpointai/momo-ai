import { z } from 'zod';
import { accountIdSchema,messageQuerySchema,mailSchema } from './google';
import { uuidSchema } from './assistant';
export const gmailComposeScope='https://www.googleapis.com/auth/gmail.compose';
export const gmailSendScope='https://www.googleapis.com/auth/gmail.send';
export const gmailModifyScope='https://www.googleapis.com/auth/gmail.modify';
const id=messageQuerySchema.shape.id;const hash=z.string().regex(/^[a-f0-9]{64}$/);
const header=z.string().max(2000).refine(v=>!/[\r\n\u0000-\u001f\u007f]/.test(v),'Mail headers cannot contain control characters.');
export const mailFieldsSchema=z.object({to:header,cc:header,bcc:header,subject:header.max(998),body:z.string().max(60000)}).strict();
export type MailFields=z.infer<typeof mailFieldsSchema>;
export const localMailDraftSchema=z.object({id:uuidSchema,accountId:accountIdSchema,from:z.string().email().max(320),provenance:z.object({runId:uuidSchema,threadRevision:hash,workflow:z.literal('inbox-planner-v1').optional()}).strict().optional(),mode:z.enum(['compose','reply','replyAll','forward']),sourceMessageId:id.nullable(),threadId:id.nullable(),inReplyTo:z.string().max(300).nullable(),references:z.string().max(2000),fields:mailFieldsSchema,revision:z.number().int().nonnegative(),contentRevision:z.number().int().nonnegative().default(0),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),status:z.enum(['local','remote','sending','sent','unknown']),remoteDraftId:id.nullable(),remoteRevision:z.number().int().nullable(),sentMessageId:id.nullable()}).strict();
export type LocalMailDraft=z.infer<typeof localMailDraftSchema>;
export const mailThreadMessageSchema=z.object({message:mailSchema,text:z.string().max(100000),textAvailable:z.boolean(),truncated:z.boolean(),attachments:z.array(z.object({filename:z.string().max(240),size:z.number().int().nonnegative()}).strict()).max(100),headers:z.object({replyTo:header,cc:header,messageId:z.string().max(300),references:z.string().max(2000)}).strict(),labels:z.array(z.string().max(100)).max(200)}).strict();
export const mailThreadSchema=z.object({accountId:accountIdSchema,id,revision:hash.optional(),fetchedAt:z.string().datetime(),messages:z.array(mailThreadMessageSchema).max(50),truncated:z.boolean()}).strict();
export type MailThread=z.infer<typeof mailThreadSchema>;
export const mailActionSchema=z.object({id:uuidSchema,accountId:accountIdSchema,kind:z.enum(['send','saveDraft','archive','read','unread','trash','restore','undo']),scope:z.literal('message'),messageId:id.nullable(),draftId:uuidSchema.nullable(),draftRevision:z.number().int().nullable(),draft:localMailDraftSchema.nullable(),hash,createdAt:z.string().datetime(),expiresAt:z.string().datetime(),status:z.enum(['pending','dispatching','succeeded','failed','unknown','denied','expired']),detail:z.string().max(500),previousLabels:z.array(z.string().max(100)).max(200),expectedLabels:z.array(z.string().max(100)).max(200),resultId:id.nullable(),undoOf:uuidSchema.nullable()}).strict();
export type MailAction=z.infer<typeof mailActionSchema>;
export const mailReviewSchema=z.object({action:mailActionSchema,nonce:uuidSchema}).strict();
export type MailReview=z.infer<typeof mailReviewSchema>;
export const mailResultSchema=z.object({drafts:z.array(localMailDraftSchema).max(200),actions:z.array(mailActionSchema).max(500),thread:mailThreadSchema.nullable(),review:mailReviewSchema.nullable()}).strict();
export type MailResult=z.infer<typeof mailResultSchema>;
export const discardLocalDraftSchema=z.object({action:z.literal('discardLocal'),accountId:accountIdSchema,id:uuidSchema,expectedRevision:z.number().int().nonnegative()}).strict();
// The UI explains the same restrictions that storage checks authoritatively.
export function draftDiscardBlock(draft:LocalMailDraft,actions:readonly MailAction[]):string|null{
 if(draft.status==='sent')return 'This message was sent. Local discard cannot recall it.';
 if(['sending','unknown'].includes(draft.status))return 'A Gmail save or send is in progress or has an unresolved outcome. Inspect Recent mail activity and use Check outcome before discarding.';
 const related=actions.filter(a=>a.accountId===draft.accountId&&a.draftId===draft.id&&['send','saveDraft'].includes(a.kind));
 if(related.some(a=>['dispatching','unknown'].includes(a.status)||a.kind==='saveDraft'&&a.status==='pending'))return 'A Gmail save or send is in progress or has an unresolved outcome. Inspect Recent mail activity and use Check outcome before discarding.';
 const saved=related.find(a=>a.kind==='saveDraft'&&a.status==='succeeded');
 if(related.some(a=>a.kind==='send'&&a.status==='succeeded')||saved?.resultId&&saved.resultId!==draft.remoteDraftId)return 'A completed Gmail action needs local recovery. Restart MoMo and inspect Recent mail activity before discarding.';
 return null;
}
export const mailCommandSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('list'),accountId:accountIdSchema}).strict(),
 z.object({action:z.literal('thread'),accountId:accountIdSchema,id}).strict(),
 z.object({action:z.literal('compose'),id:uuidSchema,accountId:accountIdSchema,mode:z.enum(['compose','reply','replyAll','forward']),sourceMessageId:id.optional(),grounding:z.object({runId:uuidSchema,threadId:id,threadRevision:hash,workflow:z.literal('inbox-planner-v1').optional()}).strict().optional(),body:z.string().max(60000).optional()}).strict(),
 z.object({action:z.literal('saveLocal'),accountId:accountIdSchema,id:uuidSchema,expectedRevision:z.number().int().nonnegative(),fields:mailFieldsSchema}).strict(),
 discardLocalDraftSchema,
 z.object({action:z.enum(['saveRemote','prepareSend']),accountId:accountIdSchema,id:uuidSchema,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({action:z.literal('approveSend'),accountId:accountIdSchema,id:uuidSchema,hash,nonce:uuidSchema}).strict(),
 z.object({action:z.enum(['deny','reconcile','undo']),accountId:accountIdSchema,id:uuidSchema}).strict(),
 z.object({action:z.literal('modify'),accountId:accountIdSchema,id,scope:z.literal('message'),kind:z.enum(['archive','read','unread','trash','restore'])}).strict(),
]);
export type MailCommand=z.infer<typeof mailCommandSchema>;
