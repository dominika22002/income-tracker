import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/server/accounts';
import { createBudget } from '../../src/server/budgets';
import { getTransactionConversions } from '../../src/server/conversions';
import { saveCategory } from '../../src/server/categories';
import { ensureUserProfile, updatePreferences } from '../../src/server/profile';
import { saveSpendingLimit } from '../../src/server/spendingLimits';
import { saveTransaction } from '../../src/server/transactions';
import { adminDb, clearFirestore, testDeps } from './helpers';

const user = {
  uid: 'stage6-synthetic-user',
  email: 'stage6-synthetic-user@example.test',
  displayName: 'Synthetic Stage 6 User',
};

describe('Stage 6 budget reporting data', () => {
  beforeEach(clearFirestore);

  it('persists expense nature, transaction frequency and monthly limits', async () => {
    const deps = testDeps();
    const budget = await createBudget(deps, user, {
      name: 'Synthetic Stage 6 budget',
    });
    const account = await createAccount(deps, user, {
      budget_id: budget.budget_id,
      label: 'Synthetic CHF account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const category = await saveCategory(deps, user, {
      budget_id: budget.budget_id,
      name: 'Synthetic fixed expense',
      kind: 'EXPENSE',
      expense_nature: 'FIXED',
      sort_order: 0,
    });
    const transaction = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic recurring expense',
      amount: '12.5000',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: category.category_id,
      expense_frequency: 'RECURRING',
    });
    await saveSpendingLimit(deps, user, {
      budget_id: budget.budget_id,
      limit_scope: 'CATEGORY',
      category_id: category.category_id,
      period: 'MONTH',
      limit_amount: '100.0000',
      currency: 'CHF',
    });

    const db = adminDb();
    expect(
      (await db.doc(`categories/${category.category_id}`).get()).data(),
    ).toMatchObject({ expense_nature: 'FIXED', kind: 'EXPENSE' });
    expect(
      (await db.doc(`transactions/${transaction.transaction_id}`).get()).data(),
    ).toMatchObject({
      expense_frequency: 'RECURRING',
      category_id: category.category_id,
    });
    expect(
      (
        await db
          .collection('spending_limits')
          .where('budget_id', '==', budget.budget_id)
          .get()
      ).docs.map((limit) => limit.data()),
    ).toEqual([
      expect.objectContaining({
        limit_scope: 'CATEGORY',
        category_id: category.category_id,
        period: 'MONTH',
        limit_amount: '100.0000',
        currency: 'CHF',
      }),
    ]);
  });

  it('persists an explicitly requested conversion to a limit/report currency', async () => {
    const deps = testDeps();
    const budget = await createBudget(deps, user, {
      name: 'Synthetic Stage 6 conversion budget',
    });
    const account = await createAccount(deps, user, {
      budget_id: budget.budget_id,
      label: 'Synthetic EUR account',
      currency: 'EUR',
      account_type: 'CHECKING',
    });
    await ensureUserProfile(deps, user);
    await updatePreferences(deps, user, {
      primary_currency: 'CHF',
      secondary_currencies: [],
    });
    const transaction = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic foreign expense',
      amount: '12.3456',
      currency: 'EUR',
      type: 'EXPENSE',
    });

    const result = await getTransactionConversions(deps, user, {
      budget_id: budget.budget_id,
      transaction_id: transaction.transaction_id,
      target_currency: 'CHF',
    });

    expect(result.unavailable_currencies).toEqual([]);
    expect(result.conversions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_currency: 'CHF',
          rate_used: '0.9123456789',
          converted_amount: '11.26345481342784',
        }),
      ]),
    );
    expect(
      (await adminDb().collection('transaction_conversions').get()).docs.map(
        (conversion) => conversion.get('target_currency'),
      ),
    ).toContain('CHF');
  });
});
