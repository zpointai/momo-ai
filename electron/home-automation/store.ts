import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyHome, homeStoredSchema, type HomeStored } from '../../src/shared/home-automation';
import { AppError } from '../errors';
export interface HomeStore { load():Promise<HomeStored>; save(state:HomeStored):Promise<void> }
export class FileHomeStore implements HomeStore {
  constructor(private file:string){}
  async load() {
    try {const bytes=await readFile(this.file);if(bytes.length>256_000)throw new Error('bounds');return homeStoredSchema.parse(JSON.parse(bytes.toString('utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return emptyHome();throw new AppError('unavailable','Home Automation data could not be read. The original file was preserved.');}
  }
  async save(state:HomeStored) {await mkdir(path.dirname(this.file),{recursive:true});await writeFile(this.file+'.tmp',JSON.stringify(homeStoredSchema.parse(state)),{mode:0o600});await rename(this.file+'.tmp',this.file);}
}
