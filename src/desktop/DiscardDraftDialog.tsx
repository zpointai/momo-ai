import {useEffect,useRef} from 'react';
import {Trash2} from 'lucide-react';
import type {LocalMailDraft} from '../shared/mail';

export function DiscardDraftDialog({draft,busy,error,confirm,close,opener}:{draft:LocalMailDraft;busy:boolean;error:string;confirm():void;close():void;opener:HTMLElement}){
 const dialog=useRef<HTMLDialogElement>(null);const keep=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const node=dialog.current!;node.showModal();keep.current?.focus();return()=>{node.close();if(opener.isConnected&&opener.getClientRects().length)opener.focus();};},[opener]);
 const remote=!!draft.remoteDraftId;
 return <dialog ref={dialog} className="review-dialog discard-confirmation" aria-labelledby="discard-draft-title" aria-describedby="discard-draft-scope" onKeyDown={e=>e.stopPropagation()} onCancel={e=>{e.preventDefault();if(!busy)close();}}>
  <h2 id="discard-draft-title"><Trash2 size={20}/>{remote?'Discard local copy?':'Discard local draft?'}</h2>
  <div className="discard-draft-identity"><strong>{draft.fields.subject||'Untitled draft'}</strong><span>{draft.from}</span></div>
  <p id="discard-draft-scope">{remote?'Only this local copy will be discarded. The Gmail draft remains.':'This saved draft will be removed from Local drafts on this computer.'} The original message and other drafts are untouched.</p>
  <p className="fine-print">This does not recall sent mail or erase existing backups. Required mail action history is retained.</p>
  {error&&<p role="alert" className="field-error">{error}</p>}
  <footer><button ref={keep} className="secondary" disabled={busy} onClick={close}>Keep draft</button><button className="primary discard-confirm" disabled={busy} onClick={confirm}><Trash2 size={16}/>{busy?'Discarding…':remote?'Discard local copy':'Discard draft'}</button></footer>
 </dialog>;
}
