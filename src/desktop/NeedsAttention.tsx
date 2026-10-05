import type { ReactNode } from 'react';
import { ArrowRight, Inbox } from 'lucide-react';

// Original decorative geometry. No shape, mark or layer encodes account data.
function CorrespondenceObject() {
  return <svg className="correspondence-object" viewBox="0 0 320 300" aria-hidden="true" focusable="false">
    <path className="object-ground" d="M44 260H278M60 267H263"/>
    <g className="letter-back">
      <path className="object-paper" d="M88 52H239L250 63V237H88Z"/>
      <path className="object-line" d="M239 52V64H250M98 71H214"/>
    </g>
    <g className="letter-lift">
      <path className="object-paper" d="M69 75H224L238 89V242H69Z"/>
      <path className="object-line" d="M224 75V89H238M86 99H203M86 106H170"/>
      <path className="object-tab" d="M178 62H213V123L195.5 113L178 123Z"/>
      <path className="object-line" d="M186 73H205M186 80H199"/>
    </g>
    <g className="envelope-front">
      <path className="object-side" d="M51 148L64 137H257L270 148V249L257 260H64L51 249Z"/>
      <path className="object-face" d="M51 148H270V249H51Z"/>
      <path className="object-line" d="M51 148L147 211Q160 220 173 211L270 148M51 249L126 196M270 249L195 196"/>
      <path className="object-line faint" d="M64 252H257M59 158V238M263 158V238"/>
      <path className="object-seal" d="M148 207L160 201L172 207V220L160 226L148 220Z"/>
      <path className="object-line seal-mark" d="M155 211H165M155 216H165"/>
    </g>
    <path className="object-registration" d="M38 70V53H55M263 53H280V70M38 245V262H55M263 262H280V245"/>
  </svg>;
}

export function NeedsAttention({children,footer,expanded,available,openCoverage,compact=false}:{
  children:ReactNode; footer:ReactNode;
  expanded:boolean; available:boolean; openCoverage():void; compact?:boolean;
}) {
  return <section className={'needs-attention'+(compact?' attention-quiet':'')} aria-labelledby="attention-title">
    <header className="attention-heading"><h2 id="attention-title"><Inbox size={19}/>Needs attention</h2><span className="attention-material" aria-hidden="true">MoMo</span></header>
    <div className="attention-composition">
      <div className="attention-copy">
        <div className="attention-content">{children}</div>
        <button className="attention-action" aria-expanded={expanded} aria-controls={expanded?'dashboard-details':undefined} onClick={openCoverage} disabled={!available}>Review attention <ArrowRight size={17}/></button>
      </div>
      <div className="attention-art"><CorrespondenceObject/></div>
    </div>
    <footer className="attention-footer">{footer}</footer>
  </section>;
}
