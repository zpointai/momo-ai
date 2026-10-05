import { ZodError } from 'zod';
import { AppError } from '../errors';
import type { VoiceFailureCategory } from '../../src/shared/voice';
import { SessionRequestLimit } from './session-authority';
export class VoiceFailure extends AppError {
 constructor(public readonly category:VoiceFailureCategory,message:string){super('unavailable',message);}
}
export function voiceFailureCategory(error:unknown,phase:'provider'|'schema'|'native'|'unknown'='unknown'):VoiceFailureCategory {
 if(error instanceof VoiceFailure)return error.category;
 if(error instanceof SessionRequestLimit)return 'session-limit';
 if(error instanceof ZodError||error instanceof SyntaxError||phase==='schema')return 'output-schema';
 if(error instanceof AppError){
  if(error.code==='cancelled')return 'cancelled';
  if(error.code==='permission_denied')return 'permission-source-denied';
  if(error.code==='conflict'||/stale|expired/i.test(error.message))return 'source-stale';
  if(error.code==='unavailable'&&phase==='native')return 'source-unavailable';
 }
 return phase==='provider'?'provider-model':phase==='native'?'native-tool':'unknown';
}
