import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBudget } from '../../src/server/budgets';
import {
  acceptInvitation,
  createInvitation,
} from '../../src/server/invitations';
import { deleteMyProfile } from '../../src/server/profileDeletion';
import { ensureUserProfile } from '../../src/server/profile';
import {
  activeRoles,
  adminDb,
  clearFirestore,
  countDocs,
  fixedId,
  seedBudgetDirect,
  testDeps,
} from './helpers';

const alice = {
  uid: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
};
const bob = { uid: 'bob', email: 'bob@example.test', displayName: 'Bob' };
const carol = {
  uid: 'carol',
  email: 'carol@example.test',
  displayName: 'Carol',
};

function deletionDeps() {
  const deleteAuthUser = vi.fn(async () => {});
  return { deps: { ...testDeps(), deleteAuthUser }, deleteAuthUser };
}

async function join(
  deps: ReturnType<typeof testDeps>,
  admin: typeof alice,
  budgetId: string,
  user: typeof alice,
) {
  const { token } = await createInvitation(deps, admin, {
    budget_id: budgetId,
  });
  return acceptInvitation(deps, user, token);
}

describe('permanent profile deletion (I-TR-09, FR-87–FR-89)', () => {
  beforeEach(clearFirestore);

  it('ends memberships, anonymizes history and keeps budgets and records', async () => {
    const base = testDeps();
    const db = adminDb();
    await ensureUserProfile(base, alice);
    await ensureUserProfile(base, bob);

    const shared = await createBudget(base, alice, { name: 'Shared' });
    const bobsMembership = await join(base, alice, shared.budget_id, bob);
    const solo = await createBudget(base, alice, { name: 'Solo' });
    const memberOnly = await createBudget(base, bob, { name: 'Bob budget' });
    const aliceInBobs = await join(base, bob, memberOnly.budget_id, alice);

    await db.doc(`budget_records/${shared.budget_id}/items/t1`).set({
      created_by_membership_id: shared.membership_id,
      hidden_mode: 'TRANSACTION',
      hidden_until: null,
      hidden_by_membership_id: shared.membership_id,
    });
    const hiddenBefore = (
      await db.doc(`budget_records/${shared.budget_id}/items/t1`).get()
    ).data();

    const { deps, deleteAuthUser } = deletionDeps();
    const result = await deleteMyProfile(deps, alice);

    expect(result).toEqual({
      deleted_budget_ids: [solo.budget_id],
      cleanup_pending_budget_ids: [],
    });

    // Admin role went to the only other member; budgets with people stay.
    expect(await activeRoles(db, shared.budget_id)).toEqual({ bob: 'ADMIN' });
    expect(await activeRoles(db, memberOnly.budget_id)).toEqual({
      bob: 'ADMIN',
    });
    // The budget of which Alice was the only member is gone with its data.
    expect((await db.doc(`budgets/${solo.budget_id}`).get()).exists).toBe(
      false,
    );

    // History stays but no longer points to the deleted user.
    for (const membershipId of [
      shared.membership_id,
      aliceInBobs.membership_id,
    ]) {
      const membership = (
        await db.doc(`memberships/${membershipId}`).get()
      ).data();
      expect(membership).toMatchObject({ user_id: null, status: 'LEFT' });
      expect(membership?.ended_at).not.toBeNull();
    }
    const aliceRows = await db
      .collection('memberships')
      .where('user_id', '==', 'alice')
      .get();
    expect(aliceRows.empty).toBe(true);
    expect(
      (await db.doc(`memberships/${bobsMembership.membership_id}`).get()).get(
        'user_id',
      ),
    ).toBe('bob');

    // Hidden/authored records are byte-for-byte unchanged.
    expect(
      (
        await db.doc(`budget_records/${shared.budget_id}/items/t1`).get()
      ).data(),
    ).toEqual(hiddenBefore);
    expect(
      (await db.doc(`budgets/${shared.budget_id}`).get()).get(
        'created_by_user_id',
      ),
    ).toBeNull();
    expect(
      (await db.doc(`budgets/${memberOnly.budget_id}`).get()).get(
        'created_by_user_id',
      ),
    ).toBe('bob');

    // Personal data is gone, the login identity is deleted exactly once.
    expect((await db.doc('users/alice').get()).exists).toBe(false);
    expect((await db.doc('user_preferences/alice').get()).exists).toBe(false);
    expect(
      (await db.collectionGroup('active_members').get()).docs.map(
        (doc) => doc.id,
      ),
    ).not.toContain('alice');
    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).toHaveBeenCalledWith('alice');
    expect((await db.doc('users/bob').get()).exists).toBe(true);
  });

  it('anonymizes memberships that ended earlier', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, fixedId(900), [
      { uid: 'carol', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'bob', membershipId: fixedId(2) },
    ]);
    await db.doc(`memberships/${fixedId(2)}`).update({ status: 'REMOVED' });
    await db.doc(`budgets/${fixedId(900)}/active_members/bob`).delete();

    const { deps } = deletionDeps();
    await deleteMyProfile(deps, bob);

    const membership = (await db.doc(`memberships/${fixedId(2)}`).get()).data();
    expect(membership).toMatchObject({ user_id: null, status: 'REMOVED' });
    expect(await activeRoles(db, fixedId(900))).toEqual({ carol: 'ADMIN' });
  });

  it("deleting the last active member's profile deletes the budget and its data", async () => {
    const base = testDeps();
    const db = adminDb();
    const budget = await createBudget(base, alice, { name: 'Solo' });
    const invite = await createInvitation(base, alice, {
      budget_id: budget.budget_id,
    });
    await db
      .doc(`budget_records/${budget.budget_id}/items/t1`)
      .set({ amount: '1.0000' });

    const { deps } = deletionDeps();
    const result = await deleteMyProfile(deps, alice);

    expect(result.deleted_budget_ids).toEqual([budget.budget_id]);
    expect(await countDocs(db, 'budgets')).toBe(0);
    expect(await countDocs(db, 'memberships')).toBe(0);
    expect(await countDocs(db, 'invitations')).toBe(0);
    expect(await countDocs(db, 'invitation_tokens')).toBe(0);
    expect(
      await countDocs(db, `budget_records/${budget.budget_id}/items`),
    ).toBe(0);
    expect(invite.invitation_id).toBeTruthy();
  });

  it('does not touch other users, budgets or their memberships', async () => {
    const base = testDeps();
    const db = adminDb();
    const others = await createBudget(base, carol, { name: 'Carol only' });
    const mine = await createBudget(base, alice, { name: 'Mine' });
    await join(base, alice, mine.budget_id, bob);

    const { deps } = deletionDeps();
    await deleteMyProfile(deps, alice);

    expect(await activeRoles(db, others.budget_id)).toEqual({ carol: 'ADMIN' });
    expect(
      (await db.doc(`memberships/${others.membership_id}`).get()).get(
        'user_id',
      ),
    ).toBe('carol');
    expect(await activeRoles(db, mine.budget_id)).toEqual({ bob: 'ADMIN' });
  });

  it('removes the e-mail from ended invitations addressed to the deleted user', async () => {
    const base = testDeps();
    const db = adminDb();
    const budget = await createBudget(base, carol, { name: 'Carol' });
    const accepted = await createInvitation(base, carol, {
      budget_id: budget.budget_id,
      invitee_email: 'alice@example.test',
    });
    await acceptInvitation(
      base,
      { ...alice, emailVerified: true },
      accepted.token,
    );
    const pending = await createInvitation(base, carol, {
      budget_id: budget.budget_id,
      invitee_email: 'alice@example.test',
    });

    const { deps } = deletionDeps();
    await deleteMyProfile(deps, alice);

    const read = async (id: string) =>
      (await db.doc(`invitations/${id}`).get()).get('invitee_email');
    expect(await read(accepted.invitation_id)).toBeNull();
    expect(await read(pending.invitation_id)).toBe('alice@example.test');
  });

  it('can be repeated after the identity deletion failed', async () => {
    const base = testDeps();
    const db = adminDb();
    await ensureUserProfile(base, alice);
    await createBudget(base, alice, { name: 'Solo' });

    const failing = vi
      .fn<(uid: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('auth unavailable'))
      .mockResolvedValue(undefined);
    const deps = { ...testDeps(), deleteAuthUser: failing };

    await expect(deleteMyProfile(deps, alice)).rejects.toThrow(
      'auth unavailable',
    );
    const retry = await deleteMyProfile(deps, alice);

    expect(retry).toEqual({
      deleted_budget_ids: [],
      cleanup_pending_budget_ids: [],
    });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(await countDocs(db, 'budgets')).toBe(0);
    expect((await db.doc('users/alice').get()).exists).toBe(false);
  });

  it('rejects unauthenticated callers without side effects', async () => {
    const { deps, deleteAuthUser } = deletionDeps();
    await expect(deleteMyProfile(deps, null)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(deleteAuthUser).not.toHaveBeenCalled();
  });
});
