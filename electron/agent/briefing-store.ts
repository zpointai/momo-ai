import { readFile,writeFile,rename,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { dailyIntelligenceSchema,type DailyIntelligence } from '../../src/shared/daily-intelligence';

/** A bounded, replaceable daily projection. No schema migration or authoritative history writes. */
export class BriefingStore {
 private records:DailyIntelligence[]=[];private queue:Promise<unknown>=Promise.resolve();private ready:Promise<void>;
 constructor(private filename?:string){this.ready=this.load();}
 private async load(){if(!this.filename)return;try{this.records=z.array(dailyIntelligenceSchema).max(21).parse(JSON.parse(await readFile(this.filename,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 async get(accountId:string|null){await this.ready;return structuredClone(this.records.find(r=>r.snapshot.accountId===accountId));}
 async put(value:DailyIntelligence,expectedId?:string){const task=this.queue.then(async()=>{await this.ready;const parsed=dailyIntelligenceSchema.parse(value),old=this.records.find(r=>r.snapshot.accountId===parsed.snapshot.accountId);if(expectedId&&old?.snapshot.id!==expectedId)return false;parsed.scheduleReceipt??=old?.scheduleReceipt;const next=[parsed,...this.records.filter(r=>r.snapshot.accountId!==parsed.snapshot.accountId)].slice(0,21);if(this.filename){await mkdir(path.dirname(this.filename),{recursive:true});await writeFile(this.filename+'.tmp',JSON.stringify(next));await rename(this.filename+'.tmp',this.filename);}this.records=next;return true;});this.queue=task.catch(()=>{});return task;}
}
