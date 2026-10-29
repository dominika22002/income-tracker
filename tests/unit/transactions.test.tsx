import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MyBudgetView, TransactionView } from '../../src/shared/contracts';
import type { BudgetDataSource } from '../../src/renderer/src/backend/ports';
import { TransactionsPanel } from '../../src/renderer/src/features/budgets/BudgetApp';

describe('TransactionsPanel', () => {
  afterEach(cleanup);

  it('shows imported transactions in the selected budget', async () => {
    const budget: MyBudgetView = {
      budget_id: 'budget-1',
      name: 'Domowy',
      membership_id: 'membership-1',
      role: 'ADMIN',
    };
    const transaction: TransactionView = {
      transaction_id: 'transaction-1',
      budget_id: budget.budget_id,
      account_id: 'account-1',
      account_label: 'Konto bieżące',
      account_owner_membership_id: 'membership-1',
      import_batch_id: 'import-1',
      imported_by_membership_id: 'membership-1',
      bank_transaction_id: null,
      operation_date: '2026-03-01',
      description: 'Zakupy spożywcze',
      amount: '42.50',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: null,
      category_name: null,
      note: null,
      tags: [],
    };
    const data: Pick<BudgetDataSource, 'subscribeTransactions'> = {
      subscribeTransactions: vi.fn((_budgetId, onData) => {
        onData([transaction]);
        return () => undefined;
      }),
    };

    render(<TransactionsPanel data={data} budgets={[budget]} compact />);

    expect(await screen.findByText('Zakupy spożywcze')).toBeInTheDocument();
    expect(screen.getByText('Konto bieżące')).toBeInTheDocument();
    expect(screen.getByText('Wydatek')).toBeInTheDocument();
    expect(screen.getByText(/42,50 CHF/)).toBeInTheDocument();
  });
});
