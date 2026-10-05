import {useRef} from 'react';
import {MoRig,useMoRig} from './MoRig';

export type MoState='idle'|'connected'|'processing'|'waiting'|'completed'|'unavailable';
const labels:Record<MoState,string>={idle:'Ready',connected:'Connected',processing:'Processing your request',waiting:'Waiting for you',completed:'Complete',unavailable:'Unavailable'};
export function MoPortrait({state='idle',welcome=false,onActivate,label='Talk to Mo'}:{state?:MoState;welcome?:boolean;onActivate?:()=>void;label?:string}){
  const element=useRef<HTMLSpanElement>(null);
  const {reaction,react}=useMoRig(element,state);
  const artwork=<><MoRig welcome={welcome}/><span className="mo-state-dot" title={labels[state]}/></>;
  return <span ref={element} className={welcome?'mo-character mo-welcome':'mo-character mo-portrait'} data-state={state} data-reaction={reaction??'none'}>{onActivate?<button type="button" className="mo-character-button" aria-label={label} title={label} onClick={()=>{react();onActivate();}}>{artwork}</button>:artwork}</span>;
}
export const moStateLabel=(state:MoState)=>labels[state];
