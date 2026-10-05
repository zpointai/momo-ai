// The date tile displays an actual event date. The page/ribbon drawing is decorative only.
export function CalendarInstrument({date}:{date:string}) {
  const day=new Date(date+'T12:00:00Z');
  const label=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',dateStyle:'full'}).format(day);
  return <time className="calendar-instrument" dateTime={date} aria-label={label}>
    <span className="calendar-leaf" aria-hidden="true">
      <span className="calendar-month">{new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',month:'short'}).format(day)}</span>
      <b>{day.getUTCDate()}</b>
      <span className="calendar-weekday">{new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',weekday:'short'}).format(day)}</span>
    </span>
  </time>;
}

export function BriefingPages() {
  return <svg className="briefing-pages" viewBox="0 0 170 164" aria-hidden="true" focusable="false">
    <path className="edition-ground" d="M28 144H145M40 150H130"/>
    <path className="edition-back" d="M37 35L120 22L143 39V130L60 144L37 132Z"/>
    <path className="edition-edge" d="M37 132L60 138L143 124M60 138V144"/>
    <path className="edition-paper" d="M30 28L112 16L134 34V124L51 137L30 127Z"/>
    <path className="edition-fold" d="M112 16V39L134 34M30 127L51 132L134 119"/>
    <path className="edition-rule" d="M46 58L113 48M46 66L94 59M47 105L71 101"/>
    <g className="briefing-ribbon">
      <path className="edition-ribbon" d="M80 21L98 18V85L89 78L80 89Z"/>
      <path className="edition-ribbon-mark" d="M86 31L92 30M86 37L92 36"/>
    </g>
    <path className="edition-registration" d="M19 43V25H35M137 133H153V115"/>
  </svg>;
}

// An empty organizer, with no marks or contents that could be mistaken for task data.
export function TaskOrganizer() {
  return <svg className="task-organizer-art" viewBox="0 0 132 104" aria-hidden="true" focusable="false">
    <path className="organizer-ground" d="M22 89H113M34 94H101"/>
    <path className="organizer-back" d="M17 42L48 21H113V54L81 78H17Z"/>
    <path className="organizer-floor" d="M23 57L51 36H106V58L79 77H23Z"/>
    <path className="organizer-seam" d="M51 36V25M23 57L17 42M106 58L113 54"/>
    <path className="organizer-detail" d="M32 47L49 34H56L38 47Z"/>
    <path className="organizer-side" d="M113 43L81 65V84L113 61Z"/>
    <path className="organizer-front" d="M17 55H38C39 64 56 64 57 55H81V84H17Z"/>
    <path className="organizer-rim" d="M17 55H38M57 55H81L113 33V43M21 79H77"/>
  </svg>;
}
