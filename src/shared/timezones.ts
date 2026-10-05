// Runtime ICU is the authority for names and aliases, as it is in the native schema.
export function validTimeZone(zone:string):boolean {
  if(!zone || zone.length>80)return false;
  try { new Intl.DateTimeFormat('en',{timeZone:zone});return true; } catch { return false; }
}
export function supportedTimeZones(saved:string):string[] {
  const zones=Intl.supportedValuesOf('timeZone');
  return [...new Set(['UTC',...zones,...(validTimeZone(saved)?[saved]:[])])].sort();
}
export function zoneLabel(zone:string):string {
  if(zone==='UTC')return 'Coordinated Universal Time';
  const parts=zone.replaceAll('_',' ').split('/');
  return parts.length>1?`${parts.at(-1)} · ${parts.slice(0,-1).join(' / ')}`:zone;
}
const normalize=(text:string)=>text.toLowerCase().replaceAll('_',' ').replaceAll('/',' ').replace(/\s+/g,' ').trim();
export function findTimeZones(zones:string[],query:string):string[] {
  const terms=normalize(query).split(' ').filter(Boolean);
  return zones.filter(zone=>{
    // ICU 78 enumerates Calcutta; the modern city spelling should still be discoverable.
    const names=normalize(zone+' '+zoneLabel(zone)+(zone==='Asia/Calcutta'?' Kolkata':'')+(zone==='Asia/Kolkata'?' Calcutta':''));
    return terms.every(term=>names.includes(term));
  });
}
export function zonePreview(zone:string,now:Date):string|null {
  if(!validTimeZone(zone))return null;
  return new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZoneName:'longOffset'}).format(now);
}
