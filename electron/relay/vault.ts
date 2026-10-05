import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Protection } from '../credentials/store';
import { AppError } from '../errors';
const restSchema=z.object({apiKeySid:z.string().regex(/^SK[a-fA-F0-9]{32}$/),secret:z.string().regex(/^[\x21-\x7e]{16,256}$/)}).strict();
const vaultSchema=z.object({rest:restSchema.nullable(),device:z.object({id:z.string().uuid(),publicKey:z.string(),privateKey:z.string()}).strict().nullable()}).strict();
type Vault=z.infer<typeof vaultSchema>;
/** Dedicated native vault. Never part of provider snapshots or renderer IPC. */
export class RelayVault {
 private queue:Promise<unknown>=Promise.resolve();
 private exclusive<T>(operation:()=>Promise<T>){const next=this.queue.then(operation);this.queue=next.catch(()=>{});return next;}
 constructor(private directory:string,private protection:Protection){}
 private async load():Promise<Vault>{if(!this.protection.isEncryptionAvailable())throw new AppError('unavailable','Windows credential protection is unavailable.');try{return vaultSchema.parse(JSON.parse(this.protection.decryptString(await readFile(path.join(this.directory,'relay.bin')))));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {rest:null,device:null};throw new AppError('unavailable','Protected Relay credentials could not be opened.');}}
 private async save(value:Vault){await mkdir(this.directory,{recursive:true});const file=path.join(this.directory,'relay.bin'),temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,this.protection.encryptString(JSON.stringify(vaultSchema.parse(value))),{flag:'wx',mode:0o600});await rename(temporary,file);}
 async rest(){await this.queue;return (await this.load()).rest;}
 async status():Promise<'missing'|'configured'|'error'>{try{return await this.rest()?'configured':'missing';}catch{return 'error';}}
 async saveRest(raw:unknown){const parsed=restSchema.safeParse(raw);if(!parsed.success)throw new AppError('invalid_input','Enter a dedicated API Key SID and API Key Secret. Account Auth Tokens are not accepted.');return this.exclusive(async()=>{const v=await this.load();v.rest=parsed.data;await this.save(v);});}
 async device(){return this.exclusive(async()=>{const v=await this.load();if(!v.device){const pair=generateKeyPairSync('ed25519');v.device={id:randomUUID(),publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()};await this.save(v);}return v.device;});}
}
