import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { providerSchema, type Provider, type Snapshot } from '../../src/shared/contracts';
import { AppError } from '../errors';
export interface Protection { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
type CredentialProvider = Provider | 'tomtom' | 'flightaware' | 'logodev';
type CredentialStatus = Snapshot['credentials'][Provider];
export class CredentialStore {
  private known:Partial<Record<CredentialProvider,CredentialStatus>>={};
  /** Metadata from the last normal credential check; never opens or decrypts a secret. */
  peekStatus(provider:CredentialProvider){return this.known[provider];}
  constructor(private directory: string, private protection: Protection) {}
  available() { return this.protection.isEncryptionAvailable(); }
  async read(provider: CredentialProvider): Promise<string> {
    if (!this.available()) throw new AppError('unavailable', 'Windows credential protection is unavailable.');
    try { return this.protection.decryptString(await readFile(this.file(provider))); }
    catch { throw new AppError('unavailable', 'Import a working ' + provider + ' key in Settings.'); }
  }
  private file(provider: CredentialProvider) { return path.join(this.directory, (provider === 'tomtom' || provider === 'flightaware' || provider === 'logodev' ? provider : providerSchema.parse(provider)) + '.bin'); }
  /** Opaque revision of encrypted bytes, never a hash of the plaintext key. */
  async revision(provider:CredentialProvider):Promise<string|null>{try{return createHash('sha256').update(await readFile(this.file(provider))).digest('hex');}catch{return null;}}
  async status(provider: CredentialProvider): Promise<CredentialStatus> {
    let result:CredentialStatus;
    try { const bytes = await readFile(this.file(provider)); if (!this.available()) result='error'; else{this.protection.decryptString(bytes);result='configured';} }
    catch (error) { result=(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error'; }
    this.known[provider]=result;return result;
  }
  async save(provider: CredentialProvider, secret: string) {
    if (!this.available()) throw new AppError('unavailable', 'Windows credential protection is unavailable. No key was saved.');
    if (!/^[\x21-\x7e]{8,2048}$/.test(secret)) throw new AppError('invalid_input', 'The file must contain one API key with no spaces, up to 2,048 characters.');
    const destination = this.file(provider);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try { await mkdir(this.directory, { recursive: true }); await writeFile(temporary, this.protection.encryptString(secret), { flag: 'wx', mode: 0o600 }); await rename(temporary, destination);this.known[provider]='configured'; }
    catch { throw new AppError('unavailable', 'The protected key could not be saved. Any previous key was preserved.'); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  /** Import via the same protected writer; never retain a plaintext application copy. */
  async importFile(provider:CredentialProvider,filename:string){
    const handle=await open(filename,'r'),bytes=Buffer.alloc(4097);
    try{
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>4096)throw new AppError('invalid_input','Choose a text file of at most 4 KB containing one API key.');
      const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
      if(bytesRead>4096)throw new AppError('invalid_input','The key file is too large.');
      await this.save(provider,bytes.subarray(0,bytesRead).toString('utf8').trim());
    }finally{bytes.fill(0);await handle.close();}
  }
  async remove(provider: CredentialProvider) { try { await unlink(this.file(provider)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('unavailable', 'The protected key could not be removed.'); }this.known[provider]='missing'; }
}
