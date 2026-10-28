import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/server/accounts';
import { createBudget } from '../../src/server/budgets';
import { acceptInvitation, createInvitation } from '../../src/server/invitations';
import { leaveBudget } from '../../src/server/memberships';
import { adminDb, clearFirestore, testDeps } from './helpers';

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

describe('budget accounts (I-FR-38)', () => {
  beforeEach(clearFirestore);

  it('creates an account owned by the caller when owner is omitted', async () => {
    const deps = testDeps();
    const budget = await createBudget(deps, alice, { name: 'Home' });
    const created = await createAccount(deps, alice, {
      budget_id: budget.budget_id,
      label: 'Main account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });

    const snapshot = await adminDb().doc(`accounts/${created.account_id}`).get();
    expect(snapshot.data()).toMatchObject({
      budget_id: budget.budget_id,
      owner_membership_id: budget.membership_id,
      label: 'Main account',
      institution_name: null,
      currency: 'CHF',
      account_type: 'CHECKING',
      archived_at: null,
    });
  });

  it('allows selecting another active member as owner', async () => {
    const deps = testDeps();
    const budget = await createBudget(deps, alice, { name: 'Home' });
    const invitation = await createInvitation(deps, alice, {
      budget_id: budget.budget_id,
    });
    const joined = await acceptInvitation(deps, bob, invitation.token);

    const created = await createAccount(deps, alice, {
      budget_id: budget.budget_id,
      label: 'Shared savings',
      currency: 'CHF',
      account_type: 'SAVINGS',
      owner_membership_id: joined.membership_id,
      institution_name: 'Example Bank',
    });
    const snapshot = await adminDb().doc(`accounts/${created.account_id}`).get();
    expect(snapshot.get('owner_membership_id')).toBe(joined.membership_id);
  });

  it('rejects a non-active or foreign owner membership', async () => {
    const deps = testDeps();
    const budget = await createBudget(deps, alice, { name: 'Home' });
    const invitation = await createInvitation(deps, alice, {
      budget_id: budget.budget_id,
    });
    const joined = await acceptInvitation(deps, bob, invitation.token);
    await leaveBudget(deps, bob, budget.budget_id);

    await expect(
      createAccount(deps, alice, {
        budget_id: budget.budget_id,
        label: 'Old owner',
        currency: 'CHF',
        account_type: 'CHECKING',
        owner_membership_id: joined.membership_id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects callers who are not active budget members', async () => {
    const budget = await createBudget(testDeps(), alice, { name: 'Home' });
    await expect(
      createAccount(testDeps(), carol, {
        budget_id: budget.budget_id,
        label: 'No access',
        currency: 'CHF',
        account_type: 'OTHER',
      }),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });
  });
});
