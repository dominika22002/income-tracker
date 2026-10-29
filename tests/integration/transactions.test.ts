import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/server/accounts';
import { archiveCategory, saveCategory } from '../../src/server/categories';
import { saveCategorizationRule } from '../../src/server/categorization';
import { createBudget } from '../../src/server/budgets';
import { saveTransaction } from '../../src/server/transactions';
import { DomainError } from '../../src/shared/domain/errors';
import { adminDb, clearFirestore, testDeps } from './helpers';

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
});
