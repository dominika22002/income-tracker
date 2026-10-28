import { beforeEach, describe, expect, it } from 'vitest';
import { createBudget } from '../../src/server/budgets';
import {
  adminDb,
  clearFirestore,
  countDocs,
  failingDb,
  testDeps,
} from './helpers';

const alice = {
  uid: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
};
const bob = { uid: 'bob', email: 'bob@example.test', displayName: 'Bob' };

describe('budget creation (I-FR-02)', () => {
  beforeEach(clearFirestore);

  it('creates one budget with the first active admin membership', async () => {
    const db = adminDb();
    const result = await createBudget(testDeps(), alice, { name: ' Home ' });

    const budget = (await db.doc(`budgets/${result.budget_id}`).get()).data();
    expect(budget).toMatchObject({ name: 'Home', created_by_user_id: 'alice' });

    const membership = (
      await db.doc(`memberships/${result.membership_id}`).get()
    ).data();
    expect(membership).toMatchObject({
      budget_id: result.budget_id,
      user_id: 'alice',
      role: 'ADMIN',
      status: 'ACTIVE',
      ended_at: null,
    });
    expect(membership?.joined_at.toDate().toISOString()).toBe(
      '2026-03-01T10:00:00.000Z',
    );

    const access = (
      await db.doc(`budgets/${result.budget_id}/active_members/alice`).get()
    ).data();
    expect(access).toMatchObject({
      membership_id: result.membership_id,
      role: 'ADMIN',
      display_name: 'Alice',
      email: 'alice@example.test',
    });
    expect(await countDocs(db, 'budgets')).toBe(1);
    expect(await countDocs(db, 'memberships')).toBe(1);
  });

  it.each([1, 2, 3])(
    'leaves no empty budget or orphaned membership when write #%i fails',
    async (failingWrite) => {
      const db = adminDb();
      const deps = testDeps(undefined, failingDb(db, failingWrite));
      await expect(createBudget(deps, alice, { name: 'Home' })).rejects.toThrow(
        'Injected failure',
      );

      expect(await countDocs(db, 'budgets')).toBe(0);
      expect(await countDocs(db, 'memberships')).toBe(0);
      expect(
        (await db.collectionGroup('active_members').count().get()).data().count,
      ).toBe(0);
    },
  );

  it('is idempotent for the same client budget id and creator (TR-12)', async () => {
    const db = adminDb();
    const deps = testDeps();
    const budget_id = '3f2b8c1e-7a4d-4c55-9e0a-1b2c3d4e5f60';
    const first = await createBudget(deps, alice, { name: 'Home', budget_id });
    const second = await createBudget(deps, alice, { name: 'Home', budget_id });

    expect(second).toEqual(first);
    expect(await countDocs(db, 'budgets')).toBe(1);
    expect(await countDocs(db, 'memberships')).toBe(1);
  });

  it('rejects reusing a budget id that belongs to someone else', async () => {
    const deps = testDeps();
    const budget_id = '3f2b8c1e-7a4d-4c55-9e0a-1b2c3d4e5f60';
    await createBudget(deps, alice, { name: 'Home', budget_id });
    await expect(
      createBudget(deps, bob, { name: 'Mine', budget_id }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await countDocs(adminDb(), 'memberships')).toBe(1);
  });

  it('rejects invalid requests and unauthenticated callers without writing', async () => {
    const deps = testDeps();
    await expect(
      createBudget(deps, alice, { name: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      createBudget(deps, null, { name: 'Home' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await countDocs(adminDb(), 'budgets')).toBe(0);
  });

  it('lets one user own several budgets', async () => {
    const deps = testDeps();
    await createBudget(deps, alice, { name: 'Home' });
    await createBudget(deps, alice, { name: 'Holiday' });
    expect(await countDocs(adminDb(), 'budgets')).toBe(2);
    expect(await countDocs(adminDb(), 'memberships')).toBe(2);
  });
});
