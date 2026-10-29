import { describe, expect, it } from 'vitest';
import type { TransactionView } from '../../src/shared/contracts';
import {
  latestBalancePerAccount,
  suggestTransferPairs,
} from '../../src/shared/domain/transfers';

function transaction(
  transaction_id: string,
  account_id: string,
  type: TransactionView['type'],
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    transaction_id,
    budget_id: 'budget-1',
    account_id,
    account_label: account_id,
    account_owner_membership_id: 'member-1',
    import_batch_id: null,
    imported_by_membership_id: null,
    bank_transaction_id: null,
    operation_date: '2026-03-10',
    description: 'Synthetic transfer',
    amount: '25.00',
    currency: 'CHF',
    type,
    category_id: null,
    category_name: null,
    note: null,
    tags: [],
    ...overrides,
  };
}

describe('transfer suggestions (U-FR-39, U-FR-40, U-FR-41)', () => {
  it('suggests a one-to-one same-currency pair without changing classification', () => {
    const values = [
      transaction('out', 'account-a', 'EXPENSE'),
      transaction('in', 'account-b', 'INCOME', {
        account_owner_membership_id: 'member-2',
      }),
    ];
    expect(suggestTransferPairs(values)).toEqual([
      {
        outgoing_transaction_id: 'out',
        incoming_transaction_id: 'in',
        days_apart: 0,
        cross_currency: false,
      },
    ]);
    expect(values.map((item) => item.type)).toEqual(['EXPENSE', 'INCOME']);
  });

  it('allows different currencies but rejects amount, date, account and text mismatches', () => {
    expect(
      suggestTransferPairs([
        transaction('out', 'a', 'EXPENSE', { currency: 'CHF' }),
        transaction('in', 'b', 'INCOME', { currency: 'EUR', amount: '24.01' }),
      ]),
    ).toHaveLength(1);
    expect(
      suggestTransferPairs([
        transaction('out', 'a', 'EXPENSE'),
        transaction('in', 'b', 'INCOME', { amount: '24.99' }),
      ]),
    ).toHaveLength(0);
    expect(
      suggestTransferPairs([
        transaction('out', 'a', 'EXPENSE'),
        transaction('in', 'a', 'INCOME'),
      ]),
    ).toHaveLength(0);
    expect(
      suggestTransferPairs([
        transaction('out', 'a', 'EXPENSE'),
        transaction('in', 'b', 'INCOME', {
          operation_date: '2026-03-14',
        }),
      ]),
    ).toHaveLength(0);
  });

  it('does not suggest hidden, already-linked, or other-budget transactions', () => {
    expect(
      suggestTransferPairs([
        transaction('out', 'a', 'EXPENSE', { hidden_for_viewer: true }),
        transaction('in', 'b', 'INCOME'),
      ]),
    ).toHaveLength(0);
    expect(
      suggestTransferPairs([
        transaction('out', 'a', 'EXPENSE', { transfer_group_id: 'group' }),
        transaction('in', 'b', 'INCOME'),
      ]),
    ).toHaveLength(0);
  });
});

describe('account balances (U-FR-48)', () => {
  it('selects the newest snapshot independently for each account', () => {
    const latest = latestBalancePerAccount([
      {
        account_id: 'a',
        snapshot_id: 'a-old',
        balance_date: '2026-03-01',
        amount: '10.00',
      },
      {
        account_id: 'a',
        snapshot_id: 'a-new',
        balance_date: '2026-03-05',
        amount: '12.00',
      },
      {
        account_id: 'b',
        snapshot_id: 'b-only',
        balance_date: '2026-03-02',
        amount: '20.00',
      },
    ]);
    expect(latest.get('a')?.amount).toBe('12.00');
    expect(latest.get('b')?.amount).toBe('20.00');
  });
});
