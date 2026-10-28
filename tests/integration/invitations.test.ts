import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBudget } from '../../src/server/budgets';
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  declineInvitation,
  previewInvitation,
} from '../../src/server/invitations';
import {
  adminDb,
  clearFirestore,
  countDocs,
  TestClock,
  testDeps,
} from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
const alice = {
  uid: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
};
const bob = {
  uid: 'bob',
  email: 'bob@example.test',
  emailVerified: true,
  displayName: 'Bob',
};
const carol = {
  uid: 'carol',
  email: 'carol@example.test',
  displayName: 'Carol',
};

async function setup(clock = new TestClock()) {
  const deps = testDeps(clock);
  const { budget_id } = await createBudget(deps, alice, { name: 'Home' });
  return { clock, deps, budget_id };
}

async function activeMembershipCount(budgetId: string): Promise<number> {
  return countDocs(adminDb(), `budgets/${budgetId}/active_members`);
}

describe('creating invitations (I-FR-03)', () => {
  beforeEach(clearFirestore);

  it('lets the admin create a link that stores only the token hash', async () => {
    const { deps, budget_id } = await setup();
    const result = await createInvitation(deps, alice, { budget_id });

    expect(result.link).toBe(`income-tracker://invite?token=${result.token}`);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const hash = createHash('sha256').update(result.token).digest('hex');
    const db = adminDb();
    const invitation = (
      await db.doc(`invitations/${result.invitation_id}`).get()
    ).data();
    expect(invitation).toMatchObject({
      budget_id,
      status: 'PENDING',
      token_hash: hash,
      invitee_email: null,
    });
    expect(hash).toHaveLength(64);
    expect(
      (await db.doc(`invitation_tokens/${hash}`).get()).get('invitation_id'),
    ).toBe(result.invitation_id);

    // The plain token appears nowhere in the stored data.
    const everything = [
      ...(await db.collection('invitations').get()).docs,
      ...(await db.collection('invitation_tokens').get()).docs,
    ].map((snapshot) => JSON.stringify([snapshot.id, snapshot.data()]));
    expect(everything.join('\n')).not.toContain(result.token);
  });

  it('expires seven days after creation', async () => {
    const { deps, budget_id, clock } = await setup();
    const result = await createInvitation(deps, alice, { budget_id });
    expect(result.expires_at).toBe(
      new Date(clock.now().getTime() + 7 * DAY_MS).toISOString(),
    );
  });

  it('generates a different unpredictable token each time', async () => {
    const { deps, budget_id } = await setup();
    const first = await createInvitation(deps, alice, { budget_id });
    const second = await createInvitation(deps, alice, { budget_id });
    expect(first.token).not.toBe(second.token);
    expect(await countDocs(adminDb(), 'invitation_tokens')).toBe(2);
  });

  it('rejects invitation creation by non-admins and outsiders', async () => {
    const { deps, budget_id } = await setup();
    const { token } = await createInvitation(deps, alice, { budget_id });
    await acceptInvitation(deps, bob, token);

    await expect(
      createInvitation(deps, bob, { budget_id }),
    ).rejects.toMatchObject({ code: 'NOT_ADMIN' });
    await expect(
      createInvitation(deps, carol, { budget_id }),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });
    expect(await countDocs(adminDb(), 'invitations')).toBe(1);
  });

  it('is safe to retry with the same invitation id', async () => {
    const { deps, budget_id } = await setup();
    const invitation_id = '3f2b8c1e-7a4d-4c55-9e0a-1b2c3d4e5f60';
    await createInvitation(deps, alice, { budget_id, invitation_id });
    await expect(
      createInvitation(deps, alice, { budget_id, invitation_id }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await countDocs(adminDb(), 'invitations')).toBe(1);
  });
});

