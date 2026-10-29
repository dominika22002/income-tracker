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
  uid: 'stage5-ui-user',
  email: 'stage5-ui-user@example.test',
  displayName: 'Synthetic Stage 5 UI User',
};

describe('Stage 5 transfer and balance UI (E-FR-39, E-FR-40, E-FR-48)', () => {
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

  it('lets the user correct, reject and confirm transfer suggestions and save a dated balance', async () => {
    const { services, auth } = servicesFor(env, USER, clock);
    const budget = await services.backend.createBudget({
      name: 'Synthetic stage 5 UI budget',
    });
    const outgoingAccount = await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic outgoing account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const incomingAccount = await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic incoming account',
      currency: 'CHF',
      account_type: 'SAVINGS',
    });
    const correctedAccount = await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic corrected account',
      currency: 'CHF',
      account_type: 'SAVINGS',
    });
    const outgoing = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: outgoingAccount.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic corrected transfer',
      amount: '15.00',
      currency: 'CHF',
      type: 'EXPENSE',
    });
    await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: incomingAccount.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic corrected transfer',
      amount: '15.00',
      currency: 'CHF',
      type: 'INCOME',
    });
    const correctedIncoming = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: correctedAccount.account_id,
      operation_date: '2026-03-11',
      description: 'Synthetic corrected transfer',
      amount: '15.00',
      currency: 'CHF',
      type: 'INCOME',
    });
    const rejectedOutgoing = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: outgoingAccount.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic rejected transfer',
      amount: '9.00',
      currency: 'CHF',
      type: 'EXPENSE',
    });
    const rejectedIncoming = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: incomingAccount.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic rejected transfer',
      amount: '9.00',
      currency: 'CHF',
      type: 'INCOME',
    });
    const single = await services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: outgoingAccount.account_id,
      operation_date: '2026-03-12',
      description: 'Synthetic one-sided transfer',
      amount: '7.00',
      currency: 'CHF',
      type: 'EXPENSE',
    });

    await auth.signIn();
    const { container } = render(
      <BudgetApp
        services={services}
        requireAuth={false}
        activeView="transactions"
      />,
    );
    const ui = within(container);
    fireEvent.click(await ui.findByRole('button', { name: 'Transfery' }));
    const suggestions = await ui.findByRole('list', {
      name: 'Dopasowane transfery',
    });
    const correctedItem = within(suggestions)
      .getAllByRole('listitem')
      .find((item) =>
        item.textContent?.includes('Synthetic corrected transfer'),
      );
    if (!correctedItem)
      throw new Error('Transfer suggestion was not rendered.');
    expect(
      (
        await adminDb().doc(`transactions/${outgoing.transaction_id}`).get()
      ).get('type'),
    ).toBe('EXPENSE');
    const incomingSelect = within(correctedItem).getByLabelText(
      'Przychodząca transakcja dla Synthetic corrected transfer',
    );
    fireEvent.change(incomingSelect, {
      target: { value: correctedIncoming.transaction_id },
    });
    fireEvent.click(
      within(correctedItem).getByRole('button', { name: 'Potwierdź parę' }),
    );
    await ui.findByText('Transfer potwierdzony.');
    await waitFor(async () => {
      expect(
        (
          await adminDb().doc(`transactions/${outgoing.transaction_id}`).get()
        ).get('transfer_leg'),
      ).toBe('OUTGOING');
    });
    expect(
      (
        await adminDb()
          .doc(`transactions/${correctedIncoming.transaction_id}`)
          .get()
      ).get('transfer_leg'),
    ).toBe('INCOMING');

    const rejectedItem = within(suggestions)
      .getAllByRole('listitem')
      .find((item) =>
        item.textContent?.includes('Synthetic rejected transfer'),
      );
    if (!rejectedItem)
      throw new Error('Second transfer suggestion was not rendered.');
    fireEvent.click(
      within(rejectedItem).getByRole('button', { name: 'Odrzuć sugestię' }),
    );
    await ui.findByText('Sugestia transferu odrzucona.');
    expect(
      (
        await adminDb()
          .doc(`transactions/${rejectedOutgoing.transaction_id}`)
          .get()
      ).get('type'),
    ).toBe('EXPENSE');
    expect(
      (
        await adminDb()
          .doc(`transactions/${rejectedIncoming.transaction_id}`)
          .get()
      ).get('type'),
    ).toBe('INCOME');

    fireEvent.change(ui.getByLabelText('Transakcja jednostronna'), {
      target: { value: single.transaction_id },
    });
    fireEvent.click(
      ui.getByRole('button', {
        name: 'Rozpocznij potwierdzanie jednostronne',
      }),
    );
    expect(ui.getByText(/Brak drugiej strony transferu/)).toBeTruthy();
    fireEvent.click(
      ui.getByRole('button', {
        name: 'Potwierdzam transfer jednostronny',
      }),
    );
    await ui.findByText('Potwierdzono transfer jednostronny.');

    fireEvent.click(ui.getByRole('button', { name: 'Salda kont' }));
    fireEvent.change(ui.getByLabelText('Konto salda'), {
      target: { value: incomingAccount.account_id },
    });
    fireEvent.change(ui.getByLabelText('Data salda'), {
      target: { value: '2026-03-15' },
    });
    fireEvent.change(ui.getByLabelText('Kwota salda'), {
      target: { value: '88.2500' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz saldo' }));
    await ui.findByText('Saldo zapisane.');
    await waitFor(async () => {
      const snapshot = await adminDb()
        .collection('account_balance_snapshots')
        .where('account_id', '==', incomingAccount.account_id)
        .get();
      expect(snapshot.docs.map((item) => item.data())).toContainEqual(
        expect.objectContaining({
          balance_date: '2026-03-15',
          balance_amount: '88.2500',
          currency: 'CHF',
          source: 'MANUAL',
        }),
      );
    });
  });
});
