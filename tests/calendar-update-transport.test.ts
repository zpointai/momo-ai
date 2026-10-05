// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect, it } from 'vitest';
import { GoogleService } from '../electron/google/service';
import { GoogleHttp, allowedGoogleRequest } from '../electron/google/http';
import { googleScopes } from '../electron/google/oauth';
import { calendarWriteScope } from '../src/shared/calendar-actions';
import type { VaultData } from '../electron/google/vault';

it('uses one conditional PATCH to the exact primary event with only the approved time fields',async()=>{
 const calls:{url:string;method:string;headers:Headers;body:unknown}[]=[];
 const vault:VaultData={version:1,client:{client_id:'fixture.apps.googleusercontent.com'},activeAccountId:'fixture',accounts:[{id:'fixture',email:'fixture@example.test',status:'connected',token:{access:'ISOLATED',refresh:'ISOLATED',expiresAt:Date.now()+3600000,scopes:[...googleScopes,calendarWriteScope]}}]};
 const google=new GoogleService({read:async()=>vault,write:async()=>{}},new GoogleHttp(async(url,init)=>{calls.push({url,method:init?.method??'GET',headers:new Headers(init?.headers),body:JSON.parse(String(init?.body??'{}'))});return Response.json({id:'original_event',etag:'"new"'});}),async()=>{},()=>{});
 const patch={start:{dateTime:'2026-10-07T08:00:00.000Z',timeZone:'Europe/Amsterdam'},end:{dateTime:'2026-10-07T08:30:00.000Z',timeZone:'Europe/Amsterdam'}};
 await google.updateApprovedEvent('fixture','original_event','"old"',patch,google.calendarEpoch(),()=>true);
 expect(calls).toHaveLength(1);expect(calls[0].method).toBe('PATCH');expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/original_event?sendUpdates=none');expect(calls[0].headers.get('If-Match')).toBe('"old"');expect(calls[0].body).toEqual(patch);
 await expect(google.updateApprovedEvent('fixture','original_event','"old"',patch,google.calendarEpoch(),()=>false)).rejects.toThrow('before dispatch');expect(calls).toHaveLength(1);
 expect(allowedGoogleRequest('https://www.googleapis.com/calendar/v3/calendars/other/events/original_event?sendUpdates=none','PATCH')).toBe(false);
 expect(allowedGoogleRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events/original_event?sendUpdates=all','PATCH')).toBe(false);
 expect(allowedGoogleRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events/original_event','DELETE')).toBe(false);
});