describe('accepting and declining invitations (I-FR-04)', () => {
  beforeEach(clearFirestore);

  it('accepting creates an active member membership and consumes the link', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
    });

    const joined = await acceptInvitation(deps, bob, token);
    expect(joined.budget_id).toBe(budget_id);

    const db = adminDb();
    expect(
      (await db.doc(`memberships/${joined.membership_id}`).get()).data(),
    ).toMatchObject({
      budget_id,
      user_id: 'bob',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    expect(
      (await db.doc(`budgets/${budget_id}/active_members/bob`).get()).data(),
    ).toMatchObject({ membership_id: joined.membership_id, role: 'MEMBER' });
    expect(
      (await db.doc(`invitations/${invitation_id}`).get()).get('status'),
    ).toBe('ACCEPTED');
  });

  it('cannot be used again after acceptance, by anyone', async () => {
    const { deps, budget_id } = await setup();
    const { token } = await createInvitation(deps, alice, { budget_id });
    await acceptInvitation(deps, bob, token);

    for (const user of [bob, carol]) {
      await expect(acceptInvitation(deps, user, token)).rejects.toMatchObject({
        code: 'INVITATION_NOT_PENDING',
      });
    }
    await expect(declineInvitation(deps, carol, token)).rejects.toMatchObject({
      code: 'INVITATION_NOT_PENDING',
    });
    expect(await activeMembershipCount(budget_id)).toBe(2);
  });

  it('declining consumes the link and creates no membership', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
    });
    await declineInvitation(deps, bob, token);

    expect(
      (await adminDb().doc(`invitations/${invitation_id}`).get()).get('status'),
    ).toBe('DECLINED');
    await expect(acceptInvitation(deps, bob, token)).rejects.toMatchObject({
      code: 'INVITATION_NOT_PENDING',
    });
    expect(await countDocs(adminDb(), 'memberships')).toBe(1);
  });

  it('cancelling by the admin blocks later use', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
    });
    await cancelInvitation(deps, alice, invitation_id);

    await expect(acceptInvitation(deps, bob, token)).rejects.toMatchObject({
      code: 'INVITATION_NOT_PENDING',
    });
    await expect(declineInvitation(deps, bob, token)).rejects.toMatchObject({
      code: 'INVITATION_NOT_PENDING',
    });
    await expect(
      cancelInvitation(deps, alice, invitation_id),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_PENDING' });
    expect(await activeMembershipCount(budget_id)).toBe(1);
  });

  it('only an admin of the budget can cancel', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
    });
    await expect(
      cancelInvitation(deps, bob, invitation_id),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });

    const second = await createInvitation(deps, alice, { budget_id });
    await acceptInvitation(deps, bob, second.token);
    await expect(
      cancelInvitation(deps, bob, invitation_id),
    ).rejects.toMatchObject({ code: 'NOT_ADMIN' });

    // Still usable after the rejected attempts.
    await acceptInvitation(deps, carol, token);
  });

  it('is valid just before 7 days and expired from exactly 7 days', async () => {
    const { deps, budget_id, clock } = await setup();
    const early = await createInvitation(deps, alice, { budget_id });
    const late = await createInvitation(deps, alice, { budget_id });

    clock.advanceMs(7 * DAY_MS - 1);
    await acceptInvitation(deps, bob, early.token);

    clock.advanceMs(1);
    await expect(
      acceptInvitation(deps, carol, late.token),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    expect(
      (await adminDb().doc(`invitations/${late.invitation_id}`).get()).get(
        'status',
      ),
    ).toBe('EXPIRED');
    await expect(
      declineInvitation(deps, carol, late.token),
    ).rejects.toMatchObject({ code: 'INVITATION_EXPIRED' });
    expect(await activeMembershipCount(budget_id)).toBe(2);
  });

  it('does not consume the link when the user is already a member', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
    });
    await expect(acceptInvitation(deps, alice, token)).rejects.toMatchObject({
      code: 'ALREADY_MEMBER',
    });
    expect(
      (await adminDb().doc(`invitations/${invitation_id}`).get()).get('status'),
    ).toBe('PENDING');
    await acceptInvitation(deps, bob, token);
  });

  it('enforces the verified e-mail of address-restricted invitations', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
      invitee_email: 'Bob@Example.test',
    });

    await expect(acceptInvitation(deps, carol, token)).rejects.toMatchObject({
      code: 'INVITATION_EMAIL_MISMATCH',
    });
    await expect(
      acceptInvitation(deps, { ...bob, emailVerified: false }, token),
    ).rejects.toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });
    expect(
      (await adminDb().doc(`invitations/${invitation_id}`).get()).get('status'),
    ).toBe('PENDING');
    expect(
      (await adminDb().doc(`invitations/${invitation_id}`).get()).get(
        'invitee_email',
      ),
    ).toBe('bob@example.test');
    await acceptInvitation(deps, bob, token);
  });

  it('rejects malformed, unknown and unauthenticated use', async () => {
    const { deps } = await setup();
    await expect(acceptInvitation(deps, bob, 'short')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      acceptInvitation(deps, bob, 'A'.repeat(43)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      acceptInvitation(deps, null, 'A'.repeat(43)),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('previews only what an invited person needs', async () => {
    const { deps, budget_id, clock } = await setup();
    const { token } = await createInvitation(deps, alice, { budget_id });

    const preview = await previewInvitation(deps, bob, token);
    expect(preview).toMatchObject({
      budget_id,
      budget_name: 'Home',
      status: 'PENDING',
      restricted_to_email: false,
    });

    clock.advanceMs(7 * DAY_MS);
    expect(await previewInvitation(deps, bob, token)).toMatchObject({
      status: 'EXPIRED',
      budget_name: null,
    });
  });
});

describe('concurrent use of one invitation (I-FR-04, I-TR-12)', () => {
  beforeEach(clearFirestore);

  it('lets exactly one of many simultaneous acceptances win', async () => {
    const { deps, budget_id } = await setup();
    const { token } = await createInvitation(deps, alice, { budget_id });

    const users = Array.from({ length: 10 }, (_, index) => ({
      uid: `user-${index}`,
      email: `user-${index}@example.test`,
    }));
    const results = await Promise.allSettled(
      users.map((user) => acceptInvitation(deps, user, token)),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({ code: 'INVITATION_NOT_PENDING' });
    }
    expect(await activeMembershipCount(budget_id)).toBe(2);
    expect(await countDocs(adminDb(), 'memberships')).toBe(2);
  });

  it('never creates two memberships when one user retries in parallel', async () => {
    const { deps, budget_id } = await setup();
    const { token } = await createInvitation(deps, alice, { budget_id });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => acceptInvitation(deps, bob, token)),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await countDocs(adminDb(), 'memberships')).toBe(2);
  });

  it('lets accept and cancel race without a membership after cancellation', async () => {
    const { deps, budget_id } = await setup();
    const { token, invitation_id } = await createInvitation(deps, alice, {
      budget_id,
    });

    const [accepted, cancelled] = await Promise.allSettled([
      acceptInvitation(deps, bob, token),
      cancelInvitation(deps, alice, invitation_id),
    ]);
    const finalStatus = (
      await adminDb().doc(`invitations/${invitation_id}`).get()
    ).get('status');

    expect([accepted.status, cancelled.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await activeMembershipCount(budget_id)).toBe(
      finalStatus === 'ACCEPTED' ? 2 : 1,
    );
  });
});
