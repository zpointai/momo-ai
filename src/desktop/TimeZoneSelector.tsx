import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown} from 'lucide-react';
import {findTimeZones,supportedTimeZones,validTimeZone,zoneLabel,zonePreview} from '../shared/timezones';

export function TimeZoneSelector({value,saved,change,invalid,disabled,commitLabel='Apply'}:{value:string;saved:string;change:(zone:string)=>void;invalid:boolean;disabled:boolean;commitLabel?:string}) {
  const id=useId(),input=useRef<HTMLInputElement>(null),host=useRef<HTMLDivElement>(null),popup=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[filtering,setFiltering]=useState(false),[active,setActive]=useState(0),[now,setNow]=useState(()=>new Date());
  const [position,setPosition]=useState({left:0,top:0,width:360,maxHeight:300});
  const zones=useMemo(()=>supportedTimeZones(saved),[saved]);
  const options=useMemo(()=>findTimeZones(zones,filtering?value:''),[zones,filtering,value]);
  const preview=zonePreview(value,now);
  function show(){setNow(new Date());setFiltering(false);setActive(Math.max(0,zones.indexOf(value)));setOpen(true);}
  function select(zone:string){change(zone);setOpen(false);input.current?.focus();}
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const r=host.current!.getBoundingClientRect();if(!r.width){setOpen(false);return;}const below=window.innerHeight-r.bottom-12,above=r.top-12,down=below>=Math.min(322,above),height=Math.max(0,Math.min(322,down?below:above)),width=Math.min(Math.max(r.width,320),window.innerWidth-24);setPosition({left:Math.max(12,Math.min(r.left,window.innerWidth-width-12)),top:down?r.bottom+6:Math.max(12,r.top-height-6),width,maxHeight:height});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  useEffect(()=>{if(open)popup.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:'nearest'});},[open,active,options]);
  useEffect(()=>{if(!open)return;const outside=(event:Event)=>{const target=event.target as Node;if(!host.current?.contains(target)&&!popup.current?.contains(target))setOpen(false);};document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);};},[open]);
  return <div className="timezone-selector">
    <label htmlFor={id}>Time zone</label>
    <div className="timezone-input" ref={host}>
      <input id={id} ref={input} role="combobox" aria-label="Time zone" aria-autocomplete="list" aria-expanded={open} aria-controls={open?id+'-list':undefined} aria-activedescendant={open&&options[active]?id+'-option-'+active:undefined} aria-describedby={id+'-help '+id+'-preview'} aria-invalid={invalid||undefined} autoComplete="off" spellCheck={false} value={value} maxLength={80} required disabled={disabled}
        onChange={e=>{change(e.target.value);setFiltering(true);setActive(0);setNow(new Date());setOpen(true);}}
        onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!open){show();return;}setActive(n=>Math.max(0,Math.min(options.length-1,n+(e.key==='ArrowDown'?1:-1))));}else if(e.key==='Enter'&&open){e.preventDefault();if(options[active])select(options[active]);}else if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false);}else if(e.key==='Tab')setOpen(false);}}/>
      <button type="button" className="icon-button" aria-label={open?'Close time zones':'Browse time zones'} aria-expanded={open} disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>{if(open)setOpen(false);else show();input.current?.focus();}}><ChevronDown size={17}/></button>
    </div>
    <p id={id+'-help'} className="fine-print">Search a city, region or named zone. Choose a result, then {commitLabel}.</p>
    <p id={id+'-preview'} className="timezone-preview">{preview?<><strong>{zoneLabel(value)}</strong><span>{preview} · as of {now.toISOString().slice(11,16)} UTC</span></>:<span>Choose a supported named time zone.</span>}</p>
    <button type="button" className="text-button" disabled={disabled} onClick={()=>{const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;if(validTimeZone(zone)){change(zone);setNow(new Date());setOpen(false);}}}>Use computer’s time zone</button>
    {open&&createPortal(<div ref={popup} className="timezone-popup" style={position}>
      <div className="timezone-results" role="status">{options.length?`${options.length} supported ${options.length===1?'zone':'zones'}`:'No matching zones. Try a city or region.'}</div>
      <div role="listbox" id={id+'-list'} aria-label="Supported time zones">{options.map((zone,index)=><div key={zone} role="option" id={id+'-option-'+index} aria-selected={zone===value} data-active={active===index} onMouseDown={e=>e.preventDefault()} onClick={()=>select(zone)}><div><strong>{zoneLabel(zone)}</strong><small>{zone}</small></div>{zone===value&&<Check size={15}/>}</div>)}</div>
    </div>,document.body)}
  </div>;
}
