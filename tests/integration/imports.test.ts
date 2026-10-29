import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/server/accounts';
import { saveCategory } from '../../src/server/categories';
import { saveCategorizationRule } from '../../src/server/categorization';
import { createBudget } from '../../src/server/budgets';
import { commitCsvImport } from '../../src/server/imports';
import { saveTransaction } from '../../src/server/transactions';
import {
  acceptInvitation,
  createInvitation,
} from '../../src/server/invitations';
import type { StatementImportRowRequest } from '../../src/shared/contracts';
import { adminDb, clearFirestore, countDocs, testDeps } from './helpers';

const alice = {
  uid: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
};
const bob = { uid: 'bob', email: 'bob@example.test', displayName: 'Bob' };

function request(
  budgetId: string,
  accountId: string,
  fileHash: string,
  rows: StatementImportRowRequest[] = [
    {
      row_number: 2,
      decision: 'include' as const,
      operation_date: '2026-03-01',
      description: 'Synthetic market purchase',
      amount: '12.3400',
      currency: 'CHF',
      transaction_type: 'EXPENSE',
      fee: '0.3000',
      balance: '987.6600',
      balance_currency: 'CHF',
    },
    {
      row_number: 3,
      decision: 'exclude' as const,
    },
    {
      row_number: 4,
      decision: 'include' as const,
      operation_date: '2026-03-03',
      description: 'Synthetic income',
      amount: '20.00',
      currency: 'CHF',
      transaction_type: 'INCOME',
    },
  ],
) {
  return {
    budget_id: budgetId,
    account_id: accountId,
    file_sha256: fileHash,
    parser_id: 'history-v1',
    parser_version: '1.0.0',
    rows,
  };
}

