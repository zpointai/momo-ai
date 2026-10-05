const editable='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const textRegion='p,pre,blockquote,td,dd,dt,h1,h2,h3,h4,.mail-text,.user-message,.assistant-answer,.field-error,[role="alert"],.message-row,.planner-event-chip,.planner-agenda-row,.resource-row,.suggested-task,.thread-select,.agenda-entry,.attention-row,.planner-timed-event';
function element(node:Node|null){return node instanceof Element?node:node?.parentElement??null;}

// Only an actual text-selection gesture suppresses activation; a normal click,
// keyboard activation, scrollbar or pane-divider gesture keeps its native behavior.
export function installTextSelection(root:Document=document) {
  let start:{x:number;y:number;button:Element|null}|null=null;
  let region:Element|null=null;
  const down=(e:PointerEvent)=>{if(e.button!==0)return;const target=element(e.target as Node);region=target?.closest(textRegion)??null;start={x:e.clientX,y:e.clientY,button:target?.closest('button,a,summary')??null};};
  const click=(e:MouseEvent)=>{const gesture=start;start=null;if(!gesture?.button||e.detail===0)return;const selection=root.getSelection();if(Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>4&&!selection?.isCollapsed&&gesture.button.contains(selection?.anchorNode??null)){e.preventDefault();e.stopImmediatePropagation();}};
  const cancel=()=>{start=null;};
  const key=(e:KeyboardEvent)=>{
    if(e.defaultPrevented||!(e.ctrlKey||e.metaKey)||e.altKey||e.shiftKey||e.key.toLowerCase()!=='a')return;
    const target=element(e.target as Node);if(target?.closest(editable))return;
    const selection=root.getSelection(),anchor=element(selection?.anchorNode??null);
    const selected=selection&&!selection.isCollapsed?anchor?.closest(textRegion):null;
    const scope=selected??(target?.closest(textRegion))??(target===root.body?region:null);
    e.preventDefault(); // Never select the whole app or hidden workspace panels.
    if(!scope?.isConnected||scope.closest('[hidden],[inert]'))return;
    const range=root.createRange();range.selectNodeContents(scope);selection?.removeAllRanges();selection?.addRange(range);
  };
  root.addEventListener('pointerdown',down);root.addEventListener('pointercancel',cancel);root.addEventListener('click',click,true);root.addEventListener('keydown',key);
  return()=>{root.removeEventListener('pointerdown',down);root.removeEventListener('pointercancel',cancel);root.removeEventListener('click',click,true);root.removeEventListener('keydown',key);};
}
