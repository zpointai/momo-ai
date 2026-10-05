import type { TrafficSnapshot } from '../../shared/situation';
export function TrafficCondition({ traffic }: { traffic: TrafficSnapshot }) {
  const severity = traffic.congestion;
  if (severity === 'unknown') return <p className="situation-traffic-unknown">Traffic severity unavailable</p>;
  return <div className="situation-traffic-condition" role="img" aria-label={'Route-level traffic condition: ' + severity} data-severity={severity}>
    <div className="situation-traffic-band" aria-hidden="true">{['light', 'moderate', 'heavy'].map(level => <span key={level} className={level + (level === severity ? ' current' : '')}/>)}</div>
    <div className="situation-traffic-legend" aria-hidden="true">{['Light', 'Moderate', 'Heavy'].map(level => <span key={level} className={level.toLowerCase() === severity ? 'current' : ''}>{level}</span>)}</div>
    <small>Route-level condition</small>
  </div>;
}
