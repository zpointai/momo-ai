// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import {expect,it,vi} from 'vitest';
vi.mock('electron',()=>({Menu:{}}));
import {contextEditItems} from '../electron/edit-menu';
const editFlags={canUndo:true,canRedo:true,canCut:true,canCopy:true,canPaste:true,canDelete:true,canSelectAll:true,canEditRichly:false};
it('uses native focused roles with no clipboard bridge or arbitrary text copy',()=>{
 expect(contextEditItems({isEditable:false,editFlags})).toEqual([{role:'copy',enabled:true}]);
 const roles=contextEditItems({isEditable:true,editFlags}).map(x=>x.role).filter(Boolean);
 expect(roles).toEqual(['undo','redo','cut','copy','paste','selectAll']);
});
it('honors Chromium restrictions for password and noncopyable contexts',()=>{
 const items=contextEditItems({isEditable:true,editFlags:{...editFlags,canCopy:false,canCut:false}});
 expect(items.find(i=>i.role==='copy')?.enabled).toBe(false);expect(items.find(i=>i.role==='cut')?.enabled).toBe(false);
 expect(contextEditItems({isEditable:false,editFlags:{...editFlags,canCopy:false}})[0].enabled).toBe(false);
});
