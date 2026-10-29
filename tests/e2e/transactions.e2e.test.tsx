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
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
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
import { clearFirestore, TestClock } from '../integration/helpers';
import { createRulesEnv, servicesFor, type TestUser } from './harness';

const USER: TestUser = {
  uid: 'transactions-ui-user',
  email: 'transactions-ui-user@example.test',
  displayName: 'Synthetic User',
};
const OTHER_USER: TestUser = {
  uid: 'transactions-ui-other',
  email: 'transactions-ui-other@example.test',
  displayName: 'Synthetic Other Member',
};

describe('transaction, category and search UI (E-FR-25…28, E-FR-35…36)', () => {
  let env: RulesTestEnvironment;
  const clock = new TestClock();

  beforeAll(async () => {
    setLogLevel('silent');
    configure({ asyncUtilTimeout: 8000 });
    env = await createRulesEnv();
  });

  beforeEach(clearFirestore);
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it('creates a category and transaction, edits note and label, then combines search and filters', async () => {
    const { services, auth } = servicesFor(env, USER, clock);
    const budget = await services.backend.createBudget({
      name: 'Synthetic transactions UI',
    });
    await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic daily account',
      currency: 'CHF',
      account_type: 'CHECKING',
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

    fireEvent.click(await ui.findByRole('button', { name: 'Kategorie' }));
    fireEvent.change(ui.getByLabelText('Nazwa nowej kategorii'), {
      target: { value: 'Synthetic food' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Dodaj kategorię' }));
    await ui.findByText('Kategoria została dodana.');
    const categorySnapshot = await getDocs(
      query(
        collection(
          env.authenticatedContext(USER.uid).firestore(),
          'categories',
        ),
        where('budget_id', '==', budget.budget_id),
      ),
    );
    expect(
      categorySnapshot.docs.map((category) => category.get('name')),
    ).toContain('Synthetic food');
    await ui.findByText(/Synthetic food/);
    fireEvent.change(ui.getByLabelText('Nazwa nowej kategorii'), {
      target: { value: 'Synthetic home' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Dodaj kategorię' }));
    await ui.findByText(/Synthetic home/);
    fireEvent.click(
      ui.getByRole('button', { name: 'Przesuń Synthetic food niżej' }),
    );
    await ui.findByText(/Synthetic home · Wydatek · kolejność 0/);
    const foodRow = ui.getByText(/Synthetic food · Wydatek/).closest('li');
    if (!foodRow) throw new Error('Synthetic category row was not rendered.');
    const renameFood = within(foodRow).getByRole('button', {
      name: 'Zmień nazwę',
    });
    await waitFor(() => expect(renameFood).toBeEnabled());
    fireEvent.click(renameFood);
    fireEvent.change(ui.getByLabelText('Nazwa kategorii Synthetic food'), {
      target: { value: 'Synthetic groceries' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz nazwę' }));
    await ui.findByText(/Synthetic groceries/);
    const homeRow = ui.getByText(/Synthetic home · Wydatek/).closest('li');
    if (!homeRow)
      throw new Error('Synthetic archived category row was not rendered.');
    const archiveHome = within(homeRow).getByRole('button', {
      name: 'Archiwizuj',
    });
    await waitFor(() => expect(archiveHome).toBeEnabled());
    fireEvent.click(archiveHome);
    await ui.findByText(/Synthetic home · Wydatek · kolejność 0 · archiwalna/);

    fireEvent.click(ui.getByRole('button', { name: 'Transakcje' }));
    fireEvent.click(
      await ui.findByRole('button', { name: 'Dodaj transakcję' }),
    );
    fireEvent.change(ui.getByLabelText('Data transakcji'), {
      target: { value: '2026-03-10' },
    });
    fireEvent.change(ui.getByLabelText('Opis transakcji'), {
      target: { value: 'Synthetic cafe purchase' },
    });
    fireEvent.change(ui.getByLabelText('Kwota transakcji'), {
      target: { value: '12.5000' },
    });
    const categorySelect = ui.getByLabelText('Kategoria transakcji');
    fireEvent.change(ui.getByLabelText('Kategoria transakcji'), {
      target: {
        value: within(categorySelect)
          .getByRole('option', { name: 'Synthetic groceries' })
          .getAttribute('value'),
      },
    });
    fireEvent.change(ui.getByLabelText('Notatka transakcji'), {
      target: { value: 'Synthetic note' },
    });
    fireEvent.change(ui.getByLabelText('Etykiety transakcji'), {
      target: { value: 'coffee, reviewed' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz transakcję' }));
    await ui.findByText('Transakcja zapisana.');
    await ui.findByText('Synthetic cafe purchase');

    fireEvent.click(ui.getAllByRole('button', { name: 'Szczegóły' })[0]);
    expect(await ui.findByText('Notatka: Synthetic note')).toBeTruthy();
    expect(ui.getByText('Etykiety: coffee, reviewed')).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Edytuj transakcję' }));
    fireEvent.change(ui.getByLabelText('Notatka transakcji'), {
      target: { value: 'Updated synthetic note' },
    });
    fireEvent.change(ui.getByLabelText('Etykiety transakcji'), {
      target: { value: 'coffee, confirmed' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz transakcję' }));
    await ui.findByText('Transakcja zapisana.');
    expect(await ui.findByText('Notatka: Updated synthetic note')).toBeTruthy();
    expect(ui.getByText('Etykiety: coffee, confirmed')).toBeTruthy();

    fireEvent.change(ui.getByLabelText('Szukaj opisu'), {
      target: { value: 'cafe' },
    });
    const categoryFilter = ui.getByLabelText('Filtr kategorii');
    fireEvent.change(categoryFilter, {
      target: {
        value: within(categoryFilter)
          .getByRole('option', { name: 'Synthetic groceries' })
          .getAttribute('value'),
      },
    });
    fireEvent.change(ui.getByLabelText('Filtr daty od'), {
      target: { value: '2026-03-10' },
    });
    fireEvent.change(ui.getByLabelText('Filtr typu'), {
      target: { value: 'EXPENSE' },
    });
    await waitFor(() => {
      expect(ui.getAllByText('Synthetic cafe purchase').length).toBeGreaterThan(
        0,
      );
      expect(
        ui.queryByText('Brak transakcji spełniających filtry.'),
      ).toBeNull();
    });
  });

  it('applies an explicit rule and requires confirmation for a local learned suggestion', async () => {
    const { services, auth } = servicesFor(env, USER, clock);
    const budget = await services.backend.createBudget({
      name: 'Synthetic categorization UI',
    });
    await services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic rule account',
      currency: 'CHF',
      account_type: 'CHECKING',
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

    fireEvent.click(await ui.findByRole('button', { name: 'Kategorie' }));
    for (const name of ['Synthetic auto', 'Synthetic manual']) {
      fireEvent.change(ui.getByLabelText('Nazwa nowej kategorii'), {
        target: { value: name },
      });
      fireEvent.click(ui.getByRole('button', { name: 'Dodaj kategorię' }));
      await ui.findByText('Kategoria została dodana.');
    }

    fireEvent.click(ui.getByRole('button', { name: 'Reguły' }));
    fireEvent.change(ui.getByLabelText('Wartość reguły'), {
      target: { value: 'Synthetic local ride' },
    });
    const ruleCategorySelect = ui.getByLabelText('Kategoria reguły');
    const ruleCategoryId = (
      await within(ruleCategorySelect).findByRole('option', {
        name: 'Synthetic auto · Wydatek',
      })
    ).getAttribute('value');
    fireEvent.change(ruleCategorySelect, {
      target: { value: ruleCategoryId },
    });
    expect(ruleCategorySelect).toHaveValue(ruleCategoryId);
    const ruleForm = ui
      .getByRole('button', { name: 'Zapisz regułę' })
      .closest('form');
    if (!ruleForm) throw new Error('Rule form was not rendered.');
    expect((ruleForm as HTMLFormElement).checkValidity()).toBe(true);
    fireEvent.submit(ruleForm);
    await ui.findByText('Reguła została zapisana.');

    fireEvent.click(ui.getByRole('button', { name: 'Transakcje' }));
    fireEvent.click(
      await ui.findByRole('button', { name: 'Dodaj transakcję' }),
    );
    fireEvent.change(ui.getByLabelText('Data transakcji'), {
      target: { value: '2026-03-11' },
    });
    fireEvent.change(ui.getByLabelText('Opis transakcji'), {
      target: { value: 'Synthetic local ride' },
    });
    fireEvent.change(ui.getByLabelText('Kwota transakcji'), {
      target: { value: '9.00' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz transakcję' }));
    await ui.findByText('Synthetic local ride');
    const automaticRow = ui.getByText('Synthetic local ride').closest('tr');
    expect(automaticRow).not.toBeNull();
    expect(
      within(automaticRow as HTMLElement).getByText('Synthetic auto'),
    ).toBeTruthy();

    fireEvent.click(
      within(automaticRow as HTMLElement).getByRole('button', {
        name: 'Szczegóły',
      }),
    );
    fireEvent.click(ui.getByRole('button', { name: 'Edytuj transakcję' }));
    const transactionCategory = ui.getByLabelText('Kategoria transakcji');
    fireEvent.change(transactionCategory, {
      target: {
        value: within(transactionCategory)
          .getByRole('option', { name: 'Synthetic manual' })
          .getAttribute('value'),
      },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz transakcję' }));
    await ui.findByText('Transakcja zapisana.');

    fireEvent.click(
      await ui.findByRole('button', { name: 'Dodaj transakcję' }),
    );
    fireEvent.change(ui.getByLabelText('Data transakcji'), {
      target: { value: '2026-03-12' },
    });
    fireEvent.change(ui.getByLabelText('Opis transakcji'), {
      target: { value: 'Synthetic local ride' },
    });
    await ui.findByText(/Lokalna sugestia:/);
    const categorySelect = ui.getByLabelText(
      'Kategoria transakcji',
    ) as HTMLSelectElement;
    expect(categorySelect.value).toBe('');
    fireEvent.click(ui.getByRole('button', { name: 'Potwierdź sugestię' }));
    expect(categorySelect.value).not.toBe('');
    fireEvent.change(ui.getByLabelText('Kwota transakcji'), {
      target: { value: '10.00' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Zapisz transakcję' }));
    await waitFor(() => {
      const rows = ui.getAllByText('Synthetic local ride');
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('edits a split and keeps a hidden transaction private from another active member', async () => {
    const owner = servicesFor(env, USER, clock);
    const budget = await owner.services.backend.createBudget({
      name: 'Synthetic split and hidden budget',
    });
    const account = await owner.services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic household account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const category = await owner.services.backend.saveCategory({
      budget_id: budget.budget_id,
      name: 'Synthetic household',
      kind: 'EXPENSE',
      sort_order: 0,
    });
    await owner.services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-15',
      description: 'Synthetic surprise purchase',
      amount: '25.00',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: category.category_id,
    });
    const invitation = await owner.services.backend.createInvitation({
      budget_id: budget.budget_id,
    });
    const other = servicesFor(env, OTHER_USER, clock);
    await other.services.backend.acceptInvitation(invitation.token);
    await owner.auth.signIn();
    await other.auth.signIn();
    const ownerDb = env.authenticatedContext(USER.uid).firestore();
    const ownerTransactions = await getDocs(
      query(
        collection(ownerDb, 'transactions'),
        where('budget_id', '==', budget.budget_id),
      ),
    );
    await getDoc(doc(ownerDb, 'accounts', account.account_id));
    await getDoc(doc(ownerDb, 'categories', category.category_id));
    await getDocs(
      query(
        collection(ownerDb, 'accounts'),
        where('budget_id', '==', budget.budget_id),
      ),
    );
    await getDocs(
      query(
        collection(ownerDb, 'categories'),
        where('budget_id', '==', budget.budget_id),
      ),
    );
    await getDocs(
      query(
        collection(ownerDb, 'categorization_rules'),
        where('budget_id', '==', budget.budget_id),
      ),
    );
    await getDocs(
      query(
        collection(ownerDb, 'transaction_tags'),
        where('transaction_id', '==', ownerTransactions.docs[0].id),
      ),
    );
    await getDocs(
      query(
        collection(ownerDb, 'split_items'),
        where('budget_id', '==', budget.budget_id),
      ),
    );
    const expectedTransactionIds = ownerTransactions.docs
      .map((transaction) => transaction.id)
      .sort();
    const subscriptionResult = await new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => {};
      unsubscribe = owner.services.data.subscribeTransactions(
        budget.budget_id,
        budget.membership_id,
        (transactions) => {
          const transactionIds = transactions
            .map((transaction) => transaction.transaction_id)
            .sort();
          if (
            transactionIds.length !== expectedTransactionIds.length ||
            transactionIds.some(
              (transactionId, index) =>
                transactionId !== expectedTransactionIds[index],
            )
          ) {
            return;
          }
          unsubscribe();
          resolve(transactions);
        },
        (failure) => {
          unsubscribe();
          reject(failure);
        },
      );
    });
    expect(subscriptionResult).toHaveLength(expectedTransactionIds.length);

    const ownerUi = render(
      <BudgetApp
        services={owner.services}
        requireAuth={false}
        activeView="transactions"
      />,
    );
    const ownerScreen = within(ownerUi.container);
    const transactionText = await ownerScreen.findByText(
      'Synthetic surprise purchase',
    );
    const transactionRow = transactionText.closest('tr');
    if (!transactionRow) throw new Error('Expected transaction row.');
    fireEvent.click(
      within(transactionRow).getByRole('button', { name: 'Szczegóły' }),
    );
    fireEvent.click(
      await ownerScreen.findByRole('button', { name: 'Podziel transakcję' }),
    );
    fireEvent.change(ownerScreen.getByLabelText('Kwota pozycji 1'), {
      target: { value: '10.00' },
    });
    fireEvent.change(ownerScreen.getByLabelText('Kwota pozycji 2'), {
      target: { value: '15.00' },
    });
    for (const index of [1, 2]) {
      fireEvent.change(
        ownerScreen.getByLabelText(`Kategoria pozycji ${index}`),
        {
          target: { value: category.category_id },
        },
      );
    }
    fireEvent.click(
      ownerScreen.getByRole('button', { name: 'Zapisz podział' }),
    );
    await ownerScreen.findByText('Podział transakcji został zapisany.');

    fireEvent.click(ownerScreen.getByRole('button', { name: 'Ukryj' }));
    fireEvent.change(ownerScreen.getByLabelText('Zakres ukrycia'), {
      target: { value: 'TRANSACTION' },
    });
    fireEvent.change(ownerScreen.getByLabelText('Okres ukrycia'), {
      target: { value: 'FOREVER' },
    });
    fireEvent.click(
      ownerScreen.getByRole('button', { name: 'Zapisz ukrycie' }),
    );
    await ownerScreen.findByText('Ustawienia ukrycia zostały zapisane.');
    expect(
      ownerScreen.getAllByText('Synthetic surprise purchase').length,
    ).toBeGreaterThan(0);

    const otherUi = render(
      <BudgetApp
        services={other.services}
        requireAuth={false}
        activeView="transactions"
      />,
    );
    const otherScreen = within(otherUi.container);
    await otherScreen.findByText('Pozostanie ukryta bezterminowo.');
    expect(otherUi.container.textContent).not.toContain(
      'Synthetic surprise purchase',
    );
    fireEvent.change(otherScreen.getByLabelText('Szukaj opisu'), {
      target: { value: 'surprise' },
    });
    expect(otherScreen.queryByText('Synthetic surprise purchase')).toBeNull();
    expect(otherScreen.queryByRole('button', { name: 'Szczegóły' })).toBeNull();
  });
});
