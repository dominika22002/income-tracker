import { describe, expect, it } from 'vitest';
import type {
  AccountBalanceView,
  CategoryView,
  SpendingLimitView,
  TransactionView,
} from '../../src/shared/contracts';
import {
  aggregateReport,
  compareReportPeriods,
  estimateMonthlySavings,
  monthlyLimitUsage,
  savingsBalances,
} from '../../src/shared/domain/reporting';
import { maskTransactionsForMember } from '../../src/shared/domain/transactionFeatures';

const BUDGET = '00000000-0000-4000-8000-000000000001';
const FOOD = '00000000-0000-4000-8000-000000000002';
const HOME = '00000000-0000-4000-8000-000000000003';
const OTHER = '00000000-0000-4000-8000-000000000004';
const FEE = '00000000-0000-4000-8000-000000000005';
const OWNER = '00000000-0000-4000-8000-000000000006';

function transaction(
  id: string,
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    transaction_id: id,
    budget_id: BUDGET,
    account_id: 'account',
    account_label: 'Synthetic account',
    account_owner_membership_id: OWNER,
    import_batch_id: null,
    imported_by_membership_id: null,
    bank_transaction_id: null,
    operation_date: '2026-03-15',
    description: 'Synthetic transaction',
    amount: '10.0000',
    currency: 'CHF',
    type: 'EXPENSE',
    category_id: FOOD,
    category_name: 'Jedzenie',
    note: null,
    tags: [],
    ...overrides,
  };
}

const categories: CategoryView[] = [
  {
    category_id: FOOD,
    budget_id: BUDGET,
    parent_category_id: null,
    name: 'Jedzenie',
    kind: 'EXPENSE',
    expense_nature: 'VARIABLE',
    sort_order: 0,
    archived_at: null,
  },
  {
    category_id: HOME,
    budget_id: BUDGET,
    parent_category_id: null,
    name: 'Dom',
    kind: 'EXPENSE',
    expense_nature: 'FIXED',
    sort_order: 1,
    archived_at: null,
  },
  {
    category_id: OTHER,
    budget_id: BUDGET,
    parent_category_id: null,
    name: 'Pozostałe',
    kind: 'EXPENSE',
    expense_nature: 'DISCRETIONARY',
    sort_order: 2,
    archived_at: null,
  },
  {
    category_id: FEE,
    budget_id: BUDGET,
    parent_category_id: null,
    name: 'Opłaty',
    kind: 'EXPENSE',
    expense_nature: 'FIXED',
    sort_order: 3,
    archived_at: null,
  },
];

const fixture = [
  transaction('income-first', {
    operation_date: '2026-03-01',
    amount: '100.0000',
    type: 'INCOME',
    category_id: null,
    category_name: null,
  }),
  transaction('income-last', {
    operation_date: '2026-03-31',
    amount: '20.0000',
    type: 'INCOME',
    category_id: null,
    category_name: null,
  }),
  transaction('income-outside', {
    operation_date: '2026-04-01',
    amount: '99.0000',
    type: 'INCOME',
  }),
  transaction('split-source', {
    amount: '50.0000',
    category_id: null,
    category_name: null,
    split_items: [
      {
        split_item_id: 'split-recurring',
        budget_id: BUDGET,
        transaction_id: 'split-source',
        amount: '20.0000',
        category_id: FOOD,
        expense_frequency: 'RECURRING',
        description: null,
        note: null,
        position: 0,
      },
      {
        split_item_id: 'split-one-time',
        budget_id: BUDGET,
        transaction_id: 'split-source',
        amount: '30.0000',
        category_id: HOME,
        expense_frequency: 'ONE_TIME',
        description: null,
        note: null,
        position: 1,
      },
    ],
  }),
  transaction('irregular', {
    amount: '7.0000',
    expense_frequency: 'IRREGULAR',
  }),
  transaction('one-time', {
    amount: '12.0000',
    category_id: OTHER,
    category_name: 'Pozostałe',
    expense_frequency: 'ONE_TIME',
  }),
  transaction('unspecified', {
    amount: '5.0000',
    category_id: null,
    category_name: null,
    expense_frequency: null,
  }),
  transaction('hidden', {
    amount: '8.0000',
    description: 'Synthetic hidden purchase',
    hidden_mode: 'TRANSACTION',
    hidden_until: null,
    hidden_by_membership_id: 'other-member',
  }),
  transaction('foreign-irregular', {
    amount: '10.0000',
    currency: 'EUR',
    expense_frequency: 'IRREGULAR',
  }),
  transaction('foreign-recurring', {
    amount: '2.0000',
    currency: 'EUR',
    expense_frequency: 'RECURRING',
  }),
  transaction('confirmed-transfer', {
    amount: '1000.0000',
    type: 'TRANSFER',
    transfer_group_id: 'confirmed-group',
  }),
  transaction('transfer-fee', {
    amount: '1.0000',
    category_id: FEE,
    category_name: 'Opłaty',
    transfer_group_id: 'confirmed-group',
  }),
  transaction('april-expense', {
    operation_date: '2026-04-10',
    amount: '3.0000',
    category_id: OTHER,
    category_name: 'Pozostałe',
  }),
];

const rates = {
  'foreign-irregular': '1.2',
  'foreign-recurring': '1.1',
};

