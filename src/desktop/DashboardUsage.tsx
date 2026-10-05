import { ArrowRight,ChevronDown,Wallet } from 'lucide-react';
import { costRange,formatCost,type CostPeriod,type Costs } from '../shared/usage';

function periodStatus(period?:CostPeriod) {
  if(!period)return 'Pricing unavailable';
  if(!period.attempts)return 'No requests recorded';
  const gaps=[period.unknown?`${period.unknown} unpriced`:null,period.provisional?`${period.provisional} provisional`:null].filter(Boolean);
  return [period.priced?(gaps.length?'Known estimate':'Estimated cost'):null,...gaps].filter(Boolean).join(' · ');
}

function PeriodEstimate({label,period,primary=false}:{label:string;period?:CostPeriod;primary?:boolean}) {
  return <div className={'usage-period'+(primary?' usage-month':'')}>
    <dt>{label}</dt>
    <dd className={'usage-amount'+(!period||(!period.priced&&period.attempts)?' usage-unpriced':'')}>{period?costRange(period):'Unavailable'}</dd>
    <dd className="usage-period-status">{periodStatus(period)}</dd>
  </div>;
}

// Decorative measuring columns, not a chart of the owner's usage or remaining allowance.
function UsageMeter() {
  return <svg className="usage-resource-meter" viewBox="0 0 132 60" aria-hidden="true" focusable="false">
    <path className="meter-ground" d="M22 57H111M32 59H101"/>
    <path className="meter-base-top" d="M17 47L31 39H113L99 47Z"/>
    <path className="meter-base-front" d="M17 47H99V53H17Z"/>
    <path className="meter-base-side" d="M99 47L113 39V45L99 53Z"/>
    <g className="meter-column">
      <path className="meter-column-side" d="M45 29L53 24V40L45 45Z"/>
      <path className="meter-column-front" d="M30 29H45V45H30Z"/>
      <path className="meter-column-top" d="M30 29L38 24H53L45 29Z"/>
      <path className="meter-ticks" d="M33 35H39M33 40H37"/>
    </g>
    <g className="meter-column">
      <path className="meter-column-side" d="M71 12L79 7V40L71 45Z"/>
      <path className="meter-column-front" d="M56 12H71V45H56Z"/>
      <path className="meter-column-top" d="M56 12L64 7H79L71 12Z"/>
      <path className="meter-ticks" d="M59 19H65M59 25H63M59 31H65M59 37H63"/>
    </g>
    <g className="meter-column meter-column-amber">
      <path className="meter-column-side" d="M97 23L105 18V40L97 45Z"/>
      <path className="meter-column-front" d="M82 23H97V45H82Z"/>
      <path className="meter-column-top" d="M82 23L90 18H105L97 23Z"/>
      <path className="meter-ticks" d="M85 29H91M85 35H89M85 40H91"/>
    </g>
    <path className="meter-base-rule" d="M23 50H91"/>
  </svg>;
}

export function DashboardUsage({costs,openSettings}:{costs?:Costs;openSettings():void}) {
  return <section className="work-pane dashboard-usage-card" aria-labelledby="dashboard-usage-title">
    <header className="pane-heading"><h2 id="dashboard-usage-title"><Wallet/>MoMo usage</h2><UsageMeter/></header>
    <dl className="usage-periods" aria-label="Estimated usage costs">
      <PeriodEstimate label="This month" period={costs?.monthToDate} primary/>
      <PeriodEstimate label="Today" period={costs?.today}/>
    </dl>
    {(costs?.stopped||costs?.warning)&&<p className="usage-control-status">{costs.stopped?'Spending control active. Review Usage & limits.':'Monthly warning target reached.'}</p>}
    <footer className="pane-footer"><span className="usage-currency">Estimated USD · UTC</span><button className="text-button" onClick={openSettings}>Usage & limits <ArrowRight size={15}/></button></footer>
    <details className="usage-explanation"><summary>About these estimates <ChevronDown size={14}/></summary><div>
      <p>MoMo’s recorded AI model requests only. Phone, hosting and other service charges, provider invoices, other apps and subscriptions are separate.</p>
      {costs?<><p>Calendar month from <time dateTime={costs.month+'-01'}>{costs.month}-01</time>; today is <time dateTime={costs.day}>{costs.day}</time>. Both use UTC.</p>
        {costs.monthToDate.unknown&&!costs.monthToDate.priced&&!costs.monthToDate.provisional?<p>Monthly exposure cannot be priced yet.</p>:<p>Recorded monthly exposure: {formatCost(costs.monthToDate.exposure)}{costs.monthToDate.unknown?' plus unpriced charges':''}. This includes known estimates and provisional reservations, which are bounds rather than settled charges.</p>}
        {costs.monthToDate.provisional>0&&<p>{costs.monthToDate.provisional} requests have no final token usage. Their reserved bound is {formatCost(costs.monthToDate.exposure-costs.monthToDate.high,4)}, separate from the known estimate above.</p>}
        <p>Unpriced requests are not free. Incomplete totals cannot establish that spending is under budget. Price uncertainty appears as a range; amounts below one dollar use four decimal places.</p></>:<p>The usage service has not supplied totals. Open Usage & limits to inspect or refresh the local records.</p>}
    </div></details>
  </section>;
}
