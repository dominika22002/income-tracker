import React from 'react';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { setLogLevel } from 'firebase/firestore';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { BudgetApp } from '../../src/renderer/src/features/budgets/BudgetApp';
import { adminDb, clearFirestore, TestClock } from '../integration/helpers';
import { createRulesEnv, servicesFor, type TestUser } from './harness';

const USER: TestUser = {
  uid: 'stage6-ui-user',
  email: 'stage6-ui-user@example.test',
  displayName: 'Synthetic Stage 6 UI User',
};

describe('Stage 6 reports and savings UI (E-FR-43–E-FR-49)', () => {
  let env: RulesTestEnvironment;
  const clock = new TestClock();

  beforeAll(async () => {
    setLogLevel('silent');
    configure({ asyncUtilTimeout: 8000 });
    env = await createRulesEnv();
  });
  beforeEach(clearFirestore);
  afterEach(cleanup);
  afterAll(async () => env.cleanup());

  it('uses shared sums for periods, limits, hidden expenses, transfers and savings', async () => {
    const { services, auth } = servicesFor(env, USER, clock);
    await services.backend.ensureUserProfile();
    await services.backend.updatePreferences({
      primary_currency: 'CHF',
      secondary_currencies: [],
    });
    const budget = await services.backend.createBudget({
      name: 'Synthetic Stage 6 UI budget',
    });
    const account = await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic spending account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const transferAccount = await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic transfer account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const savingsAccount = await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic savings account',
      currency: 'CHF',
      account_type: 'SAVINGS',
    });
    const foodCategory = await services.backend.saveCategory({
      budget_id: budget.budget_id,
      name: 'Synthetic food',
      kind: 'EXPENSE',
      expense_nature: 'VARIABLE',
      sort_order: 0,
    });
    const income = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-01',
      description: 'Synthetic monthly income',
      amount: '100.0000',
      currency: 'CHF',
      type: 'INCOME',
    });
    await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic recurring expense',
      amount: '30.0000',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: foodCategory.category_id,
      expense_frequency: 'RECURRING',
    });
    await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-15',
      description: 'Synthetic one-time expense',
      amount: '15.0000',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: foodCategory.category_id,
      expense_frequency: 'ONE_TIME',
    });
    const hidden = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-20',
      description: 'Synthetic private expense',
      amount: '20.0000',
      currency: 'CHF',
      type: 'EXPENSE',
    });
    await services.backend.setTransactionHidden({
      budget_id: budget.budget_id,
      transaction_id: hidden.transaction_id,
      hidden_mode: 'TRANSACTION',
      hidden_until: null,
    });
    const outgoing = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-21',
      description: 'Synthetic confirmed transfer out',
      amount: '500.0000',
      currency: 'CHF',
      type: 'EXPENSE',
    });
    const incoming = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: transferAccount.account_id,
      operation_date: '2026-03-21',
      description: 'Synthetic confirmed transfer in',
      amount: '500.0000',
      currency: 'CHF',
      type: 'INCOME',
    });
    await services.backend.reviewTransfer({
      budget_id: budget.budget_id,
      decision: 'CONFIRM_PAIR',
      outgoing_transaction_id: outgoing.transaction_id,
      incoming_transaction_id: incoming.transaction_id,
    });
    await services.backend.saveAccountBalance({
      budget_id: budget.budget_id,
      account_id: savingsAccount.account_id,
      balance_date: '2026-03-31',
      balance_amount: '80.0000',
      currency: 'CHF',
    });

    await auth.signIn();
    const { container } = render(
      <BudgetApp
        services={services}
        requireAuth={false}
        activeView="reports"
      />,
    );
    const ui = within(container);
    fireEvent.change(await ui.findByLabelText('Początek okresu raportu'), {
      target: { value: '2026-03-01' },
    });
    fireEvent.change(await ui.findByLabelText('Koniec okresu raportu'), {
      target: { value: '2026-03-31' },
    });
    fireEvent.change(
      await ui.findByLabelText('Miesiąc odniesienia oszczędności'),
      {
        target: { value: '2026-04' },
      },
    );
    fireEvent.change(await ui.findByLabelText('Horyzont historyczny'), {
      target: { value: '3' },
    });
    fireEvent.change(await ui.findByLabelText('Miesiąc limitu'), {
      target: { value: '2026-03' },
    });

    await ui.findByText(/Przepływ netto/);
    expect(ui.getByText(/Dochody:/).textContent).toContain('100,00');
    expect(ui.getByText(/Przepływ netto/).textContent).toContain('35,00');
    expect(ui.getByText(/Koszty cykliczne:/).textContent).toContain('30,00');
    expect(ui.getByText(/jednorazowe:/).textContent).toContain('15,00');

    fireEvent.change(ui.getByLabelText('Zakres nowego limitu'), {
      target: { value: 'ALL_EXPENSES' },
    });
    fireEvent.change(ui.getByLabelText('Kwota limitu'), {
      target: { value: '70.0000' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz limit' }));
    await ui.findByText('Limit miesięczny został zapisany.');

    fireEvent.change(ui.getByLabelText('Zakres nowego limitu'), {
      target: { value: 'ONE_TIME_EXPENSES' },
    });
    fireEvent.change(ui.getByLabelText('Kwota limitu'), {
      target: { value: '20.0000' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz limit' }));
    await waitFor(() => {
      const limits = ui.getByRole('list', { name: 'Wykorzystanie limitów' });
      expect(limits.textContent).toContain('70,00');
      expect(limits.textContent).toContain('20,00');
      expect(limits.textContent).toContain('92,9%');
      expect(limits.textContent).toContain('Wydatki jednorazowe');
      expect(limits.textContent).toContain('15,00');
    });

    await ui.findByText(/Synthetic savings account/);
    expect(
      ui.getByRole('list', { name: 'Rzeczywiste oszczędności' }).textContent,
    ).toContain('80,00');
    expect(
      ui.getByText(/Średni potencjalny przepływ miesięczny/).textContent,
    ).toContain('11,6667');
    expect(
      (await adminDb().doc(`transactions/${income.transaction_id}`).get()).get(
        'type',
      ),
    ).toBe('INCOME');
  });
});
