import { z } from 'zod';
import { voiceConfigSchema, voiceStatusSchema, gatewayVoiceStatusSchema } from './voice';
const sid=(prefix:string)=>z.string().regex(new RegExp('^'+prefix+'[a-fA-F0-9]{32}$'));
export const e164=z.string().regex(/^\+[1-9]\d{7,14}$/);
export const relayTransportConfigSchema=z.object({
 voice:voiceConfigSchema.optional(),version:z.literal(1),revision:z.number().int().nonnegative(),enabled:z.boolean(),accountSid:sid('AC'),number:e164,
 numberSid:sid('PN'),messagingServiceSid:sid('MG'),campaignSid:sid('QE'),
 gatewayOrigin:z.string().url().max(240).refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.origin===v&&!u.username&&!u.password&&!/^(localhost|127\.|\[|10\.|192\.168\.|169\.254\.)/.test(u.hostname);}catch{return false;}},'Use the public HTTPS gateway origin without a path.'),
 region:z.literal('us1'),edge:z.enum(['ashburn','dublin','frankfurt']),
}).strict();
export type RelayTransportConfig=z.infer<typeof relayTransportConfigSchema>;
export const deliveryStatusSchema=z.enum(['dispatching','provider-accepted','queued','sending','sent','delivered','undelivered','failed','unknown']);
export type DeliveryStatus=z.infer<typeof deliveryStatusSchema>;
export const smsDispatchSchema=z.object({id:z.string().uuid(),actionHash:z.string(),reservedAt:z.string().datetime(),approvalExpiresAt:z.string().datetime(),updatedAt:z.string().datetime(),status:deliveryStatusSchema,messageSid:z.string().nullable(),detail:z.string().max(240)}).strict();
export type SmsDispatch=z.infer<typeof smsDispatchSchema>;
export function deliveryProgress(previous:DeliveryStatus,next:DeliveryStatus):DeliveryStatus{
 if(['delivered','undelivered','failed'].includes(previous))return previous;
 const ranks:Record<DeliveryStatus,number>={dispatching:0,unknown:0,'provider-accepted':1,queued:2,sending:3,sent:4,delivered:5,undelivered:5,failed:5};
 return ranks[next]>=ranks[previous]?next:previous;
}
export const relayTransportStateSchema=z.object({
 synthetic:z.boolean().optional(),
 voice:voiceStatusSchema.optional(),
 config:relayTransportConfigSchema.nullable(),credentials:z.enum(['missing','configured','error']),
 gateway:z.enum(['not-configured','unavailable','healthy']),paired:z.boolean(),deviceId:z.string().nullable(),lastSync:z.string().datetime().nullable(),
 pending:z.number().int().nonnegative(),lastSeen:z.string().nullable(),inboundReady:z.boolean(),
 campaign:z.enum(['unverified','pending','approved','rejected']),checkedAt:z.string().datetime().nullable(),
 outboundReady:z.boolean(),liveAuthorization:z.boolean(),reason:z.string().max(300),
 allowedSenders:z.array(e164).max(20),payloadHours:z.number().int(),tombstoneDays:z.number().int(),
}).strict();
export type RelayTransportState=z.infer<typeof relayTransportStateSchema>;
export const gatewayStatusSchema=z.object({voice:gatewayVoiceStatusSchema.optional(),version:z.literal(1),accountSid:sid('AC'),number:e164,messagingServiceSid:sid('MG'),pairedDevice:z.string().uuid().nullable(),lastSeen:z.string().datetime().nullable(),pending:z.number().int().min(0).max(1000),payloadHours:z.number().int().min(1).max(24),tombstoneDays:z.literal(30),allowedSenders:z.array(e164).max(20),lastInbound:z.string().datetime().nullable(),lastCallback:z.string().datetime().nullable(),webhookValidation:z.literal(true),localContextChecked:z.literal(false)}).strict();
