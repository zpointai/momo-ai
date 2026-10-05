import {useEffect,useRef,useState,type RefObject} from 'react';
import type {MoState} from './MoIdentity';

const parts=['body','head','left-arm','right-arm','left-eye','right-eye','mouth','happy-left','happy-right','happy-mouth'] as const;
type Part=typeof parts[number];
const editing=()=>document.activeElement instanceof HTMLElement&&!!document.activeElement.closest('input,textarea,[contenteditable=true]');

/** Local visual behavior only. Never dispatches a request or changes agent state. */
export function useMoRig(element:RefObject<HTMLSpanElement|null>,state:MoState){
 const [reaction,setReaction]=useState<'wave'|'curious'|null>(null);
 const react=useRef<()=>void>(()=>{});
 useEffect(()=>{
  const node=element.current;if(!node)return;
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let visible=false,frame=0,blinkTimer=0,releaseTimer=0,lastPointer=0,lastTyped=-Infinity,near=false,sequence=0;
  let currentX=0,currentY=0,targetX=0,targetY=0;
  const active=()=>visible&&document.visibilityState==='visible';
  const typing=()=>editing()&&performance.now()-lastTyped<1800;
  const write=()=>{node.style.setProperty('--mo-look-x',currentX.toFixed(3));node.style.setProperty('--mo-look-y',currentY.toFixed(3));};
  const step=()=>{
   frame=0;if(!active()||reduced?.matches)return;
   currentX+=(targetX-currentX)*.16;currentY+=(targetY-currentY)*.16;write();
   if(Math.abs(currentX-targetX)+Math.abs(currentY-targetY)>.008)frame=requestAnimationFrame(step);
  };
  const settle=()=>{targetX=0;targetY=0;if(!frame&&active()&&!reduced?.matches)frame=requestAnimationFrame(step);};
  const blink=()=>{
   window.clearTimeout(blinkTimer);
   if(!active()||reduced?.matches)return;
   blinkTimer=window.setTimeout(()=>{
    if(!typing()&&!document.getSelection()?.toString()&&near&&performance.now()-lastPointer<7000){
     for(const eye of node.querySelectorAll<HTMLElement>('.mo-eye'))eye.animate([{scale:'1 1'},{scale:'1 .08',offset:.46},{scale:'1 1'}],{duration:180,easing:'ease-in-out'});
    }else settle();
    blink();
   },4200+Math.random()*2200);
  };
  const reset=()=>{
   cancelAnimationFrame(frame);frame=0;window.clearTimeout(blinkTimer);window.clearTimeout(releaseTimer);
   node.querySelectorAll('.mo-rig *').forEach(e=>e.getAnimations?.().forEach(a=>a.cancel()));
   currentX=0;currentY=0;targetX=0;targetY=0;write();setReaction(null);
  };
  const visibility=()=>{node.dataset.motion=active()&&!reduced?.matches?'active':'paused';if(active()&&!reduced?.matches)blink();else reset();};
  const observer=typeof IntersectionObserver==='undefined'?undefined:new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;visibility();});observer?.observe(node);
  const pointer=(event:PointerEvent)=>{
   if(!active()||reduced?.matches||typing()||document.getSelection()?.toString())return;
   const box=node.getBoundingClientRect(),dx=event.clientX-(box.left+box.width/2),dy=event.clientY-(box.top+box.height*.38);
   near=Math.hypot(dx,dy)<460;
   if(!near){settle();return;}
   lastPointer=performance.now();targetX=Math.max(-1,Math.min(1,dx/180));targetY=Math.max(-1,Math.min(1,dy/180));
   if(!frame)frame=requestAnimationFrame(step);
  };
  const quiet=()=>{if(editing())settle();};
  const typed=()=>{if(editing()){lastTyped=performance.now();settle();}};
  const leave=()=>{near=false;settle();};
  const stateReaction=()=>{if(active()&&!reduced?.matches&&state==='completed')node.querySelector('.mo-head')?.animate([{rotate:'0deg'},{rotate:'-4deg',offset:.35},{rotate:'2deg',offset:.65},{rotate:'0deg'}],{duration:650,easing:'ease-out'});};
  react.current=()=>{
   if(!active())return;
   window.clearTimeout(releaseTimer);sequence++;
   const curious=sequence%3===0;
   setReaction(curious?'curious':'wave');
   if(!reduced?.matches){
    for(const part of node.querySelectorAll('.mo-arm,.mo-head'))part.getAnimations().forEach(a=>a.cancel());
    if(curious)node.querySelector('.mo-eye-right')?.animate([{scale:'1 1'},{scale:'1 .12',offset:.45},{scale:'1 1'}],{duration:300});
    else{
     node.querySelector('.mo-arm-left')?.animate([{rotate:'0deg'},{rotate:'48deg',offset:.24},{rotate:'34deg',offset:.43},{rotate:'53deg',offset:.62},{rotate:'38deg',offset:.77},{rotate:'0deg'}],{duration:1350,easing:'ease-in-out'});
     node.querySelector('.mo-arm-right')?.animate([{rotate:'0deg'},{rotate:'-9deg',offset:.4},{rotate:'0deg'}],{duration:1100,easing:'ease-out'});
     node.querySelector('.mo-head')?.animate([{rotate:'0deg'},{rotate:'-5deg',offset:.3},{rotate:'3deg',offset:.65},{rotate:'0deg'}],{duration:1000,easing:'ease-in-out'});
    }
   }
   releaseTimer=window.setTimeout(()=>setReaction(null),sequence%3===0?1100:1450);
  };
  document.addEventListener('pointermove',pointer,{passive:true});document.addEventListener('focusin',quiet);document.addEventListener('input',typed);document.documentElement.addEventListener('pointerleave',leave);
  document.addEventListener('visibilitychange',visibility);reduced?.addEventListener('change',visibility);
  const stateTimer=window.setTimeout(stateReaction,80);
  return()=>{observer?.disconnect();document.removeEventListener('pointermove',pointer);document.removeEventListener('focusin',quiet);document.removeEventListener('input',typed);document.documentElement.removeEventListener('pointerleave',leave);document.removeEventListener('visibilitychange',visibility);reduced?.removeEventListener('change',visibility);window.clearTimeout(stateTimer);reset();react.current=()=>{};};
 },[element,state]);
 return {reaction,react:()=>react.current()};
}

