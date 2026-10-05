import { z } from 'zod';
import type { LocalMailDraft,MailThread } from '../../src/shared/mail';
import { normalizeMail,plainText } from '../google/normalize';
import { mailThreadMessageSchema } from '../../src/shared/mail';
import { AppError } from '../errors';
const rejectControls=(value:string)=>{if(/[\r\n\u0000-\u001f\u007f]/.test(value))throw new AppError('invalid_input','Mail headers cannot contain control characters.');return value;};
export function addresses(value:string):string[]{
 rejectControls(value);if(!value.trim())return[];
 const tokens:string[]=[];let part='',quoted=false;let escaped=false;
 for(const char of value){if(char==='"'&&!escaped)quoted=!quoted;if(char===','&&!quoted){tokens.push(part);part='';}else part+=char;escaped=char==='\\'&&!escaped;}
 if(quoted)throw new AppError('invalid_input','Close the quoted recipient name.');tokens.push(part);
 if(tokens.length>50)throw new AppError('invalid_input','At most 50 recipients per field.');
 return [...new Set(tokens.map(token=>{const value=token.trim();const match=value.match(/^(?:"[^"\r\n]*"|[^<>]*)<([^<>]+)>$/);const email=match?match[1].trim():value;if(!z.email().safeParse(email).success||!/^[\x21-\x7e]+$/.test(email))throw new AppError('invalid_input','Use valid email addresses separated by commas.');return email.toLowerCase();}))];
}
export function recipients(fields:LocalMailDraft['fields'],requireRecipient=true){const to=addresses(fields.to);const cc=addresses(fields.cc).filter(v=>!to.includes(v));const bcc=addresses(fields.bcc).filter(v=>![...to,...cc].includes(v));if(requireRecipient&&to.length+cc.length+bcc.length===0||to.length+cc.length+bcc.length>50)throw new AppError('invalid_input','Choose between one and 50 recipients.');return{to,cc,bcc};}
function encodedHeader(value:string){rejectControls(value);let chunk='';const parts:string[]=[];for(const char of value){if(Buffer.byteLength(chunk+char)>30){parts.push(chunk);chunk='';}chunk+=char;}if(chunk||!parts.length)parts.push(chunk);return parts.map(p=>'=?UTF-8?B?'+Buffer.from(p).toString('base64')+'?=').join('\r\n ');}
export function messageIdFor(draft:LocalMailDraft){return`<momo.${draft.id}.${draft.contentRevision}@momo.local>`;}
export function mimeMessage(draft:LocalMailDraft,requireRecipient=true){
 const r=recipients(draft.fields,requireRecipient);const headers=[`From: ${addresses(draft.from)[0]}`,`To: ${r.to.join(',\r\n ')}`,...(r.cc.length?[`Cc: ${r.cc.join(',\r\n ')}`]:[]),...(r.bcc.length?[`Bcc: ${r.bcc.join(',\r\n ')}`]:[]),`Subject: ${encodedHeader(draft.fields.subject)}`,`Message-ID: ${messageIdFor(draft)}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
 if(draft.inReplyTo){if(!/^<[^<>\s@]+@[^<>\s]+>$/.test(draft.inReplyTo))throw new AppError('invalid_input','The original message has no safe reply identifier.');headers.push('In-Reply-To: '+draft.inReplyTo);const refs=draft.references.match(/<[^<>\s@]+@[^<>\s]+>/g)??[];headers.push('References: '+[...new Set([...refs,draft.inReplyTo])].slice(-15).join('\r\n '));}
 const body=Buffer.from(draft.fields.body.replace(/\r?\n/g,'\r\n'),'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
 return Buffer.from(headers.join('\r\n')+'\r\n\r\n'+body+'\r\n').toString('base64url');
}
export function normalizeThreadMessage(raw:unknown){
 const input=z.object({labelIds:z.array(z.string()).max(200).default([]),payload:z.object({headers:z.array(z.object({name:z.string(),value:z.string()})).default([])}).passthrough()}).parse(raw);
 const header=(name:string,max:number)=>(input.payload.headers.find(h=>h.name.toLowerCase()===name)?.value??'').replace(/[\r\n]+[ \t]*/g,' ').slice(0,max);
 const attachments:{filename:string;size:number}[]=[];let nodes=0;
 const walk=(raw:unknown,depth:number)=>{if(++nodes>500||depth>20||attachments.length>=100)return;const p=z.object({filename:z.string().optional(),body:z.object({size:z.number().int().nonnegative().optional()}).optional(),parts:z.array(z.unknown()).optional()}).safeParse(raw);if(!p.success)return;if(p.data.filename)attachments.push({filename:p.data.filename.slice(0,240),size:p.data.body?.size??0});for(const child of p.data.parts??[])walk(child,depth+1);};walk(input.payload,0);
 return mailThreadMessageSchema.parse({message:normalizeMail(raw),...plainText(raw),headers:{replyTo:header('reply-to',2000),cc:header('cc',2000),messageId:header('message-id',300),references:header('references',2000)},labels:input.labelIds,attachments});
}
export function replyFields(message:MailThread['messages'][number],mode:'reply'|'replyAll'|'forward',own:string[]){
 const mail=message.message;const owners=own.map(v=>v.toLowerCase());const target=addresses(message.headers.replyTo||mail.from).filter(v=>!owners.includes(v));const to=mode==='forward'?[]:target.length?target:addresses(mail.to).filter(v=>!owners.includes(v));const cc=mode==='replyAll'?addresses(mail.to+ (mail.to&&message.headers.cc?', ':'') + message.headers.cc).filter(v=>!owners.includes(v)&&!to.includes(v)):[];
 const subject=mode==='forward'?(/^fwd?:/i.test(mail.subject)?mail.subject:'Fwd: '+mail.subject):(/^re:/i.test(mail.subject)?mail.subject:'Re: '+mail.subject);
 return{to:to.join(', '),cc:[...new Set(cc)].join(', '),bcc:'',subject,body:mode==='forward'?`\n\nForwarded message\nFrom: ${mail.from}\nDate: ${mail.receivedAt}\nSubject: ${mail.subject}\n\n${message.textAvailable?message.text:'[Plain-text body unavailable]'}${message.attachments.length?'\n[Attachments are not included]':''}`.slice(0,60000):''};
}
