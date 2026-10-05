// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { expect,it } from 'vitest';
import { orderActivity,nativeActivityStatus } from '../src/desktop/ActivityPanel';
it('merges source types by actual normalized timestamp with deterministic type-prefixed identity',()=>{
 const records=[{id:'mail:same',at:'2026-09-23T08:00:00Z'},{id:'workflow:same',at:'2026-09-25T08:00:00Z'},{id:'calendar:same',at:'2026-09-25T10:00:00+02:00'},{id:'conversation:same',at:'2026-09-24T08:00:00Z'}];
 expect(orderActivity(records).map(r=>r.id)).toEqual(['calendar:same','workflow:same','conversation:same','mail:same']);
});
it('distinguishes pending, expired and uncertain native outcomes without authorizing an action',()=>{
 expect(nativeActivityStatus('pending','2999-01-01T00:00:00Z')).toEqual({label:'Awaiting approval',group:'review'});
 expect(nativeActivityStatus('pending','2000-01-01T00:00:00Z')).toEqual({label:'Review expired',group:'history'});
 expect(nativeActivityStatus('unknown','2000-01-01T00:00:00Z')).toEqual({label:'Outcome uncertain',group:'review'});
});
