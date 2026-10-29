import { describe, expect, it } from 'vitest';
import type { TransactionView } from '../../src/shared/contracts';
import {
  hiddenUntilForPreset,
  isHiddenFromViewer,
  isSplitValid,
  isTransactionHidden,
  remainingSplitAmount,
  splitItemsInSourceCurrency,
  transactionLinesForExport,
  transactionLinesForReporting,
  transactionsVisibleToMember,
} from '../../src/shared/domain/transactionFeatures';
import {
  validateSaveTransactionSplitRequest,
  validateSetTransactionHiddenRequest,
} from '../../src/shared/validators';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const CATEGORY = '00000000-0000-4000-8000-000000000003';

function transaction(
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    transaction_id: '00000000-0000-4000-8000-000000000004',
    budget_id: '00000000-0000-4000-8000-000000000005',
    account_id: '00000000-0000-4000-8000-000000000006',
    account_label: 'Synthetic account',
    account_owner_membership_id: OWNER,
    import_batch_id: null,
    imported_by_membership_id: null,
    bank_transaction_id: null,
    operation_date: '2026-03-01',
    description: 'Synthetic confidential purchase',
    amount: '100.0000',
    currency: 'EUR',
    type: 'EXPENSE',
    category_id: CATEGORY,
    category_name: 'Synthetic category',
    note: 'Synthetic confidential note',
    tags: ['private-tag'],
    ...overrides,
  };
}

const splitItems = [
  {
    amount: '35.1250',
    category_id: CATEGORY,
    expense_frequency: 'RECURRING' as const,
    description: 'Synthetic groceries',
    note: null,
  },
  {
    amount: '64.8750',
    category_id: CATEGORY,
    expense_frequency: null,
    description: null,
    note: 'Synthetic receipt item',
  },
];

