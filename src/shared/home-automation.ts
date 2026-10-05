import { z } from 'zod';

export const homeIdentitySchema = z.string().regex(/^(?:[A-F0-9]{2}:){7}[A-F0-9]{2}$/);
export const homeModelSchema = z.string().regex(/^[HR][A-Z0-9]{4}$/);
export const localAddressSchema = z.ipv4().refine(address => {
  const [a,b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}, 'Use a private IPv4 address.');
const stamp = z.string().datetime();
export const homeInterfaceSchema = z.object({ id:z.string().max(160), name:z.string().max(80), address:localAddressSchema, netmask:z.ipv4() }).strict();
export const homeStateSchema = z.object({ power:z.boolean().nullable(), brightness:z.number().int().min(1).max(100).nullable(), at:stamp }).strict();
export const homeDeviceSchema = z.object({
  provider:z.literal('govee-lan'), identity:homeIdentitySchema, model:homeModelSchema, endpoint:localAddressSchema,
  interfaceId:z.string().max(160), category:z.enum(['light','unknown']),
  capability:z.enum(['documented-light','unknown']), seenAt:stamp,
  availability:z.enum(['observed','unavailable','ambiguous']), state:homeStateSchema.nullable(),
}).strict();
export const homeMappingSchema = z.object({ identity:homeIdentitySchema, model:homeModelSchema, endpoint:localAddressSchema, interfaceId:z.string().max(160), alias:z.string().trim().min(1).max(60).regex(/^[^\x00-\x1f\x7f]+$/), confirmedAt:stamp }).strict();
export const homeGrantSchema = z.object({ id:z.string().uuid(), identity:homeIdentitySchema, expiresAt:stamp.nullable(), power:z.boolean(), brightness:z.boolean() }).strict();
export const homePermissionSchema = homeMappingSchema.pick({identity:true,model:true,endpoint:true,interfaceId:true}).extend({power:z.boolean(),brightness:z.boolean(),confirmedAt:stamp}).strict();
export const lightOperationSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('power'),value:z.boolean()}).strict(),
  z.object({kind:z.literal('brightness'),value:z.number().int().min(1).max(100)}).strict(),
]);
export const homeReconciliationSchema=z.object({sentAt:stamp,finishedAt:stamp.nullable(),stage:z.enum(['checking','observed-match','observed-different','state-unknown','identity-invalidated','cancelled']),reason:z.enum(['send_completed_state_pending','observed_match','observed_different','status_timeout','mapped_device_not_seen','identity_mismatch','settle_timeout','cancelled']),observations:z.array(homeStateSchema).max(2)}).strict();
export const homeReceiptSchema = z.object({ id:z.string().uuid(), identity:homeIdentitySchema, alias:z.string().max(60), at:stamp, operation:lightOperationSchema, sent:z.boolean(), before:homeStateSchema.nullable(), after:homeStateSchema.nullable(), outcome:z.enum(['attempted','sent-unconfirmed','observed-match','observed-different','cancelled','failed']), physical:z.enum(['unconfirmed','confirmed','not-observed']), note:z.string().max(400),reconciliation:homeReconciliationSchema.optional() }).strict();
export const hueDiagnosticSchema = z.object({ checkedAt:stamp, network:z.enum(['reachable','unreachable']), tls:z.enum(['trusted','unverified','not-checked']), identity:z.literal('unverified'), pairing:z.literal('not-paired'), resourceAccess:z.literal('not-authorized'), note:z.string().max(400) }).strict();
export const homeConfigSchema = z.object({ interfaceId:z.string().max(160).nullable(), hueAddress:localAddressSchema.nullable() }).strict();
export const homeStoredSchema = z.object({ version:z.literal(1), config:homeConfigSchema, devices:z.array(homeDeviceSchema).max(128), mapping:homeMappingSchema.nullable(), permission:homePermissionSchema.nullable().optional(), receipts:z.array(homeReceiptSchema).max(40) }).strict();
export const homeSnapshotSchema = homeStoredSchema.extend({ interfaces:z.array(homeInterfaceSchema).max(32), grant:homeGrantSchema.nullable(), hue:hueDiagnosticSchema.nullable(), busy:z.boolean(), diagnostic:z.string().max(400), checkedAt:stamp });
export const homeCommandSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('snapshot')}).strict(),
  z.object({action:z.literal('configure'),config:homeConfigSchema}).strict(),
  z.object({action:z.literal('discover')}).strict(),
  z.object({action:z.literal('cancel')}).strict(),
  z.object({action:z.literal('select'),identity:homeIdentitySchema.nullable()}).strict(),
  z.object({action:z.literal('map'),identity:homeIdentitySchema,alias:homeMappingSchema.shape.alias}).strict(),
  z.object({action:z.literal('grant'),identity:homeIdentitySchema,remember:z.boolean().optional()}).strict(),
  z.object({action:z.literal('revoke')}).strict(),
  z.object({action:z.literal('control'),identity:homeIdentitySchema,grantId:z.string().uuid(),operation:lightOperationSchema}).strict(),
  z.object({action:z.literal('physical-result'),receiptId:z.string().uuid(),confirmed:z.boolean()}).strict(),
  z.object({action:z.literal('hue-check')}).strict(),
]);
export type HomeCommand=z.infer<typeof homeCommandSchema>;
export type HomeSnapshot=z.infer<typeof homeSnapshotSchema>;
export type HomeStored=z.infer<typeof homeStoredSchema>;
export type HomeDevice=z.infer<typeof homeDeviceSchema>;
export type HomeInterface=z.infer<typeof homeInterfaceSchema>;
export type HomeState=z.infer<typeof homeStateSchema>;
export type HomeReceipt=z.infer<typeof homeReceiptSchema>;
export type LightOperation=z.infer<typeof lightOperationSchema>;
export type HueDiagnostic=z.infer<typeof hueDiagnosticSchema>;
export const emptyHome=():HomeStored=>({version:1,config:{interfaceId:null,hueAddress:null},devices:[],mapping:null,receipts:[]});
export function homeFresh(device:HomeDevice,now=Date.now()) {return device.availability==='observed'&&now-Date.parse(device.seenAt)<30_000;}
