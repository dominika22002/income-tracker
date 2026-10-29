import { describe, expect, it } from 'vitest';
import type { TransactionView } from '../../src/shared/contracts';
import {
  compareDecimalAmounts,
  filterAndSortTransactions,
  findMatchingUserRule,
  recordLocalCorrection,
  suggestAutomaticCategory,
  suggestLearnedCategory,
  type CategorizationCandidate,
} from '../../src/shared/domain/transactions';
import { validateSaveTransactionRequest } from '../../src/shared/validators';

const budgetId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';

function transaction(
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    transaction_id: '00000000-0000-4000-8000-000000000003',
    budget_id: budgetId,
    account_id: accountId,
    account_label: 'Konto testowe',
    account_owner_membership_id: '00000000-0000-4000-8000-000000000004',
    import_batch_id: null,
    imported_by_membership_id: null,
    bank_transaction_id: null,
    operation_date: '2026-03-01',
    description: 'Zakupy spożywcze',
    amount: '10.2500',
    currency: 'CHF',
    type: 'EXPENSE',
    category_id: null,
    category_name: null,
    note: null,
    tags: [],
    ...overrides,
  };
}

describe('transaction input and sorting', () => {
  it('requires source date, description, decimal amount, currency, account, budget and type', () => {
    const request = {
      budget_id: budgetId,
      account_id: accountId,
      operation_date: '2026-03-01',
      description: ' Syntetyczny zakup ',
      amount: '123456789012345.6789',
      currency: 'CHF',
      type: 'EXPENSE',
    };
    for (const type of ['EXPENSE', 'INCOME', 'TRANSFER'] as const) {
      expect(
        validateSaveTransactionRequest({ ...request, type }),
      ).toMatchObject({ ...request, type, description: 'Syntetyczny zakup' });
    }
    expect(
      validateSaveTransactionRequest({
        ...request,
        operation_date: '2026-02-30',
      }),
    ).toBeNull();
    expect(
      validateSaveTransactionRequest({ ...request, amount: '1.23456' }),
    ).toBeNull();
    expect(
      validateSaveTransactionRequest({ ...request, type: 'UNKNOWN' }),
    ).toBeNull();
    expect(
      validateSaveTransactionRequest({ ...request, currency: 'XX' }),
    ).toBeNull();
    expect(
      validateSaveTransactionRequest({ ...request, account_id: '' }),
    ).toBeNull();
  });

  it('compares decimal amounts without floating-point rounding', () => {
    expect(compareDecimalAmounts('1.1000', '1.1')).toBe(0);
    expect(
      compareDecimalAmounts('100000000000000.0001', '99999999999999.9999'),
    ).toBe(1);
    expect(compareDecimalAmounts('-0.0100', '0')).toBe(-1);
  });

  it('normalizes and combines search and filters before deterministic sorting', () => {
    const rows = [
      transaction({
        transaction_id: 'b',
        operation_date: '2026-03-02',
        description: 'Market',
        amount: '9.99',
        category_id: 'food',
        category_name: 'Jedzenie',
      }),
      transaction({
        transaction_id: 'a',
        operation_date: '2026-03-01',
        description: 'Market coffee',
        amount: '10.00',
        category_id: 'food',
        category_name: 'Jedzenie',
      }),
      transaction({
        transaction_id: 'c',
        operation_date: '2026-03-03',
        description: 'Rent',
        amount: '500.00',
        category_id: 'home',
        category_name: 'Mieszkanie',
        type: 'EXPENSE',
      }),
    ];
    const result = filterAndSortTransactions(
      rows,
      {
        search: ' MARKET ',
        dateFrom: '2026-03-01',
        maxAmount: '10.00',
        categoryId: 'food',
        type: 'EXPENSE',
      },
      { field: 'amount', direction: 'desc' },
    );
    expect(result.map((row) => row.transaction_id)).toEqual(['a', 'b']);
    expect(
      filterAndSortTransactions(
        rows,
        {},
        { field: 'operation_date', direction: 'asc' },
      ).map((row) => row.transaction_id),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('categorization rules and local suggestions', () => {
  const rules: CategorizationCandidate[] = [
    {
      rule_id: 'inactive',
      category_id: 'ignored',
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'market',
      priority: 100,
      enabled: false,
    },
    {
      rule_id: 'lower-priority',
      category_id: 'general',
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'market',
      priority: 1,
      enabled: true,
    },
    {
      rule_id: 'priority',
      category_id: 'preferred',
      match_field: 'DESCRIPTION',
      operator: 'STARTS_WITH',
      match_value: 'market',
      priority: 2,
      enabled: true,
    },
    {
      rule_id: 'equal-priority-specific',
      category_id: 'specific',
      match_field: 'DESCRIPTION',
      operator: 'EQUALS',
      match_value: 'market purchase',
      priority: 2,
      enabled: true,
    },
  ];

  it('chooses by explicit priority, then specificity; disabled rules do not match', () => {
    expect(
      findMatchingUserRule(
        {
          description: 'Market purchase',
          amount: '12.00',
          account_id: accountId,
        },
        rules,
      )?.category_id,
    ).toBe('specific');
    expect(
      findMatchingUserRule(
        {
          description: 'Market weekly',
          amount: '12.00',
          account_id: accountId,
        },
        rules,
      )?.category_id,
    ).toBe('preferred');
  });

  it('supports exact account and decimal amount criteria', () => {
    expect(
      findMatchingUserRule(
        {
          description: 'Unrelated synthetic text',
          amount: '10.5000',
          account_id: accountId,
        },
        [
          {
            rule_id: 'account',
            category_id: 'account-category',
            match_field: 'ACCOUNT',
            operator: 'EQUALS',
            match_value: accountId,
            priority: 1,
            enabled: true,
          },
          {
            rule_id: 'amount',
            category_id: 'amount-category',
            match_field: 'AMOUNT',
            operator: 'EQUALS',
            match_value: '10.5',
            priority: 2,
            enabled: true,
          },
        ],
      )?.category_id,
    ).toBe('amount-category');
  });

  it('protects an existing category from automatic rules', () => {
    expect(
      suggestAutomaticCategory(
        {
          description: 'Market purchase',
          amount: '12.00',
          account_id: accountId,
          category_id: 'manual',
        },
        rules,
      ),
    ).toBeNull();
    expect(
      suggestAutomaticCategory(
        {
          description: 'Market purchase',
          amount: '12.00',
          account_id: accountId,
        },
        rules,
      ),
    ).toBe('specific');
  });

  it('keeps learned corrections local and returns a suggestion only for confirmation', () => {
    const first = recordLocalCorrection([], 'Synthetic shop ABC', 'food');
    const repeated = recordLocalCorrection(
      first,
      ' synthetic SHOP ABC ',
      'food',
    );
    const suggestion = suggestLearnedCategory(repeated, 'SYNTHETIC shop abc');
    expect(suggestion).toBe('food');
    expect(
      suggestLearnedCategory(repeated, 'Synthetic shop ABC', 'manual'),
    ).toBeNull();
    expect(repeated).toEqual([
      { description: 'synthetic shop abc', category_id: 'food', count: 2 },
    ]);
  });
});
