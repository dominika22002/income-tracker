import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/server/accounts';
import { archiveCategory, saveCategory } from '../../src/server/categories';
import { saveCategorizationRule } from '../../src/server/categorization';
import { createBudget } from '../../src/server/budgets';
import {
  deleteTransactionSplit,
  saveTransaction,
  saveTransactionSplit,
  setTransactionHidden,
} from '../../src/server/transactions';
import {
  acceptInvitation,
  createInvitation,
} from '../../src/server/invitations';
import { leaveBudget } from '../../src/server/memberships';
import { DomainError } from '../../src/shared/domain/errors';
import { isTransactionHidden } from '../../src/shared/domain/transactionFeatures';
import {
  adminDb,
  clearFirestore,
  failingDb,
  testDeps,
  TestClock,
} from './helpers';

const alice = {
  uid: 'transactions-alice',
  email: 'transactions-alice@example.test',
  displayName: 'Test Alice',
};
const bob = {
  uid: 'transactions-bob',
  email: 'transactions-bob@example.test',
  displayName: 'Test Bob',
};

describe('transaction and category services (I-FR-20, I-FR-24…29, I-FR-35…37)', () => {
  beforeEach(clearFirestore);

  async function setup() {
    const deps = testDeps();
    const budget = await createBudget(deps, alice, {
      name: 'Synthetic transactions',
    });
    const account = await createAccount(deps, alice, {
      budget_id: budget.budget_id,
      label: 'Synthetic account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const category = await saveCategory(deps, alice, {
      budget_id: budget.budget_id,
      name: 'Synthetic groceries',
      kind: 'EXPENSE',
      sort_order: 0,
    });
    return { deps, budget, account, category };
  }

  it('saves and edits a manual transaction, note and labels while retaining the source amount and links', async () => {
    const { deps, budget, account, category } = await setup();
    const saved = await saveTransaction(deps, alice, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-04',
      description: 'Synthetic household purchase',
      amount: '123.4500',
      currency: 'EUR',
      type: 'EXPENSE',
      category_id: category.category_id,
      note: 'Reviewed locally',
      tags: ['Synthetic', 'monthly'],
    });
    const db = adminDb();
    const transactionRef = db.doc(`transactions/${saved.transaction_id}`);
    expect((await transactionRef.get()).data()).toMatchObject({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      import_batch_id: null,
      bank_transaction_id: null,
      operation_date: '2026-03-04',
      description: 'Synthetic household purchase',
      amount: '123.4500',
      currency: 'EUR',
      type: 'EXPENSE',
      category_id: category.category_id,
      note: 'Reviewed locally',
      created_by_membership_id: budget.membership_id,
    });

    await saveTransaction(deps, alice, {
      transaction_id: saved.transaction_id,
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-05',
      description: 'Synthetic household purchase corrected',
      amount: '124.0000',
      currency: 'EUR',
      type: 'EXPENSE',
      category_id: category.category_id,
      note: null,
      tags: ['corrected'],
    });
    const edited = (await transactionRef.get()).data();
    expect(edited).toMatchObject({
      account_id: account.account_id,
      import_batch_id: null,
      bank_transaction_id: null,
      amount: '124.0000',
      currency: 'EUR',
      note: null,
    });
    const links = await db
      .collection('transaction_tags')
      .where('transaction_id', '==', saved.transaction_id)
      .get();
    expect(links.size).toBe(1);
    const label = await db
      .doc(`tags/${links.docs[0].get('tag_id') as string}`)
      .get();
    expect(label.data()).toMatchObject({
      budget_id: budget.budget_id,
      name: 'corrected',
    });
  });

  it('automatically applies explicit active rules but accepts a manual category correction', async () => {
    const { deps, budget, account } = await setup();
    const automatic = await saveCategory(deps, alice, {
      budget_id: budget.budget_id,
      name: 'Synthetic transport',
      kind: 'EXPENSE',
      sort_order: 1,
    });
    const manual = await saveCategory(deps, alice, {
      budget_id: budget.budget_id,
      name: 'Synthetic other',
      kind: 'EXPENSE',
      sort_order: 2,
    });
    const rule = await saveCategorizationRule(deps, alice, {
      budget_id: budget.budget_id,
      category_id: automatic.category_id,
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'local ride',
      priority: 10,
    });
    const saved = await saveTransaction(deps, alice, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-06',
      description: 'Synthetic local ride',
      amount: '8.00',
      currency: 'CHF',
      type: 'EXPENSE',
    });
    const db = adminDb();
    expect(
      (await db.doc(`transactions/${saved.transaction_id}`).get()).get(
        'category_id',
      ),
    ).toBe(automatic.category_id);

    await saveTransaction(deps, alice, {
      transaction_id: saved.transaction_id,
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-06',
      description: 'Synthetic local ride',
      amount: '8.00',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: manual.category_id,
    });
    expect(
      (await db.doc(`transactions/${saved.transaction_id}`).get()).get(
        'category_id',
      ),
    ).toBe(manual.category_id);
    expect(
      (await db.doc(`categorization_rules/${rule.rule_id}`).get()).get(
        'source',
      ),
    ).toBe('USER');
  });

  it('archives rather than deletes a historical category and disables its rules', async () => {
    const { deps, budget, account, category } = await setup();
    const rule = await saveCategorizationRule(deps, alice, {
      budget_id: budget.budget_id,
      category_id: category.category_id,
      match_field: 'AMOUNT',
      operator: 'EQUALS',
      match_value: '5.00',
      priority: 1,
    });
    const saved = await saveTransaction(deps, alice, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-07',
      description: 'Synthetic archived category',
      amount: '5.00',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: category.category_id,
    });
    await archiveCategory(deps, alice, {
      budget_id: budget.budget_id,
      category_id: category.category_id,
    });
    const db = adminDb();
    expect(
      (await db.doc(`categories/${category.category_id}`).get()).get(
        'archived_at',
      ),
    ).toBeTruthy();
    expect(
      (await db.doc(`transactions/${saved.transaction_id}`).get()).get(
        'category_id',
      ),
    ).toBe(category.category_id);
    expect(
      (await db.doc(`categorization_rules/${rule.rule_id}`).get()).get(
        'enabled',
      ),
    ).toBe(false);
  });

  it('rejects account, category and membership links from another budget and unauthenticated writes', async () => {
    const { deps, budget, account, category } = await setup();
    const foreignBudget = await createBudget(deps, bob, {
      name: 'Other synthetic budget',
    });
    const foreignAccount = await createAccount(deps, bob, {
      budget_id: foreignBudget.budget_id,
      label: 'Other synthetic account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const foreignCategory = await saveCategory(deps, bob, {
      budget_id: foreignBudget.budget_id,
      name: 'Other synthetic category',
      kind: 'EXPENSE',
      sort_order: 0,
    });
    const request = {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-08',
      description: 'Synthetic boundary test',
      amount: '1.00',
      currency: 'CHF',
      type: 'EXPENSE',
    };
    await expect(
      saveTransaction(deps, alice, {
        ...request,
        account_id: foreignAccount.account_id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      saveTransaction(deps, alice, {
        ...request,
        category_id: foreignCategory.category_id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      saveCategory(deps, alice, {
        budget_id: budget.budget_id,
        name: 'Invalid parent',
        parent_category_id: foreignCategory.category_id,
        kind: 'EXPENSE',
        sort_order: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(saveTransaction(deps, null, request)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      archiveCategory(deps, alice, {
        budget_id: foreignBudget.budget_id,
        category_id: category.category_id,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('saves, replaces and removes split items atomically without changing source amount or currency', async () => {
    const { deps, budget, account, category } = await setup();
    const saved = await saveTransaction(deps, alice, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-09',
      description: 'Synthetic split purchase',
      amount: '100.0000',
      currency: 'EUR',
      type: 'EXPENSE',
      category_id: category.category_id,
    });
    const initialSplit = {
      budget_id: budget.budget_id,
      transaction_id: saved.transaction_id,
      items: [
        {
          amount: '35.1250',
          category_id: category.category_id,
          expense_frequency: 'RECURRING' as const,
        },
        { amount: '64.8750', category_id: category.category_id },
      ],
    };
    await saveTransactionSplit(deps, alice, initialSplit);
    const db = adminDb();
    const sourceRef = db.doc(`transactions/${saved.transaction_id}`);
    const splitQuery = db
      .collection('split_items')
      .where('budget_id', '==', budget.budget_id)
      .where('transaction_id', '==', saved.transaction_id);
    let items = await splitQuery.get();
    expect(items.size).toBe(2);
    expect((await sourceRef.get()).data()).toMatchObject({
      amount: '100.0000',
      currency: 'EUR',
    });

    await expect(
      saveTransactionSplit(deps, alice, {
        ...initialSplit,
        items: [
          initialSplit.items[0],
          { ...initialSplit.items[1], amount: '64.8749' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      saveTransaction(deps, alice, {
        transaction_id: saved.transaction_id,
        budget_id: budget.budget_id,
        account_id: account.account_id,
        operation_date: '2026-03-09',
        description: 'Synthetic split purchase',
        amount: '101.0000',
        currency: 'EUR',
        type: 'EXPENSE',
        category_id: category.category_id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await splitQuery.get()).size).toBe(2);

    const failureDeps = testDeps(new TestClock(), failingDb(db, 2));
    await expect(
      saveTransactionSplit(failureDeps, alice, {
        ...initialSplit,
        items: [
          { amount: '40.0000', category_id: category.category_id },
          { amount: '60.0000', category_id: category.category_id },
        ],
      }),
    ).rejects.toThrow('Injected failure');
    items = await splitQuery.get();
    expect(items.size).toBe(2);
    expect(items.docs.map((item) => item.get('amount')).sort()).toEqual([
      '35.1250',
      '64.8750',
    ]);

    await saveTransactionSplit(deps, alice, {
      ...initialSplit,
      items: [
        { amount: '40.0000', category_id: category.category_id },
        {
          amount: '60.0000',
          category_id: category.category_id,
          description: 'Synthetic updated position',
          note: 'Synthetic updated note',
        },
      ],
    });
    items = await splitQuery.get();
    expect(items.docs.map((item) => item.get('amount')).sort()).toEqual([
      '40.0000',
      '60.0000',
    ]);
    expect(items.docs.some((item) => item.get('currency') === 'EUR')).toBe(
      false,
    );

    await deleteTransactionSplit(deps, alice, {
      budget_id: budget.budget_id,
      transaction_id: saved.transaction_id,
    });
    expect((await splitQuery.get()).empty).toBe(true);
    expect((await sourceRef.get()).data()).toMatchObject({
      amount: '100.0000',
      currency: 'EUR',
    });
  });

  it('keeps hidden transactions hidden after their author leaves and expires at the stored instant', async () => {
    const clock = new TestClock('2026-03-01T10:00:00.000Z');
    const deps = testDeps(clock);
    const budget = await createBudget(deps, alice, {
      name: 'Synthetic hidden transaction budget',
    });
    const account = await createAccount(deps, alice, {
      budget_id: budget.budget_id,
      label: 'Synthetic hidden account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const category = await saveCategory(deps, alice, {
      budget_id: budget.budget_id,
      name: 'Synthetic hidden category',
      kind: 'EXPENSE',
      sort_order: 0,
    });
    const saved = await saveTransaction(deps, alice, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-01',
      description: 'Synthetic surprise purchase',
      amount: '25.00',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: category.category_id,
    });
    const expiry = '2026-03-01T11:00:00.000Z';
    await setTransactionHidden(deps, alice, {
      budget_id: budget.budget_id,
      transaction_id: saved.transaction_id,
      hidden_mode: 'TRANSACTION',
      hidden_until: expiry,
    });
    const invitation = await createInvitation(deps, alice, {
      budget_id: budget.budget_id,
    });
    await acceptInvitation(deps, bob, invitation.token);
    await leaveBudget(deps, alice, budget.budget_id);

    const source = await adminDb()
      .doc(`transactions/${saved.transaction_id}`)
      .get();
    expect(source.get('hidden_by_membership_id')).toBe(budget.membership_id);
    expect(
      isTransactionHidden(
        source.get('hidden_mode'),
        source.get('hidden_until').toDate().toISOString(),
        new Date('2026-03-01T10:59:59.999Z'),
      ),
    ).toBe(true);
    await expect(
      setTransactionHidden(deps, bob, {
        budget_id: budget.budget_id,
        transaction_id: saved.transaction_id,
        hidden_mode: 'TRANSACTION',
        hidden_until: null,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    clock.set(expiry);
    expect(
      isTransactionHidden(
        source.get('hidden_mode'),
        source.get('hidden_until').toDate().toISOString(),
        clock.now(),
      ),
    ).toBe(false);
    expect(
      (await adminDb().doc(`transactions/${saved.transaction_id}`).get()).get(
        'hidden_by_membership_id',
      ),
    ).toBe(budget.membership_id);
  });
});
