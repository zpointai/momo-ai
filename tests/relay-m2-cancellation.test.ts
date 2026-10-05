// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect, it } from 'vitest';
import { schedulingFixture } from './helpers/scheduling-fixture';
// Carried M2 assertion, synchronized on the reply model boundary instead of a timing sleep.
it('M2 reply cancellation rejects the late model result before local mail preparation', async () => {
  const f = schedulingFixture(); f.provider(undefined);
  let entered!: () => void, release!: () => void;
  const atReply = new Promise<void>(r => { entered = r; }), barrier = new Promise<void>(r => { release = r; });
  const original = f.coordinate.getMockImplementation()!;
  f.coordinate.mockImplementation(async (options, kind) => { const result = await original(options, kind); if (kind === 'reply') { entered(); await barrier; } return result; });
  try {
    const root = await f.service.start(f.event()); await atReply;
    await f.service.command({ action: 'cancel', id: root.id }); release(); await f.service.idle();
    const run = f.get(root.id); expect(run.status).toBe('cancelled'); expect(run.scheduling?.phase).toBe('cancelled'); expect(run.localDraftId).toBeUndefined(); expect((await f.mail.command({ action: 'list', accountId: 'fixtureAccount' })).drafts).toEqual([]); expect(f.google.writeMail).not.toHaveBeenCalled();
  } finally { release(); await f.close(); }
});
