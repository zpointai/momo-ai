import { AppError } from '../errors';
/** Explicit process-only review authority; never saved as a spending mode or schedule preference. */
export function inferenceAllowed(){return !process.argv.includes('--no-paid-inference');}
export function assertInferenceAllowed(){if(!inferenceAllowed())throw new AppError('permission_denied','AI inference is disabled for this review session (--no-paid-inference).');}
/** Explicit temporary acceptance limits; never persisted as owner spending policy. */
let dispatched=0;
export class SessionRequestLimit extends AppError {constructor(){super('permission_denied','Review-session provider request limit reached.');}}
export function sessionRequestLimit(){const flag=process.argv.find(v=>v.startsWith('--provider-request-limit='));if(!flag)return Infinity;const value=Number(flag.split('=')[1]);if(!Number.isInteger(value)||value<0||value>64)throw new AppError('permission_denied','Invalid review-session request bound.');return value;}
export function assertSessionRequestAvailable(){assertInferenceAllowed();if(dispatched>=sessionRequestLimit())throw new SessionRequestLimit();}
export function claimProviderRequest(){assertSessionRequestAvailable();dispatched++;}
export function sessionAccountingPurpose(){return process.argv.includes('--development-usage')?'development' as const:'ordinary' as const;}
