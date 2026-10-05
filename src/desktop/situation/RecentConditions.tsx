import { ArrowRight, Globe2, TriangleAlert } from 'lucide-react';
import type { NearbyCondition, SituationSnapshot } from '../../shared/situation';
export const conditionAge = (at: string, now: number) => { const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000)); return minutes ? minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago` : 'Just now'; };
export function RecentConditions({ snapshot, now, open, all }: { snapshot: SituationSnapshot; now: number; open(condition: NearbyCondition): void; all(): void }) {
  const conditions = snapshot.conditions.filter(condition => Date.parse(condition.expiresAt) > now);
  return <section className={'situation-card situation-conditions' + (!conditions.length ? ' is-empty' : '')}><header><h2><TriangleAlert size={21}/>Recent Conditions</h2>{!!conditions.length && <button className="text-button" onClick={all}>View all<ArrowRight size={14}/></button>}</header>
    {conditions.length ? <ol>{conditions.slice(0, 2).map(condition => <li key={condition.id}><TriangleAlert size={18}/><div><button className="text-button situation-condition-link" onClick={() => open(condition)}>{condition.title}</button><p>{condition.detail}</p><small>{conditionAge(condition.observedAt, now)} · {condition.source === 'flights' ? 'FlightAware' : condition.source === 'traffic' ? 'TomTom' : 'Open-Meteo'}</small></div></li>)}</ol> : <div className="situation-quiet-state"><span className="situation-quiet-mark"><Globe2 size={24}/></span><h3>No observations yet</h3><p>No meaningful changes since your connected sources were last checked.</p><small>The first check sets a baseline. Refresh a source later to compare.</small></div>}
  </section>;
}