describe('transaction split and hiding domain (U-FR-30…34, U-FR-50…54, U-TR-18)', () => {
  it('calculates remaining amounts with exact decimal units and rejects unequal totals', () => {
    expect(remainingSplitAmount('100', splitItems)).toBe('0.0000');
    expect(isSplitValid('100.0000', splitItems)).toBe(true);
    expect(
      remainingSplitAmount('100.0000', [
        ...splitItems.slice(0, 1),
        { ...splitItems[1], amount: '64.8749' },
      ]),
    ).toBe('0.0001');
    expect(
      isSplitValid('100.0000', [
        ...splitItems.slice(0, 1),
        { ...splitItems[1], amount: '64.8749' },
      ]),
    ).toBe(false);
    expect(isSplitValid('100', splitItems.slice(0, 1))).toBe(false);
    expect(remainingSplitAmount('bad', splitItems)).toBeNull();
  });

  it('validates optional fields, frequencies and custom hidden timestamps', () => {
    expect(
      validateSaveTransactionSplitRequest({
        budget_id: transaction().budget_id,
        transaction_id: transaction().transaction_id,
        items: [
          { amount: '35.00', category_id: CATEGORY },
          { amount: '65.00', category_id: CATEGORY },
        ],
      }),
    ).toMatchObject({
      items: [
        { description: null, note: null, expense_frequency: null },
        { description: null, note: null, expense_frequency: null },
      ],
    });
    expect(
      validateSaveTransactionSplitRequest({
        budget_id: transaction().budget_id,
        transaction_id: transaction().transaction_id,
        items: [
          {
            amount: '35.00',
            category_id: CATEGORY,
            expense_frequency: 'YEARLY',
          },
          { amount: '65.00', category_id: CATEGORY },
        ],
      }),
    ).toBeNull();
    expect(
      validateSetTransactionHiddenRequest({
        budget_id: transaction().budget_id,
        transaction_id: transaction().transaction_id,
        hidden_mode: 'DESCRIPTION',
        hidden_until: '2026-03-01T12:00:00+02:00',
      }),
    ).not.toBeNull();
    expect(
      validateSetTransactionHiddenRequest({
        budget_id: transaction().budget_id,
        transaction_id: transaction().transaction_id,
        hidden_mode: 'DESCRIPTION',
        hidden_until: '2026-03-01T12:00',
      }),
    ).toBeNull();
  });

  it('inherits source currency and reports split lines instead of the source amount', () => {
    const splitView = splitItems.map((item, index) => ({
      ...item,
      split_item_id: `split-${index}`,
      budget_id: transaction().budget_id,
      transaction_id: transaction().transaction_id,
      position: index,
    }));
    expect(splitItemsInSourceCurrency(splitView, 'EUR')).toEqual(
      splitView.map((item) => ({ ...item, currency: 'EUR' })),
    );
    expect(
      transactionLinesForReporting([transaction({ split_items: splitView })]),
    ).toMatchObject([
      { amount: '35.1250', currency: 'EUR', split_item_id: 'split-0' },
      { amount: '64.8750', currency: 'EUR', split_item_id: 'split-1' },
    ]);
    expect(
      transactionLinesForReporting([transaction()]).map((line) => line.amount),
    ).toEqual(['100.0000']);
  });

  it('hides details from other members, keeps author access and expires at the exact instant', () => {
    const hidden = transaction({
      hidden_mode: 'DESCRIPTION',
      hidden_until: '2026-03-01T12:00:00+02:00',
      hidden_by_membership_id: OWNER,
      split_items: splitItems.map((item, index) => ({
        ...item,
        split_item_id: `split-${index}`,
        budget_id: transaction().budget_id,
        transaction_id: transaction().transaction_id,
        position: index,
      })),
    });
    const before = new Date('2026-03-01T09:59:59Z');
    const expiry = new Date('2026-03-01T10:00:00Z');
    expect(isHiddenFromViewer(hidden, OTHER, before)).toBe(true);
    expect(
      isTransactionHidden('DESCRIPTION', hidden.hidden_until, expiry),
    ).toBe(false);
    expect(isTransactionHidden('TRANSACTION', null, expiry)).toBe(true);
    expect(
      transactionsVisibleToMember([hidden], OWNER, before)[0].description,
    ).toBe('Synthetic confidential purchase');
    const otherView = transactionsVisibleToMember([hidden], OTHER, before)[0];
    expect(otherView.description).toBe('Opis ukryty');
    expect(otherView.note).toBeNull();
    expect(otherView.tags).toEqual([]);
    expect(otherView.split_items?.[0].description).toBeNull();
    expect(JSON.stringify(otherView)).not.toContain('Synthetic confidential');
    expect(
      transactionsVisibleToMember([hidden], OTHER, expiry)[0].description,
    ).toBe('Synthetic confidential purchase');
  });

  it('excludes hidden rows from export while preserving split amounts in reports', () => {
    const items = splitItems.map((item, index) => ({
      ...item,
      split_item_id: `split-${index}`,
      budget_id: transaction().budget_id,
      transaction_id: transaction().transaction_id,
      position: index,
    }));
    const hiddenDescription = transaction({
      split_items: items,
      hidden_mode: 'DESCRIPTION',
      hidden_until: null,
      hidden_by_membership_id: OWNER,
    });
    const hiddenRow = transaction({
      transaction_id: '00000000-0000-4000-8000-000000000007',
      hidden_mode: 'TRANSACTION',
      hidden_until: null,
      hidden_by_membership_id: OWNER,
      split_items: items.map((item) => ({
        ...item,
        transaction_id: '00000000-0000-4000-8000-000000000007',
      })),
    });
    const all = [hiddenDescription, hiddenRow];
    const now = new Date('2026-03-01T10:00:00Z');
    const exported = transactionLinesForExport(all, OTHER, now);
    expect(exported).toHaveLength(3);
    expect(exported.slice(0, 2).map((line) => line.amount)).toEqual([
      '35.1250',
      '64.8750',
    ]);
    expect(
      exported.slice(0, 2).every((line) => line.description === 'Opis ukryty'),
    ).toBe(true);
    expect(exported[2]).toMatchObject({
      amount: '',
      currency: '',
      category_id: null,
      category_name: null,
      operation_date: '',
      description: 'Transakcja ukryta',
      hidden: true,
    });
    expect(JSON.stringify(exported)).not.toContain('Synthetic confidential');
    expect(transactionLinesForReporting(all)).toHaveLength(4);
  });

  it('uses calendar-based preset durations with month-end clamping', () => {
    const start = new Date('2026-01-31T22:30:00Z');
    expect(hiddenUntilForPreset(start, 'DAY').toISOString()).toBe(
      '2026-02-01T22:30:00.000Z',
    );
    expect(hiddenUntilForPreset(start, 'WEEK').toISOString()).toBe(
      '2026-02-07T22:30:00.000Z',
    );
    expect(hiddenUntilForPreset(start, 'MONTH').toISOString()).toBe(
      '2026-02-28T22:30:00.000Z',
    );
  });
});
