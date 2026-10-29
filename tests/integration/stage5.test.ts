import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/server/accounts';
import { saveAccountBalance } from '../../src/server/balances';
import { getTransactionConversions } from '../../src/server/conversions';
import { createBudget } from '../../src/server/budgets';
import { ensureUserProfile, updatePreferences } from '../../src/server/profile';
import { reviewTransfer } from '../../src/server/transfers';
import { saveTransaction } from '../../src/server/transactions';
import { adminDb, clearFirestore, testDeps } from './helpers';

const user = {
  uid: 'stage5-synthetic-user',
  email: 'stage5-synthetic-user@example.test',
  displayName: 'Synthetic Stage 5 User',
};

describe('Stage 5 currency, transfer and balance services', () => {
  beforeEach(clearFirestore);

  async function setup() {
    const deps = testDeps();
    const budget = await createBudget(deps, user, {
      name: 'Synthetic Stage 5 budget',
    });
    const account = await createAccount(deps, user, {
      budget_id: budget.budget_id,
      label: 'Synthetic EUR account',
      currency: 'EUR',
      account_type: 'SAVINGS',
    });
    return { deps, budget, account };
  }

  it('stores exact conversions and ECB rates, reports unsupported currencies, and preserves source values', async () => {
    const { deps, budget, account } = await setup();
    await ensureUserProfile(deps, user);
    await updatePreferences(deps, user, {
      primary_currency: 'CHF',
      secondary_currencies: ['PLN', 'EUR'],
    });
    const transaction = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic conversion fixture',
      amount: '12.3456',
      currency: 'EUR',
      type: 'EXPENSE',
    });

    const result = await getTransactionConversions(deps, user, {
      budget_id: budget.budget_id,
      transaction_id: transaction.transaction_id,
    });

    expect(result.conversions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_currency: 'CHF',
          rate_used: '0.9123456789',
          rate_date: '2026-03-09',
          converted_amount: '11.26345481342784',
          display_amount: '11.26',
        }),
        expect.objectContaining({
          target_currency: 'EUR',
          rate_used: '1',
          rate_date: '2026-03-10',
          converted_amount: '12.3456',
          display_amount: '12.35',
        }),
      ]),
    );
    expect(result.unavailable_currencies).toEqual(['PLN']);
    const db = adminDb();
    const savedTransaction = await db
      .doc(`transactions/${transaction.transaction_id}`)
      .get();
    expect(savedTransaction.data()).toMatchObject({
      amount: '12.3456',
      currency: 'EUR',
    });
    expect(
      (await db.collection('exchange_rates').get()).docs.map((rate) =>
        rate.data(),
      ),
    ).toEqual([
      expect.objectContaining({
        base_currency: 'EUR',
        quote_currency: 'CHF',
        rate_date: '2026-03-09',
        provider: 'ECB',
      }),
    ]);
    expect((await db.collection('transaction_conversions').get()).size).toBe(2);
  });

  it('upserts a dated manual balance and keeps source, currency and latest balance per account', async () => {
    const { deps, budget, account } = await setup();
    const first = await saveAccountBalance(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      balance_date: '2026-03-01',
      balance_amount: '100.2500',
      currency: 'EUR',
    });
    await saveAccountBalance(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      balance_date: '2026-03-01',
      balance_amount: '101.0000',
      currency: 'EUR',
    });
    const later = await saveAccountBalance(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      balance_date: '2026-03-04',
      balance_amount: '120.0000',
      currency: 'EUR',
    });

    const db = adminDb();
    const snapshots = await db
      .collection('account_balance_snapshots')
      .where('account_id', '==', account.account_id)
      .get();
    expect(snapshots.size).toBe(2);
    expect(
      (
        await db.doc(`account_balance_snapshots/${first.snapshot_id}`).get()
      ).data(),
    ).toMatchObject({
      balance_amount: '101.0000',
      balance_date: '2026-03-01',
      currency: 'EUR',
      source: 'MANUAL',
    });
    expect(
      (
        await db.doc(`account_balance_snapshots/${later.snapshot_id}`).get()
      ).get('balance_date'),
    ).toBe('2026-03-04');
  });

  it('confirms a corrected transfer pair atomically and persists bank fees and FX differences as expenses', async () => {
    const { deps, budget, account } = await setup();
    const incomingAccount = await createAccount(deps, user, {
      budget_id: budget.budget_id,
      label: 'Synthetic CHF account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const outgoing = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic transfer out',
      amount: '20.00',
      currency: 'EUR',
      type: 'EXPENSE',
    });
    const incoming = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: incomingAccount.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic transfer in',
      amount: '17.00',
      currency: 'CHF',
      type: 'INCOME',
    });
    await adminDb()
      .doc(`transactions/${outgoing.transaction_id}`)
      .update({ fee: '0.3000' });

    const result = await reviewTransfer(deps, user, {
      budget_id: budget.budget_id,
      decision: 'CONFIRM_PAIR',
      outgoing_transaction_id: outgoing.transaction_id,
      incoming_transaction_id: incoming.transaction_id,
    });

    const db = adminDb();
    expect(result.status).toBe('CONFIRMED');
    expect(
      (await db.doc(`transactions/${outgoing.transaction_id}`).get()).data(),
    ).toMatchObject({
      type: 'TRANSFER',
      transfer_leg: 'OUTGOING',
      amount: '20.00',
    });
    expect(
      (await db.doc(`transactions/${incoming.transaction_id}`).get()).data(),
    ).toMatchObject({
      type: 'TRANSFER',
      transfer_leg: 'INCOMING',
      amount: '17.00',
    });
    const expenses = await db
      .collection('transactions')
      .where('transfer_group_id', '==', result.transfer_group_id)
      .where('type', '==', 'EXPENSE')
      .get();
    expect(
      expenses.docs.map((expense) => expense.get('amount')).sort(),
    ).toEqual(['0.3000', '1.385'].sort());
  });

  it('keeps rejected suggestions unclassified and requires explicit confirmation for a one-sided transfer', async () => {
    const { deps, budget, account } = await setup();
    const rejectedOut = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic rejected transfer',
      amount: '5.00',
      currency: 'EUR',
      type: 'EXPENSE',
    });
    const rejectedIn = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: (
        await createAccount(deps, user, {
          budget_id: budget.budget_id,
          label: 'Synthetic other',
          currency: 'EUR',
          account_type: 'CHECKING',
        })
      ).account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic rejected transfer',
      amount: '5.00',
      currency: 'EUR',
      type: 'INCOME',
    });
    await reviewTransfer(deps, user, {
      budget_id: budget.budget_id,
      decision: 'REJECT',
      outgoing_transaction_id: rejectedOut.transaction_id,
      incoming_transaction_id: rejectedIn.transaction_id,
    });
    expect(
      (
        await adminDb().doc(`transactions/${rejectedOut.transaction_id}`).get()
      ).get('type'),
    ).toBe('EXPENSE');

    const single = await saveTransaction(deps, user, {
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-12',
      description: 'Synthetic one-sided transfer',
      amount: '7.00',
      currency: 'EUR',
      type: 'EXPENSE',
    });
    const result = await reviewTransfer(deps, user, {
      budget_id: budget.budget_id,
      decision: 'CONFIRM_UNPAIRED',
      transaction_id: single.transaction_id,
    });
    expect(result.status).toBe('CONFIRMED_UNPAIRED');
    expect(
      (
        await adminDb().doc(`transactions/${single.transaction_id}`).get()
      ).data(),
    ).toMatchObject({ type: 'TRANSFER', transfer_leg: 'OUTGOING' });
  });
});
