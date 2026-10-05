import { useEffect,useRef,useState } from 'react';
import type { Settings } from '../shared/contracts';
export type SettingsSave=(patch:Partial<Settings>,expectedRevision?:number)=>Promise<boolean>;

/** A local edit buffer, never another settings store. Saved state stays native. */
export function useSettingsDraft<T>(saved:T,revision:number){
 const saving=useRef(false);const key=JSON.stringify(saved),latest=useRef({saved,revision});latest.current={saved,revision};
 const [value,setValue]=useState(saved),[base,setBase]=useState({key,revision}),[status,setStatus]=useState('');
 const dirty=JSON.stringify(value)!==base.key,conflict=dirty&&(revision!==base.revision||key!==base.key);
 useEffect(()=>{if(!dirty){setValue(saved);setBase({key,revision});}},[key,revision]);
 const edit=(next:T)=>{setValue(next);setStatus('');};
 const cancel=()=>{setValue(latest.current.saved);setBase({key:JSON.stringify(latest.current.saved),revision:latest.current.revision});setStatus('Edits cancelled. Saved values restored.');};
 async function apply(commit:(value:T,revision:number)=>Promise<boolean>){
  if(saving.current)return false;
  if(conflict){setStatus('Saved values changed. Cancel these edits to load the latest values before applying.');return false;}
  saving.current=true;setStatus('Saving…');let ok=false;try{ok=await commit(value,base.revision);}catch{ok=false;}finally{saving.current=false;}
  if(ok){setBase({key:JSON.stringify(value),revision:latest.current.revision});setStatus('Saved.');}else setStatus('Not saved. Your edits are retained; check the error and current revision.');
  return ok;
 }
 return{value,edit,dirty,conflict,cancel,apply,status,revision:base.revision};
}
export function EditActions({draft,busy,label='Apply changes'}:{draft:{dirty:boolean;conflict:boolean;cancel():void;status:string};busy:boolean;label?:string}){
 return <footer className="settings-edit-actions"><div><button type="submit" className="primary small" disabled={busy||!draft.dirty||draft.conflict}>{busy?'Saving…':label}</button><button type="button" className="secondary small" disabled={busy} onClick={draft.cancel}>Cancel edits</button></div><p role="status">{draft.conflict?'Saved values changed while you were editing. Cancel edits to load the latest revision.':draft.status|| (draft.dirty?'Unsaved edits · retained while you navigate':'Saved values')}</p></footer>;
}