describe('CSV import commit (I-FR-11, I-FR-14, I-FR-29, I-TR-12)', () => {
  beforeEach(clearFirestore);

  async function ownedAccount() {
    const deps = testDeps();
    const budget = await createBudget(deps, alice, {
      name: 'Synthetic budget',
    });
    const account = await createAccount(deps, alice, {
      budget_id: budget.budget_id,
      label: 'Synthetic checking',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    return { deps, budget, account };
  }

  it('atomically writes transactions, batch, disjoint periods and balance snapshots', async () => {
    const { deps, budget, account } = await ownedAccount();
    const result = await commitCsvImport(
      deps,
      alice,
      request(budget.budget_id, account.account_id, 'a'.repeat(64)),
    );
    const db = adminDb();
    const transactions = await db
      .collection('transactions')
      .where('import_batch_id', '==', result.import_batch_id)
      .get();
    const batch = await db
      .doc(`import_batches/${result.import_batch_id}`)
      .get();
    const periods = await db
      .collection('import_periods')
      .where('import_batch_id', '==', result.import_batch_id)
      .get();
    const balances = await db
      .collection('account_balance_snapshots')
      .where('account_id', '==', account.account_id)
      .get();

    expect(result).toMatchObject({
      imported_row_count: 2,
      skipped_duplicate_row_numbers: [3],
      periods: [
        { period_start: '2026-03-01', period_end: '2026-03-01' },
        { period_start: '2026-03-03', period_end: '2026-03-03' },
      ],
      already_imported: false,
    });
    expect(batch.data()).toMatchObject({
      account_id: account.account_id,
      imported_by_membership_id: budget.membership_id,
      source_format: 'CSV',
      parser_id: 'history-v1',
      parser_version: '1.0.0',
      status: 'IMPORTED',
      row_count: 2,
      source_row_count: 3,
    });
    expect(periods.size).toBe(2);
    expect(transactions.docs[0].data()).toMatchObject({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      import_batch_id: result.import_batch_id,
      created_by_membership_id: budget.membership_id,
      imported_by_membership_id: budget.membership_id,
      amount: '12.3400',
      fee: '0.3000',
    });
    expect(balances.docs).toHaveLength(1);
    expect(balances.docs[0].data()).toMatchObject({
      import_batch_id: result.import_batch_id,
      balance_date: '2026-03-01',
      balance_amount: '987.6600',
      currency: 'CHF',
      source: 'STATEMENT',
    });
  });

  it('preserves imported source links when a transaction is edited', async () => {
    const { deps, budget, account } = await ownedAccount();
    const result = await commitCsvImport(
      deps,
      alice,
      request(budget.budget_id, account.account_id, 'c'.repeat(64), [
        {
          row_number: 2,
          decision: 'include',
          operation_date: '2026-03-04',
          description: 'Synthetic imported purchase',
          amount: '12.3400',
          currency: 'CHF',
          transaction_type: 'EXPENSE',
          bank_transaction_id: 'synthetic-bank-transaction',
        },
      ]),
    );
    const db = adminDb();
    const imported = await db
      .collection('transactions')
      .where('import_batch_id', '==', result.import_batch_id)
      .get();
    const transactionId = imported.docs[0].id;

    await saveTransaction(deps, alice, {
      transaction_id: transactionId,
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-05',
      description: 'Synthetic imported purchase corrected',
      amount: '15.0000',
      currency: 'CHF',
      type: 'EXPENSE',
    });

    expect(
      (await db.doc(`transactions/${transactionId}`).get()).data(),
    ).toMatchObject({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      import_batch_id: result.import_batch_id,
      imported_by_membership_id: budget.membership_id,
      bank_transaction_id: 'synthetic-bank-transaction',
      amount: '15.0000',
      currency: 'CHF',
    });
  });

  it('is idempotent for the same account and file hash', async () => {
    const { deps, budget, account } = await ownedAccount();
    const payload = request(
      budget.budget_id,
      account.account_id,
      'b'.repeat(64),
    );
    const first = await commitCsvImport(deps, alice, payload);
    const retry = await commitCsvImport(deps, alice, payload);

    expect(retry).toEqual({ ...first, already_imported: true });
    expect(await countDocs(adminDb(), 'import_batches')).toBe(1);
    expect(await countDocs(adminDb(), 'transactions')).toBe(2);
    expect(await countDocs(adminDb(), 'import_periods')).toBe(2);
  });

  it('applies only an enabled user rule to newly imported transactions', async () => {
    const { deps, budget, account } = await ownedAccount();
    const category = await saveCategory(deps, alice, {
      budget_id: budget.budget_id,
      name: 'Synthetic imported category',
      kind: 'EXPENSE',
      sort_order: 0,
    });
    await saveCategorizationRule(deps, alice, {
      budget_id: budget.budget_id,
      category_id: category.category_id,
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'synthetic scheduled',
      priority: 2,
      enabled: false,
    });
    const activeRuleCategory = await saveCategory(deps, alice, {
      budget_id: budget.budget_id,
      name: 'Synthetic active rule category',
      kind: 'EXPENSE',
      sort_order: 1,
    });
    const activeRule = await saveCategorizationRule(deps, alice, {
      budget_id: budget.budget_id,
      category_id: activeRuleCategory.category_id,
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'synthetic scheduled',
      priority: 1,
    });
    const result = await commitCsvImport(
      deps,
      alice,
      request(budget.budget_id, account.account_id, 'a'.repeat(64), [
        {
          row_number: 2,
          decision: 'include',
          operation_date: '2026-03-02',
          description: 'Synthetic scheduled item',
          amount: '3.50',
          currency: 'CHF',
          transaction_type: 'EXPENSE',
        },
      ]),
    );
    const imported = await adminDb()
      .collection('transactions')
      .where('import_batch_id', '==', result.import_batch_id)
      .get();
    expect(imported.docs[0].get('category_id')).toBe(
      activeRuleCategory.category_id,
    );
    expect(imported.docs[0].get('category_id')).not.toBe(category.category_id);
    expect(activeRule.rule_id).toBeTruthy();
  });

  it('deduplicates bank ids and requires an explicit decision for a fingerprint match', async () => {
    const { deps, budget, account } = await ownedAccount();
    const bankRow: StatementImportRowRequest = {
      row_number: 2,
      decision: 'include' as const,
      operation_date: '2026-03-01',
      description: 'Synthetic transfer',
      amount: '9.00',
      currency: 'CHF',
      transaction_type: 'TRANSFER',
      bank_transaction_id: 'bank-row-1',
    };
    const initial = await commitCsvImport(
      deps,
      alice,
      request(budget.budget_id, account.account_id, 'c'.repeat(64), [bankRow]),
    );
    const duplicateBank = await commitCsvImport(
      deps,
      alice,
      request(budget.budget_id, account.account_id, 'd'.repeat(64), [bankRow]),
    );
    expect(initial.imported_row_count).toBe(1);
    expect(duplicateBank.imported_row_count).toBe(0);
    expect(duplicateBank.skipped_duplicate_row_numbers).toEqual([2]);

    const fingerprintRow = { ...bankRow, bank_transaction_id: undefined };
    const fingerprintImport = request(
      budget.budget_id,
      account.account_id,
      'e'.repeat(64),
      [fingerprintRow],
    );
    await expect(
      commitCsvImport(deps, alice, fingerprintImport),
    ).rejects.toMatchObject({ code: 'DUPLICATE_REVIEW_REQUIRED' });
    expect(await countDocs(adminDb(), 'import_batches')).toBe(2);

    const excluded = {
      ...fingerprintImport,
      rows: [
        {
          ...fingerprintRow,
          possible_duplicate_decision: 'exclude' as const,
        },
      ],
    };
    const duplicateDecision = await commitCsvImport(deps, alice, excluded);
    expect(duplicateDecision).toMatchObject({
      imported_row_count: 0,
      skipped_duplicate_row_numbers: [2],
    });

    const confirmed = await commitCsvImport(deps, alice, {
      ...fingerprintImport,
      file_sha256: 'f'.repeat(64),
      rows: [
        {
          ...fingerprintRow,
          possible_duplicate_decision: 'confirm',
        },
      ],
    });
    expect(confirmed).toMatchObject({
      imported_row_count: 1,
      skipped_duplicate_row_numbers: [],
    });
    expect(await countDocs(adminDb(), 'import_batches')).toBe(4);
  });

  it('rejects CSV import for an account owned by another member', async () => {
    const deps = testDeps();
    const budget = await createBudget(deps, alice, { name: 'Shared budget' });
    const invitation = await createInvitation(deps, alice, {
      budget_id: budget.budget_id,
    });
    const joined = await acceptInvitation(deps, bob, invitation.token);
    const account = await createAccount(deps, bob, {
      budget_id: budget.budget_id,
      label: 'Bob synthetic account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });

    await expect(
      commitCsvImport(
        deps,
        alice,
        request(budget.budget_id, account.account_id, 'f'.repeat(64)),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(joined.membership_id).not.toBe(budget.membership_id);
    expect(await countDocs(adminDb(), 'import_batches')).toBe(0);
  });
});