export function MoRig({welcome}:{welcome:boolean}){
 const [loaded,setLoaded]=useState<Set<Part>>(()=>new Set());
 const ready=loaded.size===parts.length;
 const layer=(part:Part,className='')=><img className={'mo-rig-layer '+className} src={`/brand/mo/mo-rig-${part}.png`} alt="" draggable={false} onLoad={()=>setLoaded(old=>new Set(old).add(part))}/>;
 return <span className="mo-rig" data-ready={ready} aria-hidden="true">
  <img className="mo-rig-fallback" src={welcome?'/brand/mo/mo-welcome.png':'/brand/mo/mo-portrait.png'} alt="" draggable={false}/>
  <span className="mo-rig-puppet">
   {layer('body','mo-body')}
   <span className="mo-head">{layer('head')}<span className="mo-face">
    <span className="mo-eye mo-eye-left">{layer('left-eye','mo-expression-neutral')}{layer('happy-left','mo-expression-happy')}</span>
    <span className="mo-eye mo-eye-right">{layer('right-eye','mo-expression-neutral')}{layer('happy-right','mo-expression-happy')}</span>
    <span className="mo-mouth">{layer('mouth','mo-expression-neutral')}{layer('happy-mouth','mo-expression-happy')}</span>
   </span></span>
   <span className="mo-arm mo-arm-left">{layer('left-arm')}</span><span className="mo-arm mo-arm-right">{layer('right-arm')}</span>
  </span>
 </span>;
}