describe('shared reporting calculations (FR-43–FR-49)', () => {
  it('returns zero totals for an empty period and includes both date boundaries', () => {
    const empty = aggregateReport(
      [],
      categories,
      { start: '2026-03-01', end: '2026-03-31' },
      'CHF',
    );
    expect(empty).toMatchObject({
      income: '0.0000',
      expenses: '0.0000',
      cash_flow: '0.0000',
      expenses_by_category: [],
    });

    const edgeTransactions = fixture.filter((item) =>
      ['income-first', 'income-last', 'income-outside'].includes(
        item.transaction_id,
      ),
    );
    const edges = aggregateReport(
      edgeTransactions,
      categories,
      { start: '2026-03-01', end: '2026-03-31' },
      'CHF',
    );
    expect(edges.income).toBe('120.0000');
  });

  it('uses split lines, per-transaction FX rates, private masked rows and confirmed transfer legs consistently', () => {
    const viewerTransactions = maskTransactionsForMember(
      fixture,
      OWNER,
      new Date('2026-04-30T00:00:00.000Z'),
    );
    const report = aggregateReport(
      viewerTransactions,
      categories,
      { start: '2026-03-01', end: '2026-03-31' },
      'CHF',
      rates,
    );

    expect(report.income).toBe('120.0000');
    expect(report.expenses).toBe('97.2000');
    expect(report.cash_flow).toBe('22.8000');
    expect(report.recurring_expenses).toBe('22.2000');
    expect(report.one_time_expenses).toBe('42.0000');
    expect(report.recurring_by_nature.VARIABLE).toBe('22.2000');
    expect(report.expenses_by_category).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category_name: 'Jedzenie',
          amount: '41.2000',
        }),
        expect.objectContaining({ category_name: 'Dom', amount: '30.0000' }),
        expect.objectContaining({
          category_name: 'Ukryta lub bez kategorii',
          amount: '13.0000',
        }),
      ]),
    );
    expect(JSON.stringify(viewerTransactions)).not.toContain(
      'Synthetic hidden purchase',
    );
  });

  it('compares periods by category without changing the common sum rules', () => {
    const comparison = compareReportPeriods(
      fixture,
      categories,
      { start: '2026-03-01', end: '2026-03-31' },
      { start: '2026-04-01', end: '2026-04-30' },
      'CHF',
      rates,
    );
    expect(comparison.first.expenses).toBe('97.2000');
    expect(comparison.second.expenses).toBe('3.0000');
    expect(comparison.income_change).toBe('-21.0000');
    expect(comparison.expenses_change).toBe('-94.2000');
    expect(comparison.category_changes).toContainEqual(
      expect.objectContaining({
        category_id: OTHER,
        category_name: 'Pozostałe',
        amount: '-9.0000',
      }),
    );
  });

  it('calculates category, all-expense and one-time monthly limit utilization', () => {
    const limits: SpendingLimitView[] = [
      {
        spending_limit_id: 'category-limit',
        budget_id: BUDGET,
        limit_scope: 'CATEGORY',
        category_id: FOOD,
        period: 'MONTH',
        limit_amount: '50.0000',
        currency: 'CHF',
      },
      {
        spending_limit_id: 'all-limit',
        budget_id: BUDGET,
        limit_scope: 'ALL_EXPENSES',
        category_id: null,
        period: 'MONTH',
        limit_amount: '100.0000',
        currency: 'CHF',
      },
      {
        spending_limit_id: 'one-time-limit',
        budget_id: BUDGET,
        limit_scope: 'ONE_TIME_EXPENSES',
        category_id: null,
        period: 'MONTH',
        limit_amount: '40.0000',
        currency: 'CHF',
      },
    ];
    const usage = monthlyLimitUsage(
      maskTransactionsForMember(
        fixture,
        OWNER,
        new Date('2026-04-30T00:00:00.000Z'),
      ),
      limits,
      '2026-03',
      'CHF',
      rates,
    );
    expect(usage.map(({ spent, remaining }) => [spent, remaining])).toEqual([
      ['41.2000', '8.8000'],
      ['97.2000', '2.8000'],
      ['42.0000', '-2.0000'],
    ]);
    expect(usage[2].utilization_percent).toBe(105);
  });

  it('averages all net spending over complete historical months and keeps official balances separate', () => {
    const estimate = estimateMonthlySavings(
      fixture,
      categories,
      '2026-04',
      3,
      'CHF',
      rates,
    );
    expect(estimate).toMatchObject({
      horizon_months: 3,
      period: { start: '2026-01-01', end: '2026-03-31' },
      total_remaining: '22.8000',
      average_monthly_remaining: '7.6000',
    });
    expect(estimate.assumptions.join(' ')).toContain('jednorazowe');

    const balances: AccountBalanceView[] = [
      {
        snapshot_id: 'older',
        account_id: 'savings',
        balance_date: '2026-03-01',
        balance_amount: '40.0000',
        currency: 'CHF',
        source: 'MANUAL',
      },
      {
        snapshot_id: 'latest',
        account_id: 'savings',
        balance_date: '2026-03-31',
        balance_amount: '60.0000',
        currency: 'CHF',
        source: 'MANUAL',
      },
    ];
    const official = savingsBalances(
      [
        {
          account_id: 'savings',
          label: 'Synthetic savings',
          account_type: 'SAVINGS',
        },
        {
          account_id: 'checking',
          label: 'Synthetic checking',
          account_type: 'CHECKING',
        },
        {
          account_id: 'empty-savings',
          label: 'Empty savings',
          account_type: 'SAVINGS',
        },
      ],
      balances,
    );
    expect(official).toEqual([
      {
        account_id: 'savings',
        account_label: 'Synthetic savings',
        balance_amount: '60.0000',
        currency: 'CHF',
        balance_date: '2026-03-31',
      },
    ]);
    expect(official[0].balance_amount).not.toBe(
      estimate.average_monthly_remaining,
    );
  });
});
