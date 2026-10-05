import { z } from 'zod';

// Owner presentation choices on the existing root. These are not workflow states.
export const workControlSchema=z.object({
 revision:z.number().int().nonnegative(),snoozedUntil:z.string().datetime().nullable(),
 closedAs:z.enum(['not-relevant','resolved-elsewhere']).nullable(),
 history:z.array(z.object({at:z.string().datetime(),action:z.enum(['snooze','unsnooze','not-relevant','resolved-elsewhere','handle']),detail:z.string().max(240)}).strict()).max(100),
}).strict();
export const emptyWorkControl=()=>({revision:0,snoozedUntil:null,closedAs:null,history:[]} as z.infer<typeof workControlSchema>);
