import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const PROJECT_ID = 'demo-income-tracker';

describe('Firestore rules: membership-based access', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'memberships/budget-a_owner-1'), {
        budget_id: 'budget-a',
        user_id: 'owner-1',
        status: 'active',
      });
      await setDoc(doc(db, 'memberships/budget-a_member-1'), {
        budget_id: 'budget-a',
        user_id: 'member-1',
        status: 'active',
      });
      await setDoc(doc(db, 'memberships/budget-a_removed-1'), {
        budget_id: 'budget-a',
        user_id: 'removed-1',
        status: 'removed',
      });
      await setDoc(doc(db, 'budgets/budget-a'), {
        name: 'Family Budget',
      });
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('allows owner and active member to read budget', async () => {
    const ownerDb = testEnv.authenticatedContext('owner-1').firestore();
    const memberDb = testEnv.authenticatedContext('member-1').firestore();

    await assertSucceeds(getDoc(doc(ownerDb, 'budgets/budget-a')));
    await assertSucceeds(getDoc(doc(memberDb, 'budgets/budget-a')));
  });

  it('rejects non-member and removed member', async () => {
    const outsiderDb = testEnv.authenticatedContext('outsider-1').firestore();
    const removedDb = testEnv.authenticatedContext('removed-1').firestore();

    await assertFails(getDoc(doc(outsiderDb, 'budgets/budget-a')));
    await assertFails(getDoc(doc(removedDb, 'budgets/budget-a')));
  });

  it('enforces write permissions by membership status', async () => {
    const memberDb = testEnv.authenticatedContext('member-1').firestore();
    const outsiderDb = testEnv.authenticatedContext('outsider-1').firestore();

    await assertSucceeds(
      setDoc(doc(memberDb, 'budget_records/budget-a/items/item-1'), {
        amount: 120,
        note: 'Allowed for active member',
      }),
    );

    await assertFails(
      setDoc(doc(outsiderDb, 'budget_records/budget-a/items/item-2'), {
        amount: 200,
        note: 'Should be denied',
      }),
    );
  });
});
