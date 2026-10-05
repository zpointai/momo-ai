import { addDays, dateInZone, timezoneSchema, type CalendarEvent } from '../../src/shared/google';
import { inboxSchedulingSchema, schedulingIntent, schedulingInterpretationSchema, schedulingScopeSchema, type InboxScheduling, type SchedulingInterpretation } from '../../src/shared/scheduling';
import type { AgentIntake } from '../../src/shared/orchestration';
import { AppError } from '../errors';

const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export const currentSchedulingText = (text:string) => text.split(/\n(?:On .{1,180}wrote:|From:|_{3,}|-{3,}\s*Original Message)/i)[0].replace(/^>.*$/gm,'');
const clock = (date:string,zone:string) => new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(date));
function reference(text:string): NonNullable<InboxScheduling['reference']> {
  const eventId=text.match(/\bevent\s+ID\s*:\s*([A-Za-z0-9_-]{1,1024})/i)?.[1];
  const title=text.match(/["“]([^"”\n]{3,240})["”]/)?.[1];
  const original=text.match(/\b(?:currently|originally|scheduled for|meeting on|meeting from)\s+(\d{4}-\d{2}-\d{2})(?:\s+(?:at\s+)?(\d\d:\d\d))?/i);
  return {...(eventId?{eventId}:{}),...(title?{title}:{}),...(original?{date:original[1],...(original[2]?{time:original[2]}:{})}:{})};
}

/** Resolve quoted source constraints under a documented calendar policy. Models never supply dates or availability. */
export function understandScheduling(event:AgentIntake,text:string,sourceId:string,timezone:string,anchor:number,now:number,candidate?:SchedulingInterpretation,existing?:CalendarEvent):InboxScheduling {
  const current=currentSchedulingText(text), request=event.scheduling!;
  if(candidate){
    candidate=schedulingInterpretationSchema.parse(candidate);
    for(const span of [candidate.dateText,candidate.timeText,candidate.durationText,candidate.timezoneText,candidate.meetingText])
      if(span&&!current.includes(span))throw new AppError('permission_denied','The scheduling interpretation quoted text outside the current source.');
  }
  let intent=request.confirmed?.intent??schedulingIntent(current);
  // A model can recognize a paraphrase, but native scheduling vocabulary is still required.
  if(candidate&&!request.confirmed&&intent==='uncertain'&&/\b(?:meet|meeting|call|appointment|availability)\b/i.test(current)&&!/\b(?:cancel|don't|do not|no need)\b/i.test(current))intent=candidate.intent;
  if(intent==='not-scheduling'&&/\b(?:move|same time)\b.*\b(?:week|meeting)\b/i.test(current))intent='reschedule';
  const ref=request.confirmed?.reference??reference(current), uncertainty:string[]=[], policy:string[]=[];
  if(candidate){
    const dates=(current.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[]).filter(d=>d!==ref.date);
    if(dates.some(d=>candidate!.dateText&&!candidate!.dateText.includes(d)))uncertainty.push('The interpreted date span omitted another date. Confirm the requested range.');
  }
  let anchorDate=dateInZone(new Date(anchor),timezone);
  if(request.confirmed)return inboxSchedulingSchema.parse({schema:'inbox-scheduling-v1',intent,sourceId,quote:current.slice(0,500),scope:schedulingScopeSchema.parse({...request.confirmed.scope,...(ref.date?{referenceDate:ref.date}:{})}),basis:'owner-confirmed',uncertainty:[],reference:ref,anchorDate});
  const temporal=candidate?.dateText||current, timeText=candidate?.timeText||current;
  const zones=[...new Set(current.match(/\b(?:Europe|America|Asia|Africa|Australia|Pacific|Atlantic|Indian)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b|\bUTC\b/g)??[])];
  if(zones.length>1||/\b(?:PST|PDT|EST|EDT|CST|CDT|CET|CEST|GMT[+-]\d|your time|my time)\b/i.test(current))uncertainty.push('Confirm one IANA timezone; the source timezone reference is ambiguous.');
  const zone=zones[0]??timezone;
  if(timezoneSchema.safeParse(zone).success)anchorDate=dateInZone(new Date(anchor),zone);
  if(!timezoneSchema.safeParse(zone).success)uncertainty.push('Confirm a valid timezone.');
  if(!zones.length)policy.push(`Times use your configured timezone, ${timezone}.`);
  const durationValues=[...new Set([...current.matchAll(/\b(\d{1,3})[ -](?:minutes?|mins?)\b/gi)].map(m=>Number(m[1])))];
  let duration=durationValues.length===1?durationValues[0]:0;
  if(!duration&&/\b(?:half an hour|half-hour)\b/i.test(current))duration=30;
  if(!duration&&/\b(?:an hour|one hour|1 hour)\b/i.test(current))duration=60;
  if(!duration&&existing?.time.kind==='timed'&&intent==='reschedule'){
    duration=(Date.parse(existing.time.end)-Date.parse(existing.time.start))/60000;
    policy.push('Rescheduling preserves the duration of the exactly identified native event.');
  }
  if(!duration)uncertainty.push('Confirm the meeting duration. No default duration is assumed.');
  const shift=/\b(?:by (?:one|1) week|same time next week)\b/i.test(current);
  let date='',endDate:string|undefined,weekdays:number[]|undefined,from='',to='';
  if(shift){
    if(existing?.time.kind==='timed'){
      date=addDays(dateInZone(new Date(existing.time.start),zone),7);from=clock(existing.time.start,zone);const endMinutes=Number(from.slice(0,2))*60+Number(from.slice(3))+duration;to=String(Math.floor(endMinutes/60)).padStart(2,'0')+':'+String(endMinutes%60).padStart(2,'0');
      if(to<=from)uncertainty.push('Confirm a search window for this overnight meeting.');
      policy.push('One week means seven local calendar days, preserving the existing wall time.');
    }else uncertainty.push('Identify the original meeting by event ID or exact title, original date and time.');
  }else{
    const dates=[...new Set(temporal.match(/\b\d{4}-\d{2}-\d{2}\b/g)??[])].filter(d=>d!==ref.date||! /\b(?:to|instead|new time)\b/i.test(temporal));
    if(dates.length===1)date=dates[0];
    else if(dates.length===2&&/\b(?:through|until|between|from)\b/i.test(temporal)){[date,endDate]=dates;}
    else if(dates.length>1)uncertainty.push('Confirm which date or explicit range is intended.');
    const dow=new Date(anchorDate+'T12:00:00Z').getUTCDay();
    const nextMonday=addDays(anchorDate,((8-dow)%7)||7);
    const mentioned=days.map((day,i)=>new RegExp('\\b'+day+'\\b','i').test(temporal)?i:-1).filter(d=>d>=0);
    const excluded=days.map((day,i)=>new RegExp('\\bexcept\\s+'+day+'\\b','i').test(current)?i:-1).filter(d=>d>=0);
    if(!date&&/\bnext week\b/i.test(temporal)){date=nextMonday;endDate=addDays(date,4);weekdays=mentioned.some(d=>!excluded.includes(d))?mentioned.filter(d=>!excluded.includes(d)):[1,2,3,4,5];policy.push('Next week is Monday–Friday of the following calendar week, based on the source date.');}
    else if(!date&&/\btomorrow\b/i.test(temporal))date=addDays(anchorDate,1);
    else if(!date&&/\btoday\b/i.test(temporal))date=anchorDate;
    else if(!date&&mentioned.filter(d=>!excluded.includes(d)).length){
      const requested=mentioned.filter(d=>!excluded.includes(d));
      const resolved=requested.map(d=>addDays(anchorDate,((d-dow+7)%7)||7)).sort();date=resolved[0];endDate=resolved.length>1?resolved.at(-1):undefined;weekdays=requested;
      policy.push('Named weekdays mean their next occurrence after the source date.');
    }else if(!date&&/\bany morning\b/i.test(temporal)){date=addDays(anchorDate,1);endDate=addDays(date,6);weekdays=[1,2,3,4,5];policy.push('Any morning searches the next seven calendar days, on weekdays.');}
    if(weekdays)weekdays=weekdays.filter(d=>!excluded.includes(d));
    if(!date)uncertainty.push('Confirm the requested date or bounded date range.');
    const ranges=[...timeText.matchAll(/\b([012]\d:[0-5]\d)\s*(?:–|-|to)\s*([012]\d:[0-5]\d)\b/g)];
    if(ranges.length===1){from=ranges[0][1];to=ranges[0][2];}
    else {
      from='09:00';to='17:00';
      if(/\bmorning\b/i.test(timeText))to='12:00';
      if(/\bafternoon\b/i.test(timeText))from='13:00';
      if(/\bafter lunch\b/i.test(timeText))uncertainty.push('What time does “after lunch” mean for this request?');
      const before=timeText.match(/\b(?:before|no later than)\s+(\d\d:\d\d)/i),after=timeText.match(/\b(?:after|not before|no earlier than)\s+(\d\d:\d\d)/i);
      if(before)to=before[1];if(after)from=after[1];
      const at=timeText.match(/\bat\s+(\d\d:\d\d)/i);
      if(at&&!before&&!after&&at[1]!==ref.time){from=at[1];const total=Number(from.slice(0,2))*60+Number(from.slice(3))+duration;to=String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');}
      if(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b|\bat (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(timeText))uncertainty.push('Confirm the requested clock time using 24-hour notation.');
      if(!before&&!after&&!at&&(timeText.match(/\b\d\d:\d\d\b/g)??[]).some(t=>t!==ref.time))uncertainty.push('Confirm how the stated clock time constrains this request.');
      policy.push('Search hours default to 09:00–17:00; morning is 09:00–12:00 and afternoon 13:00–17:00.');
    }
  }
  if(/\b(?:not after|not on|unless|except (?!Wednesday\b|Monday\b|Tuesday\b|Thursday\b|Friday\b|Saturday\b|Sunday\b)|only if)\b/i.test(current))uncertainty.push('Confirm the additional restriction before proposing times.');
  if(candidate?.ambiguity.length)uncertainty.push(...candidate.ambiguity);
  if(['uncertain','not-scheduling'].includes(intent))uncertainty.push('Confirm whether this message requests a meeting, rescheduling or availability.');
  const parsed=schedulingScopeSchema.safeParse({date,...(endDate?{endDate}:{}),...(weekdays?{weekdays}:{}),...(ref.date?{referenceDate:ref.date}:{}),from,to,timezone:zone,durationMinutes:duration});
  if(!parsed.success&&!uncertainty.length)uncertainty.push('Confirm a valid search window of at most fourteen days and a duration of 5–240 minutes.');
  if(parsed.success&&Date.parse(parsed.data.date)>now+90*86400000)uncertainty.push('Choose a date within the next ninety days.');
  return inboxSchedulingSchema.parse({schema:'inbox-scheduling-v1',intent,sourceId,quote:current.slice(0,500),scope:parsed.success&&!uncertainty.length?parsed.data:null,basis:'source',uncertainty:[...new Set(uncertainty)].slice(0,5),reference:ref,policy:policy.slice(0,5),anchorDate,...(candidate?{candidate}:{})});
}

export function identifyMeeting(events:CalendarEvent[],inbox:InboxScheduling,timezone:string){
  const ref=inbox.reference;
  if(!ref||!ref.eventId&&!(ref.title&&ref.date&&ref.time))return {event:null,ambiguous:false};
  const matches=events.filter(e=>ref.eventId?e.id===ref.eventId:e.time.kind==='timed'&&e.title.toLocaleLowerCase()===ref.title!.toLocaleLowerCase()&&dateInZone(new Date(e.time.start),timezone)===ref.date&&clock(e.time.start,timezone)===ref.time);
  return {event:matches.length===1?matches[0]:null,ambiguous:matches.length>1};
}
