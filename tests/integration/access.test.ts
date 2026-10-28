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
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  setLogLevel,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBudget } from '../../src/server/budgets';
import {
  acceptInvitation,
  createInvitation,
} from '../../src/server/invitations';
import { leaveBudget, removeMember } from '../../src/server/memberships';
import { clearFirestore, testDeps } from './helpers';

/**
 * Real service-created data checked through the client rules: the UI is not
 * involved, the backend alone must block foreign access (I-FR-05, I-TR-14).
 */
describe('access control over service-created data (I-FR-05, I-TR-06, I-TR-14)', () => {
  let testEnv: RulesTestEnvironment;
  const deps = testDeps();
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

  const client = (uid: string) => testEnv.authenticatedContext(uid).firestore();

  beforeAll(async () => {
    setLogLevel('silent');
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-income-tracker',
      firestore: {
        rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      },
    });
  });

  beforeEach(clearFirestore);

  afterAll(async () => {
    await testEnv.cleanup();
  });

  async function twoBudgets() {
    const budgetA = await createBudget(deps, alice, { name: 'Alice budget' });
    const budgetB = await createBudget(deps, carol, { name: 'Carol budget' });
    return { budgetA, budgetB };
  }

  it('lets creators read their own budget and rejects foreign budgets', async () => {
    const { budgetA, budgetB } = await twoBudgets();

    await assertSucceeds(
      getDoc(doc(client('alice'), `budgets/${budgetA.budget_id}`)),
    );
    await assertSucceeds(
      getDoc(doc(client('carol'), `budgets/${budgetB.budget_id}`)),
    );
    await assertFails(
      getDoc(doc(client('alice'), `budgets/${budgetB.budget_id}`)),
    );
    await assertFails(
      getDoc(doc(client('carol'), `budgets/${budgetA.budget_id}`)),
    );
    await assertFails(
      getDocs(
        collection(
          client('alice'),
          `budgets/${budgetB.budget_id}/active_members`,
        ),
      ),
    );
    await assertFails(
      setDoc(
        doc(client('alice'), `budget_records/${budgetB.budget_id}/items/x`),
        {
          amount: 1,
        },
      ),
    );
  });

  it('exposes members, roles and own history to the right people only', async () => {
    const { budgetA } = await twoBudgets();
    const { token } = await createInvitation(deps, alice, {
      budget_id: budgetA.budget_id,
    });
    await acceptInvitation(deps, bob, token);

    const members = await assertSucceeds(
      getDocs(
        collection(
          client('bob'),
          `budgets/${budgetA.budget_id}/active_members`,
        ),
      ),
    );
    expect(members.docs.map((snapshot) => snapshot.id).sort()).toEqual([
      'alice',
      'bob',
    ]);

    await assertSucceeds(
      getDocs(
        query(
          collection(client('bob'), 'memberships'),
          where('budget_id', '==', budgetA.budget_id),
        ),
      ),
    );
    await assertFails(
      getDocs(
        query(
          collection(client('carol'), 'memberships'),
          where('budget_id', '==', budgetA.budget_id),
        ),
      ),
    );
  });

  it('shows invitations to the admin only and never exposes token hashes index', async () => {
    const { budgetA } = await twoBudgets();
    const invitation = await createInvitation(deps, alice, {
      budget_id: budgetA.budget_id,
    });
    await acceptInvitation(
      deps,
      bob,
      (await createInvitation(deps, alice, { budget_id: budgetA.budget_id }))
        .token,
    );

    await assertSucceeds(
      getDoc(doc(client('alice'), `invitations/${invitation.invitation_id}`)),
    );
    await assertFails(
      getDoc(doc(client('bob'), `invitations/${invitation.invitation_id}`)),
    );
    await assertFails(
      getDoc(doc(client('carol'), `invitations/${invitation.invitation_id}`)),
    );
    await assertFails(
      getDocs(collection(client('alice'), 'invitation_tokens')),
    );
  });

  it('denies a removed member immediately, while keeping their history readable', async () => {
    const { budgetA } = await twoBudgets();
    const { token } = await createInvitation(deps, alice, {
      budget_id: budgetA.budget_id,
    });
    const joined = await acceptInvitation(deps, bob, token);
    const recordPath = `budget_records/${budgetA.budget_id}/items/i1`;

    await assertSucceeds(
      getDoc(doc(client('bob'), `budgets/${budgetA.budget_id}`)),
    );
    await assertSucceeds(setDoc(doc(client('bob'), recordPath), { amount: 5 }));

    await removeMember(deps, alice, {
      budget_id: budgetA.budget_id,
      membership_id: joined.membership_id,
    });

    await assertFails(
      getDoc(doc(client('bob'), `budgets/${budgetA.budget_id}`)),
    );
    await assertFails(getDoc(doc(client('bob'), recordPath)));
    await assertFails(setDoc(doc(client('bob'), recordPath), { amount: 6 }));
    await assertSucceeds(
      getDoc(doc(client('bob'), `memberships/${joined.membership_id}`)),
    );
    await assertSucceeds(getDoc(doc(client('alice'), recordPath)));
  });

  it('denies a member who left, and the former admin after handing over', async () => {
    const { budgetA } = await twoBudgets();
    const { token } = await createInvitation(deps, alice, {
      budget_id: budgetA.budget_id,
    });
    await acceptInvitation(deps, bob, token);

    await leaveBudget(deps, alice, budgetA.budget_id);

    await assertFails(
      getDoc(doc(client('alice'), `budgets/${budgetA.budget_id}`)),
    );
    await assertSucceeds(
      getDoc(doc(client('bob'), `budgets/${budgetA.budget_id}`)),
    );
    const bobAccess = await getDoc(
      doc(client('bob'), `budgets/${budgetA.budget_id}/active_members/bob`),
    );
    expect(bobAccess.get('role')).toBe('ADMIN');

    // The new admin can now see invitations; the former admin cannot.
    const fresh = await createInvitation(deps, bob, {
      budget_id: budgetA.budget_id,
    });
    await assertSucceeds(
      getDoc(doc(client('bob'), `invitations/${fresh.invitation_id}`)),
    );
    await assertFails(
      getDoc(doc(client('alice'), `invitations/${fresh.invitation_id}`)),
    );
  });

  it('blocks everyone once the budget is deleted', async () => {
    const { budgetA } = await twoBudgets();
    await leaveBudget(deps, alice, budgetA.budget_id);

    await assertFails(
      getDoc(doc(client('alice'), `budgets/${budgetA.budget_id}`)),
    );
    await assertFails(
      getDoc(doc(client('carol'), `budgets/${budgetA.budget_id}`)),
    );
  });
});
