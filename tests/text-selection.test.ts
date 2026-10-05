// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {installTextSelection} from '../src/desktop/textSelection';
let off:()=>void;
beforeEach(()=>{document.body.innerHTML='<p id="reading">Existing interface label</p><p hidden>Hidden content</p><button class="message-row"><span>Selectable row text</span></button><textarea></textarea><input type="password"/>';off=installTextSelection();});
afterEach(()=>{off();document.getSelection()?.removeAllRanges();document.body.innerHTML='';});
const pointer=(target:Element,x:number)=>target.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:x,clientY:5,button:0}));
it('selects only the active reading block and leaves editors and existing handled shortcuts alone',()=>{
 const p=document.querySelector('p')!;pointer(p,5);const key=new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true});document.body.dispatchEvent(key);expect(key.defaultPrevented).toBe(true);expect(document.getSelection()?.toString()).toBe('Existing interface label');
 for(const target of [document.querySelector('textarea')!,document.querySelector('input')!]){const editKey=new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true});target.dispatchEvent(editKey);expect(editKey.defaultPrevented).toBe(false);}
 const copy=new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true});p.dispatchEvent(copy);expect(copy.defaultPrevented).toBe(false);
});
it('suppresses activation after a selection drag but preserves ordinary and keyboard clicks',()=>{
 const button=document.querySelector('button')!,onClick=vi.fn();button.addEventListener('click',onClick);pointer(button,5);
 const range=document.createRange();range.selectNodeContents(button);document.getSelection()?.addRange(range);
 button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,clientX:80,clientY:5}));expect(onClick).not.toHaveBeenCalled();
 pointer(button,5);button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,clientX:5,clientY:5}));expect(onClick).toHaveBeenCalledTimes(1);
 button.click();expect(onClick).toHaveBeenCalledTimes(2);
});
