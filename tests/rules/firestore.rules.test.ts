import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  setLogLevel,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { seedAccount, seedBudget, seedEndedMembership } from './helpers';

const PROJECT_ID = 'demo-income-tracker';

describe('Firestore rules: budget access', () => {
  let testEnv: RulesTestEnvironment;

  const asUser = (uid: string, token: Record<string, unknown> = {}) =>
    testEnv.authenticatedContext(uid, token).firestore();

  beforeAll(async () => {
    setLogLevel('silent');
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await seedBudget(testEnv, 'budget-a', 'Family', [
      { userId: 'owner-1', membershipId: 'm-owner-1', role: 'ADMIN' },
      { userId: 'member-1', membershipId: 'm-member-1' },
    ]);
    await seedBudget(testEnv, 'budget-b', 'Other household', [
      { userId: 'other-owner', membershipId: 'm-other-owner', role: 'ADMIN' },
    ]);
    await seedEndedMembership(
      testEnv,
      'm-removed-1',
      'budget-a',
      'removed-1',
      'REMOVED',
    );
    await seedEndedMembership(
      testEnv,
      'm-left-1',
      'budget-a',
      'left-1',
      'LEFT',
    );
    await seedAccount(testEnv, 'acc-a-1', {
      budgetId: 'budget-a',
      ownerMembershipId: 'm-owner-1',
      label: 'Family main',
    });
    await seedAccount(testEnv, 'acc-b-1', {
      budgetId: 'budget-b',
      ownerMembershipId: 'm-other-owner',
      label: 'Other main',
    });
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'import_batches/batch-a-1'), {
        budget_id: 'budget-a',
        account_id: 'acc-a-1',
        status: 'IMPORTED',
      });
      await setDoc(doc(db, 'import_periods/period-a-1'), {
        budget_id: 'budget-a',
        import_batch_id: 'batch-a-1',
      });
      await setDoc(doc(db, 'transactions/transaction-a-1'), {
        budget_id: 'budget-a',
        account_id: 'acc-a-1',
        amount: '1.00',
      });
      await setDoc(doc(db, 'account_balance_snapshots/snapshot-a-1'), {
        account_id: 'acc-a-1',
        balance_amount: '10.00',
      });
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  describe('own versus foreign budget', () => {
    it('allows an admin and an active member to read their budget', async () => {
      await assertSucceeds(getDoc(doc(asUser('owner-1'), 'budgets/budget-a')));
      await assertSucceeds(getDoc(doc(asUser('member-1'), 'budgets/budget-a')));
    });

    it('rejects non-members, removed and former members', async () => {
      for (const uid of ['outsider-1', 'removed-1', 'left-1']) {
        await assertFails(getDoc(doc(asUser(uid), 'budgets/budget-a')));
      }
    });

    it('rejects unauthenticated access', async () => {
      const anonymous = testEnv.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anonymous, 'budgets/budget-a')));
    });

    it('rejects a member of one budget reading another budget by changing the id', async () => {
      const db = asUser('owner-1');
      await assertFails(getDoc(doc(db, 'budgets/budget-b')));
      await assertFails(getDoc(doc(db, 'budget_records/budget-b/items/x')));
      await assertFails(
        getDocs(collection(db, 'budgets/budget-b/active_members')),
      );
    });

    it('enforces budget data write permissions by active membership', async () => {
      await assertSucceeds(
        setDoc(doc(asUser('member-1'), 'budget_records/budget-a/items/i1'), {
          amount: 120,
        }),
      );
      for (const uid of ['outsider-1', 'removed-1', 'left-1']) {
        await assertFails(
          setDoc(doc(asUser(uid), 'budget_records/budget-a/items/i2'), {
            amount: 200,
          }),
        );
      }
      await assertFails(
        setDoc(doc(asUser('owner-1'), 'budget_records/budget-b/items/i3'), {
          amount: 1,
        }),
      );
    });

    it('lets members see who else is in the budget', async () => {
      await assertSucceeds(
        getDocs(
          collection(asUser('member-1'), 'budgets/budget-a/active_members'),
        ),
      );
      await assertFails(
        getDocs(
          collection(asUser('outsider-1'), 'budgets/budget-a/active_members'),
        ),
      );
    });

    it('lets active members read accounts of their budget only', async () => {
      await assertSucceeds(getDoc(doc(asUser('owner-1'), 'accounts/acc-a-1')));
      await assertSucceeds(getDoc(doc(asUser('member-1'), 'accounts/acc-a-1')));
      await assertFails(getDoc(doc(asUser('member-1'), 'accounts/acc-b-1')));
      await assertFails(getDoc(doc(asUser('outsider-1'), 'accounts/acc-a-1')));
    });

    it('lets active members read import records and transactions of their budget', async () => {
      for (const path of [
        'import_batches/batch-a-1',
        'import_periods/period-a-1',
        'transactions/transaction-a-1',
        'account_balance_snapshots/snapshot-a-1',
      ]) {
        await assertSucceeds(getDoc(doc(asUser('member-1'), path)));
        await assertFails(getDoc(doc(asUser('other-owner'), path)));
      }
    });
  });

  describe('access after membership is revoked', () => {
    it('denies reads and writes as soon as the access document disappears', async () => {
      const db = asUser('member-1');
      await assertSucceeds(getDoc(doc(db, 'budgets/budget-a')));
      await assertSucceeds(
        setDoc(doc(db, 'budget_records/budget-a/items/i1'), { amount: 1 }),
      );

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const admin = context.firestore();
        await deleteDoc(doc(admin, 'budgets/budget-a/active_members/member-1'));
        await updateDoc(doc(admin, 'memberships/m-member-1'), {
          status: 'REMOVED',
        });
      });

      await assertFails(getDoc(doc(db, 'budgets/budget-a')));
      await assertFails(getDoc(doc(db, 'budget_records/budget-a/items/i1')));
      await assertFails(
        setDoc(doc(db, 'budget_records/budget-a/items/i1'), { amount: 2 }),
      );
    });

    it('does not trust a membership document whose status is not ACTIVE', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await deleteDoc(
          doc(context.firestore(), 'budgets/budget-a/active_members/member-1'),
        );
      });
      await assertFails(getDoc(doc(asUser('member-1'), 'budgets/budget-a')));
    });
  });

  describe('memberships', () => {
    it('lets users read their own memberships, including history', async () => {
      await assertSucceeds(
        getDoc(doc(asUser('member-1'), 'memberships/m-member-1')),
      );
      await assertSucceeds(
        getDocs(
          query(
            collection(asUser('removed-1'), 'memberships'),
            where('user_id', '==', 'removed-1'),
          ),
        ),
      );
    });

    it('lets active members list the memberships of their budget only', async () => {
      await assertSucceeds(
        getDocs(
          query(
            collection(asUser('member-1'), 'memberships'),
            where('budget_id', '==', 'budget-a'),
          ),
        ),
      );
      await assertFails(
        getDocs(
          query(
            collection(asUser('member-1'), 'memberships'),
            where('budget_id', '==', 'budget-b'),
          ),
        ),
      );
      await assertFails(
        getDocs(
          query(
            collection(asUser('outsider-1'), 'memberships'),
            where('budget_id', '==', 'budget-a'),
          ),
        ),
      );
    });

    it('hides memberships of foreign budgets and anonymized history from non-members', async () => {
      await assertFails(
        getDoc(doc(asUser('member-1'), 'memberships/m-other-owner')),
      );
      await seedEndedMembership(testEnv, 'm-anon', 'budget-b', null, 'LEFT');
      await assertFails(getDoc(doc(asUser('member-1'), 'memberships/m-anon')));
    });
  });

  describe('client writes are rejected for server-owned data', () => {
    it('rejects creating or changing budgets, memberships and access documents', async () => {
      const db = asUser('owner-1');
      await assertFails(setDoc(doc(db, 'budgets/new-budget'), { name: 'x' }));
      await assertFails(
        updateDoc(doc(db, 'budgets/budget-a'), { name: 'Hacked' }),
      );
      await assertFails(deleteDoc(doc(db, 'budgets/budget-a')));
      await assertFails(
        setDoc(doc(db, 'memberships/self-made'), {
          budget_id: 'budget-b',
          user_id: 'owner-1',
          role: 'ADMIN',
          status: 'ACTIVE',
        }),
      );
      await assertFails(
        updateDoc(doc(db, 'memberships/m-owner-1'), { status: 'LEFT' }),
      );
      await assertFails(
        setDoc(doc(db, 'budgets/budget-b/active_members/owner-1'), {
          role: 'ADMIN',
          membership_id: 'x',
        }),
      );
      await assertFails(
        updateDoc(
          doc(asUser('member-1'), 'budgets/budget-a/active_members/member-1'),
          {
            role: 'ADMIN',
          },
        ),
      );
      await assertFails(
        setDoc(doc(db, 'accounts/self-made'), {
          budget_id: 'budget-a',
          owner_membership_id: 'm-owner-1',
          label: 'Hacked',
          currency: 'CHF',
          account_type: 'CHECKING',
        }),
      );
      await assertFails(updateDoc(doc(db, 'accounts/acc-a-1'), { label: 'x' }));
      await assertFails(
        setDoc(doc(db, 'import_batches/forged'), { budget_id: 'budget-a' }),
      );
      await assertFails(
        setDoc(doc(db, 'transactions/forged'), { budget_id: 'budget-a' }),
      );
    });

    it('rejects client writes to profiles and preferences, even for the owner', async () => {
      const db = asUser('owner-1');
      await assertFails(setDoc(doc(db, 'users/owner-1'), { email: 'a@b.c' }));
      await assertFails(
        setDoc(doc(db, 'user_preferences/owner-1'), {
          primary_currency: 'USD',
        }),
      );
    });

    it('keeps invitation tokens and unknown collections unreachable', async () => {
      const db = asUser('owner-1');
      await assertFails(getDoc(doc(db, 'invitation_tokens/abc')));
      await assertFails(setDoc(doc(db, 'invitation_tokens/abc'), {}));
      await assertFails(getDoc(doc(db, 'budget_purge_queue/budget-a')));
      await assertFails(getDoc(doc(db, 'something_else/x')));
    });
  });

  describe('profiles and preferences', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await setDoc(doc(db, 'users/owner-1'), {
          email: 'owner-1@example.test',
        });
        await setDoc(doc(db, 'user_preferences/owner-1'), {
          primary_currency: 'CHF',
          secondary_currencies: ['PLN', 'EUR'],
        });
      });
    });

    it('lets only the owner read their profile and preferences', async () => {
      await assertSucceeds(getDoc(doc(asUser('owner-1'), 'users/owner-1')));
      await assertSucceeds(
        getDoc(doc(asUser('owner-1'), 'user_preferences/owner-1')),
      );
      await assertFails(getDoc(doc(asUser('member-1'), 'users/owner-1')));
      await assertFails(
        getDoc(doc(asUser('member-1'), 'user_preferences/owner-1')),
      );
    });
  });

  describe('invitations', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'invitations/inv-1'), {
          budget_id: 'budget-a',
          invited_by_membership_id: 'm-owner-1',
          invitee_email: 'guest@example.test',
          token_hash: 'a'.repeat(64),
          status: 'PENDING',
        });
        await setDoc(doc(context.firestore(), 'invitations/inv-open'), {
          budget_id: 'budget-a',
          invited_by_membership_id: 'm-owner-1',
          invitee_email: null,
          token_hash: 'b'.repeat(64),
          status: 'PENDING',
        });
      });
    });

    it('lets only the budget admin read invitations of the budget', async () => {
      await assertSucceeds(
        getDoc(doc(asUser('owner-1'), 'invitations/inv-open')),
      );
      await assertFails(
        getDoc(doc(asUser('member-1'), 'invitations/inv-open')),
      );
      await assertFails(
        getDoc(doc(asUser('outsider-1'), 'invitations/inv-open')),
      );
      await assertFails(
        getDoc(doc(asUser('other-owner'), 'invitations/inv-open')),
      );
    });

    it('lets the invited person with a verified e-mail read the invitation', async () => {
      const verified = asUser('guest-1', {
        email: 'Guest@Example.test',
        email_verified: true,
      });
      await assertSucceeds(getDoc(doc(verified, 'invitations/inv-1')));
      await assertSucceeds(
        getDocs(
          query(
            collection(verified, 'invitations'),
            where('invitee_email', '==', 'guest@example.test'),
          ),
        ),
      );
    });

    it('rejects an unverified or different e-mail', async () => {
      const unverified = asUser('guest-1', {
        email: 'guest@example.test',
        email_verified: false,
      });
      const stranger = asUser('guest-2', {
        email: 'stranger@example.test',
        email_verified: true,
      });
      await assertFails(getDoc(doc(unverified, 'invitations/inv-1')));
      await assertFails(getDoc(doc(stranger, 'invitations/inv-1')));
      await assertFails(getDoc(doc(stranger, 'invitations/inv-open')));
    });

    it('rejects client writes to invitations', async () => {
      await assertFails(
        updateDoc(doc(asUser('owner-1'), 'invitations/inv-open'), {
          status: 'CANCELLED',
        }),
      );
      await assertFails(
        setDoc(doc(asUser('owner-1'), 'invitations/forged'), {
          budget_id: 'budget-a',
          status: 'PENDING',
        }),
      );
    });
  });
});
