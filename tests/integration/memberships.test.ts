import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBudget } from '../../src/server/budgets';
import {
  purgeBudgetData,
  purgePendingBudgets,
} from '../../src/server/budgetLifecycle';
import {
  acceptInvitation,
  createInvitation,
} from '../../src/server/invitations';
import {
  leaveBudget,
  leaveInTransaction,
  removeMember,
} from '../../src/server/memberships';
import {
  activeRoles,
  adminDb,
  clearFirestore,
  countDocs,
  fixedId,
  seedBudgetDirect,
  testDeps,
} from './helpers';

const BUDGET = fixedId(900);
const A = { uid: 'a', email: 'a@example.test' };
const B = { uid: 'b', email: 'b@example.test' };
const C = { uid: 'c', email: 'c@example.test' };
const D = { uid: 'd', email: 'd@example.test' };

async function expectSingleAdmin(budgetId: string): Promise<void> {
  const roles = Object.values(await activeRoles(adminDb(), budgetId));
  expect(roles.filter((role) => role === 'ADMIN')).toHaveLength(1);
}

describe('leaving a budget (I-FR-07)', () => {
  beforeEach(clearFirestore);

  it('lets a regular member leave and keeps their membership as history', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2) },
    ]);
    const result = await leaveBudget(testDeps(), B, BUDGET);

    expect(result).toEqual({ budget_deleted: false, cleanup_pending: false });
    const membership = (await db.doc(`memberships/${fixedId(2)}`).get()).data();
    expect(membership).toMatchObject({ status: 'LEFT', user_id: 'b' });
    expect(membership?.ended_at).toBeInstanceOf(Timestamp);
    expect(await activeRoles(db, BUDGET)).toEqual({ a: 'ADMIN' });
  });

  it('rejects leaving twice or leaving a budget one is not in', async () => {
    await seedBudgetDirect(adminDb(), BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2) },
    ]);
    const deps = testDeps();
    await leaveBudget(deps, B, BUDGET);
    await expect(leaveBudget(deps, B, BUDGET)).rejects.toMatchObject({
      code: 'NOT_ACTIVE_MEMBER',
    });
    await expect(leaveBudget(deps, C, BUDGET)).rejects.toMatchObject({
      code: 'NOT_ACTIVE_MEMBER',
    });
    await expect(leaveBudget(deps, B, 'nope')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(await activeRoles(adminDb(), BUDGET)).toEqual({ a: 'ADMIN' });
  });

  it('hands the admin role to the earliest joined remaining member', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      {
        uid: 'a',
        membershipId: fixedId(1),
        role: 'ADMIN',
        joinedAt: '2026-01-01T00:00:00Z',
      },
      { uid: 'c', membershipId: fixedId(2), joinedAt: '2026-03-01T00:00:00Z' },
      { uid: 'b', membershipId: fixedId(3), joinedAt: '2026-02-01T00:00:00Z' },
    ]);
    await leaveBudget(testDeps(), A, BUDGET);

    expect(await activeRoles(db, BUDGET)).toEqual({ b: 'ADMIN', c: 'MEMBER' });
    expect((await db.doc(`memberships/${fixedId(3)}`).get()).get('role')).toBe(
      'ADMIN',
    );
    expect(
      (await db.doc(`memberships/${fixedId(1)}`).get()).get('status'),
    ).toBe('LEFT');
  });

  it('breaks joined_at ties with the lowest membership_id, not insertion order', async () => {
    const db = adminDb();
    const same = '2026-02-01T00:00:00Z';
    await seedBudgetDirect(db, BUDGET, [
      {
        uid: 'a',
        membershipId: fixedId(50),
        role: 'ADMIN',
        joinedAt: '2026-01-01T00:00:00Z',
      },
      { uid: 'd', membershipId: fixedId(30), joinedAt: same },
      { uid: 'b', membershipId: fixedId(20), joinedAt: same },
      { uid: 'c', membershipId: fixedId(40), joinedAt: same },
    ]);
    await leaveBudget(testDeps(), A, BUDGET);
    expect((await activeRoles(db, BUDGET)).b).toBe('ADMIN');
  });

  it('chooses the same successor on repeated runs of identical data', async () => {
    const outcomes = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      await clearFirestore();
      await seedBudgetDirect(adminDb(), BUDGET, [
        { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
        {
          uid: 'x',
          membershipId: fixedId(7),
          joinedAt: '2026-02-01T00:00:00Z',
        },
        {
          uid: 'y',
          membershipId: fixedId(6),
          joinedAt: '2026-02-01T00:00:00Z',
        },
      ]);
      await leaveBudget(testDeps(), A, BUDGET);
      const roles = await activeRoles(adminDb(), BUDGET);
      outcomes.add(JSON.stringify(roles));
    }
    expect([...outcomes]).toEqual(['{"x":"MEMBER","y":"ADMIN"}']);
  });

  it('keeps data intact: authored and hidden records are untouched (I-FR-08)', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2) },
    ]);
    const record = {
      created_by_membership_id: fixedId(2),
      hidden_mode: 'TRANSACTION',
      hidden_until: null,
      hidden_by_membership_id: fixedId(2),
      amount: '12.5000',
    };
    await db.doc(`budget_records/${BUDGET}/items/t1`).set(record);

    await leaveBudget(testDeps(), B, BUDGET);

    expect(
      (await db.doc(`budget_records/${BUDGET}/items/t1`).get()).data(),
    ).toEqual(record);
    expect((await db.doc(`memberships/${fixedId(2)}`).get()).exists).toBe(true);
  });

  it('creates a new membership when a former member is invited again', async () => {
    const deps = testDeps();
    const { budget_id } = await createBudget(deps, A, { name: 'Home' });
    const first = await createInvitation(deps, A, { budget_id });
    const joined = await acceptInvitation(deps, B, first.token);
    await leaveBudget(deps, B, budget_id);

    const second = await createInvitation(deps, A, { budget_id });
    const rejoined = await acceptInvitation(deps, B, second.token);

    expect(rejoined.membership_id).not.toBe(joined.membership_id);
    const history = await adminDb()
      .collection('memberships')
      .where('user_id', '==', 'b')
      .get();
    expect(history.docs.map((doc) => doc.get('status')).sort()).toEqual([
      'ACTIVE',
      'LEFT',
    ]);
  });
});

describe('removing members (I-FR-06)', () => {
  beforeEach(clearFirestore);

  async function seed() {
    await seedBudgetDirect(adminDb(), BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2) },
      { uid: 'c', membershipId: fixedId(3) },
    ]);
  }

  it('lets the admin remove a member while keeping the membership record', async () => {
    await seed();
    await removeMember(testDeps(), A, {
      budget_id: BUDGET,
      membership_id: fixedId(2),
    });

    const db = adminDb();
    expect(await activeRoles(db, BUDGET)).toEqual({ a: 'ADMIN', c: 'MEMBER' });
    expect(
      (await db.doc(`memberships/${fixedId(2)}`).get()).data(),
    ).toMatchObject({
      status: 'REMOVED',
      user_id: 'b',
    });
  });

  it('rejects removal by members, outsiders and for invalid targets', async () => {
    await seed();
    const deps = testDeps();
    const request = (membership_id: string) => ({
      budget_id: BUDGET,
      membership_id,
    });

    await expect(
      removeMember(deps, B, request(fixedId(3))),
    ).rejects.toMatchObject({
      code: 'NOT_ADMIN',
    });
    await expect(
      removeMember(deps, D, request(fixedId(3))),
    ).rejects.toMatchObject({
      code: 'NOT_ACTIVE_MEMBER',
    });
    await expect(
      removeMember(deps, A, request(fixedId(1))),
    ).rejects.toMatchObject({
      code: 'CANNOT_REMOVE_SELF',
    });
    await expect(
      removeMember(deps, A, request(fixedId(77))),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      removeMember(deps, A, { budget_id: BUDGET }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(Object.keys(await activeRoles(adminDb(), BUDGET)).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('cannot remove a member of another budget or an already removed member', async () => {
    await seed();
    const other = fixedId(901);
    await seedBudgetDirect(adminDb(), other, [
      { uid: 'x', membershipId: fixedId(10), role: 'ADMIN' },
    ]);
    const deps = testDeps();

    await expect(
      removeMember(deps, A, { budget_id: BUDGET, membership_id: fixedId(10) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      removeMember(deps, A, { budget_id: other, membership_id: fixedId(10) }),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });

    await removeMember(deps, A, {
      budget_id: BUDGET,
      membership_id: fixedId(2),
    });
    await expect(
      removeMember(deps, A, { budget_id: BUDGET, membership_id: fixedId(2) }),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });
    expect(await activeRoles(adminDb(), other)).toEqual({ x: 'ADMIN' });
  });
});

describe('removing the last member deletes the budget (I-FR-09, I-TR-09)', () => {
  beforeEach(clearFirestore);

  async function seedFull() {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
    ]);
    await seedBudgetDirect(db, fixedId(901), [
      { uid: 'x', membershipId: fixedId(10), role: 'ADMIN' },
    ]);
    await db.doc(`budget_records/${BUDGET}/items/t1`).set({ amount: '1.0000' });
    await db
      .doc(`budget_records/${fixedId(901)}/items/t2`)
      .set({ amount: '2.0000' });
    await db.doc('invitations/inv-1').set({
      budget_id: BUDGET,
      token_hash: 'h'.repeat(64),
      status: 'PENDING',
    });
    await db.doc(`invitation_tokens/${'h'.repeat(64)}`).set({
      invitation_id: 'inv-1',
      budget_id: BUDGET,
    });
  }

  it('deletes the budget and all of its data but nothing else', async () => {
    await seedFull();
    const result = await leaveBudget(testDeps(), A, BUDGET);
    const db = adminDb();

    expect(result).toEqual({ budget_deleted: true, cleanup_pending: false });
    expect((await db.doc(`budgets/${BUDGET}`).get()).exists).toBe(false);
    expect(await countDocs(db, `budgets/${BUDGET}/active_members`)).toBe(0);
    expect(await countDocs(db, `budget_records/${BUDGET}/items`)).toBe(0);
    expect((await db.doc(`memberships/${fixedId(1)}`).get()).exists).toBe(
      false,
    );
    expect((await db.doc('invitations/inv-1').get()).exists).toBe(false);
    expect(
      (await db.doc(`invitation_tokens/${'h'.repeat(64)}`).get()).exists,
    ).toBe(false);
    expect((await db.doc(`budget_purge_queue/${BUDGET}`).get()).exists).toBe(
      false,
    );

    expect((await db.doc(`budgets/${fixedId(901)}`).get()).exists).toBe(true);
    expect(await countDocs(db, `budget_records/${fixedId(901)}/items`)).toBe(1);
    expect((await db.doc(`memberships/${fixedId(10)}`).get()).exists).toBe(
      true,
    );
  });

  it('refuses to purge a budget that still has active members', async () => {
    await seedFull();
    await expect(purgeBudgetData(testDeps(), BUDGET)).rejects.toMatchObject({
      code: 'BUDGET_HAS_ACTIVE_MEMBERS',
    });
    expect((await adminDb().doc(`budgets/${BUDGET}`).get()).exists).toBe(true);
    expect(await countDocs(adminDb(), `budget_records/${BUDGET}/items`)).toBe(
      1,
    );
  });

  it('can finish an interrupted deletion from the purge marker', async () => {
    await seedFull();
    const deps = testDeps();
    // Phase one only: simulates a crash before the cleanup phase ran.
    await deps.db.runTransaction((tx) =>
      leaveInTransaction(deps, tx, BUDGET, 'a', { anonymize: false }),
    );
    const db = adminDb();
    expect((await db.doc(`budgets/${BUDGET}`).get()).exists).toBe(false);
    expect((await db.doc(`budget_purge_queue/${BUDGET}`).get()).exists).toBe(
      true,
    );
    expect(await countDocs(db, `budget_records/${BUDGET}/items`)).toBe(1);

    expect(await purgePendingBudgets(deps)).toEqual({
      purged: [BUDGET],
      failed: [],
    });
    expect(await countDocs(db, `budget_records/${BUDGET}/items`)).toBe(0);
    expect(await countDocs(db, 'budget_purge_queue')).toBe(0);
    expect(await purgePendingBudgets(deps)).toEqual({ purged: [], failed: [] });
  });
});

describe('simultaneous departures (I-FR-07)', () => {
  beforeEach(clearFirestore);

  it('handles the same admin leaving twice at once', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2), joinedAt: '2026-02-01T00:00:00Z' },
      { uid: 'c', membershipId: fixedId(3), joinedAt: '2026-03-01T00:00:00Z' },
    ]);
    const deps = testDeps();
    const results = await Promise.allSettled([
      leaveBudget(deps, A, BUDGET),
      leaveBudget(deps, A, BUDGET),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(failure?.reason).toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });
    expect(await activeRoles(db, BUDGET)).toEqual({ b: 'ADMIN', c: 'MEMBER' });
  });

  it('keeps exactly one admin when the admin and the designated successor leave together', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2), joinedAt: '2026-02-01T00:00:00Z' },
      { uid: 'c', membershipId: fixedId(3), joinedAt: '2026-03-01T00:00:00Z' },
    ]);
    const deps = testDeps();
    const results = await Promise.allSettled([
      leaveBudget(deps, A, BUDGET),
      leaveBudget(deps, B, BUDGET),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await activeRoles(db, BUDGET)).toEqual({ c: 'ADMIN' });
    await expectSingleAdmin(BUDGET);
    const statuses = await db.collection('memberships').get();
    expect(statuses.docs.map((doc) => doc.get('status')).sort()).toEqual([
      'ACTIVE',
      'LEFT',
      'LEFT',
    ]);
  });

  it('deletes the budget exactly once when every member leaves at the same time', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2), joinedAt: '2026-02-01T00:00:00Z' },
      { uid: 'c', membershipId: fixedId(3), joinedAt: '2026-03-01T00:00:00Z' },
    ]);
    const deps = testDeps();
    const results = await Promise.allSettled([
      leaveBudget(deps, A, BUDGET),
      leaveBudget(deps, B, BUDGET),
      leaveBudget(deps, C, BUDGET),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const deleted = results.filter(
      (r) => r.status === 'fulfilled' && r.value.budget_deleted,
    );
    expect(deleted).toHaveLength(1);
    expect((await db.doc(`budgets/${BUDGET}`).get()).exists).toBe(false);
    expect(await countDocs(db, 'memberships')).toBe(0);
    expect(await countDocs(db, 'budget_purge_queue')).toBe(0);
  });

  it('lets a removal and the removed member leaving race safely', async () => {
    const db = adminDb();
    await seedBudgetDirect(db, BUDGET, [
      { uid: 'a', membershipId: fixedId(1), role: 'ADMIN' },
      { uid: 'b', membershipId: fixedId(2) },
    ]);
    const deps = testDeps();
    const results = await Promise.allSettled([
      removeMember(deps, A, { budget_id: BUDGET, membership_id: fixedId(2) }),
      leaveBudget(deps, B, BUDGET),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await activeRoles(db, BUDGET)).toEqual({ a: 'ADMIN' });
  });
});
