import { Timestamp } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginBudgetRestore,
  commitBudgetRestore,
  exportBudgetBackup,
  writeBudgetRestoreChunk,
} from '../../src/server/backups';
import { createBudget } from '../../src/server/budgets';
import {
  createBackupFile,
  parseBackupFile,
} from '../../src/shared/domain/backup';
import { BACKUP_COLLECTIONS, COLLECTIONS } from '../../src/shared/firestorePaths';
import type {
  BeginBudgetRestoreRequest,
  RestoreDocument,
} from '../../src/shared/contracts';
import {
  adminDb,
  clearFirestore,
  failingDb,
  testDeps,
} from './helpers';

const alice = {
  uid: 'backup-alice',
  email: 'backup-alice@example.test',
  displayName: 'Backup Alice',
};
const bob = {
  uid: 'backup-bob',
  email: 'backup-bob@example.test',
  displayName: 'Backup Bob',
};

function countsFor(payload: Awaited<ReturnType<typeof exportBudgetBackup>>) {
  return {
    ...Object.fromEntries(
      BACKUP_COLLECTIONS.map((collection) => [
        collection,
        payload.datasets[collection].length,
      ]),
    ),
    membership_history: payload.membership_history.length,
  };
}

async function seedCompleteBudget(
  deps: ReturnType<typeof testDeps>,
  user: typeof alice,
) {
  const budget = await createBudget(deps, user, { name: 'Source budget' });
  const db = adminDb();
  const now = Timestamp.fromDate(new Date('2026-10-30T09:00:00.000Z'));
  const accountId = 'account-1';
  const batchId = 'batch-1';
  const categoryId = 'category-1';
  const transactionId = 'transaction-1';
  const rateId = 'rate-1';
  const membershipId = budget.membership_id;
  const budgetId = budget.budget_id;

  await Promise.all([
    db.doc(`users/${user.uid}`).set({
      user_id: user.uid,
      email: user.email,
      password: 'synthetic-password-must-not-be-exported',
      refresh_token: 'synthetic-token-must-not-be-exported',
    }),
    db.doc(`user_preferences/${user.uid}`).set({
      user_id: user.uid,
      primary_currency: 'PLN',
      secondary_currencies: ['EUR'],
    }),
    db.doc(`accounts/${accountId}`).set({
      budget_id: budgetId,
      owner_membership_id: membershipId,
      label: 'Checking',
      institution_name: 'Synthetic Bank',
      currency: 'PLN',
      account_type: 'CHECKING',
      created_at: now,
      archived_at: null,
    }),
    db.doc(`import_batches/${batchId}`).set({
      budget_id: budgetId,
      account_id: accountId,
      imported_by_membership_id: membershipId,
      file_sha256: 'a'.repeat(64),
      source_format: 'CSV',
      parser_id: 'history-v1',
      parser_version: '1.0',
      status: 'IMPORTED',
      imported_at: now,
      row_count: 1,
    }),
    db.doc(`import_profiles/profile-1`).set({
      budget_id: budgetId,
      account_id: accountId,
      source_format: 'CSV',
      parser_id: 'history-v1',
      parser_version: '1.0',
      mapping_config: { description_column: 'Description' },
      updated_at: now,
    }),
    db.doc(`import_periods/period-1`).set({
      budget_id: budgetId,
      import_batch_id: batchId,
      period_start: '2026-10-01',
      period_end: '2026-10-01',
    }),
    db.doc(`import_batch_file_hashes/hash-1`).set({
      import_batch_id: batchId,
      imported_row_count: 1,
      skipped_duplicate_row_numbers: [],
      periods: [{ period_start: '2026-10-01', period_end: '2026-10-01' }],
    }),
    db.doc(`categories/${categoryId}`).set({
      budget_id: budgetId,
      parent_category_id: null,
      name: 'Food',
      kind: 'EXPENSE',
      sort_order: 0,
      expense_nature: 'NEED',
      created_by_membership_id: membershipId,
      archived_at: null,
    }),
    db.doc('categorization_rules/rule-1').set({
      budget_id: budgetId,
      category_id: categoryId,
      created_by_membership_id: membershipId,
      source: 'USER',
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'Market',
      priority: 1,
      enabled: true,
    }),
    db.doc(`transactions/${transactionId}`).set({
      budget_id: budgetId,
      account_id: accountId,
      import_batch_id: batchId,
      operation_date: '2026-10-01',
      description: 'Synthetic market purchase',
      amount: '10.0000',
      currency: 'PLN',
      type: 'EXPENSE',
      category_id: categoryId,
      created_by_membership_id: membershipId,
      imported_by_membership_id: membershipId,
      created_at: now,
      note: 'Synthetic note',
      transfer_group_id: null,
    }),
    db.doc('split_items/split-1').set({
      budget_id: budgetId,
      transaction_id: transactionId,
      category_id: categoryId,
      amount: '10.0000',
      expense_frequency: 'ONE_TIME',
      description: 'Food',
      note: null,
      position: 0,
    }),
    db.doc('spending_limits/limit-1').set({
      budget_id: budgetId,
      limit_scope: 'CATEGORY',
      category_id: categoryId,
      period: 'MONTHLY',
      limit_amount: '100.0000',
      currency: 'PLN',
      created_by_membership_id: membershipId,
    }),
    db.doc('account_balance_snapshots/balance-1').set({
      account_id: accountId,
      import_batch_id: batchId,
      balance_date: '2026-10-01',
      balance_amount: '90.0000',
      currency: 'PLN',
      source: 'STATEMENT',
      created_by_membership_id: membershipId,
      created_at: now,
    }),
    db.doc(`exchange_rates/${rateId}`).set({
      base_currency: 'PLN',
      quote_currency: 'EUR',
      rate_date: '2026-10-01',
      rate: '0.2300000000',
      provider: 'ECB',
      fetched_at: now,
    }),
    db.doc('transaction_conversions/conversion-1').set({
      transaction_id: transactionId,
      target_currency: 'EUR',
      exchange_rate_id: rateId,
      rate_date: '2026-10-01',
      rate_used: '0.2300000000',
      converted_amount: '2.30000000000000',
      display_amount: '2.3000',
      calculated_at: now,
    }),
    db.doc('tags/tag-1').set({
      budget_id: budgetId,
      name: 'Work',
      created_by_membership_id: membershipId,
    }),
    db.doc('transaction_tags/link-1').set({
      transaction_id: transactionId,
      tag_id: 'tag-1',
    }),
    db.doc('transfer_groups/transfer-1').set({
      budget_id: budgetId,
      status: 'REJECTED',
      outgoing_transaction_id: null,
      incoming_transaction_id: null,
      transaction_id: null,
      fx_rate_id: null,
      created_by_membership_id: membershipId,
      confirmed_by_membership_id: null,
      confirmed_at: null,
    }),
  ]);
  return { budget, membershipId };
}

async function uploadPayload(
  deps: ReturnType<typeof testDeps>,
  user: typeof alice,
  budgetId: string,
  expectedRevisionId: string | null,
  payload: Awaited<ReturnType<typeof exportBudgetBackup>>,
) {
  const request: BeginBudgetRestoreRequest = {
    budget_id: budgetId,
    expected_revision_id: expectedRevisionId,
    document_counts: countsFor(payload),
    source_memberships: payload.membership_history,
    currency_settings: payload.currency_settings,
    apply_currency_settings: false,
  };
  const restore = await beginBudgetRestore(deps, user, request);
  for (const collection of BACKUP_COLLECTIONS) {
    const records = payload.datasets[collection];
    if (records.length === 0) continue;
    const documents: RestoreDocument[] = records.map((record) => ({
      collection,
      document_id: record.document_id,
      data: record.data,
    }));
    await writeBudgetRestoreChunk(deps, user, {
      restore_id: restore.restore_id,
      chunk_id: `chunk-${collection}`,
      documents,
    });
  }
  return restore;
}

describe('versioned budget backups and restore (FR-68–FR-86, TR-23–TR-25)', () => {
  beforeEach(clearFirestore);

  it('exports the full budget dataset without profile credentials and round-trips it atomically', async () => {
    const deps = testDeps();
    const { budget } = await seedCompleteBudget(deps, alice);
    const source = await exportBudgetBackup(deps, alice, {
      budget_id: budget.budget_id,
    });
    const content = await createBackupFile(source);
    const parsed = await parseBackupFile(content);

    expect(BACKUP_COLLECTIONS.every((name) => name in parsed.datasets)).toBe(
      true,
    );
    expect(parsed.datasets.transactions).toHaveLength(1);
    expect(parsed.datasets.split_items).toHaveLength(1);
    expect(parsed.datasets.transaction_conversions).toHaveLength(1);
    expect(parsed.membership_history).toHaveLength(1);
    expect(content).not.toContain('synthetic-password-must-not-be-exported');
    expect(content).not.toContain('synthetic-token-must-not-be-exported');

    const target = await createBudget(deps, alice, { name: 'Target budget' });
    const session = await uploadPayload(
      deps,
      alice,
      target.budget_id,
      null,
      parsed,
    );
    await commitBudgetRestore(deps, alice, {
      restore_id: session.restore_id,
    });

    const db = adminDb();
    expect(
      (
        await db.doc(`budgets/${target.budget_id}`).get()
      ).get('active_revision_id'),
    ).toBe(session.revision_id);
    const restored = await exportBudgetBackup(deps, alice, {
      budget_id: target.budget_id,
    });
    expect(restored.datasets.accounts).toHaveLength(1);
    expect(restored.datasets.transactions[0].data).toMatchObject({
      budget_id: target.budget_id,
      account_id: 'account-1',
      description: 'Synthetic market purchase',
    });
    expect(restored.datasets.transaction_tags).toHaveLength(1);
    expect(restored.currency_settings).toEqual({
      primary_currency: 'PLN',
      secondary_currencies: ['EUR'],
    });
  });

  it('reverifies member identities and does not restore access from backup history', async () => {
    const deps = testDeps();
    const { budget, membershipId } = await seedCompleteBudget(deps, alice);
    const backup = await exportBudgetBackup(deps, alice, {
      budget_id: budget.budget_id,
    });
    const target = await createBudget(deps, bob, { name: 'Bob target' });
    const session = await beginBudgetRestore(deps, bob, {
      budget_id: target.budget_id,
      expected_revision_id: null,
      document_counts: countsFor(backup),
      source_memberships: backup.membership_history,
      currency_settings: backup.currency_settings,
      apply_currency_settings: false,
    });

    expect(session.membership_mapping[membershipId]).not.toBe(
      target.membership_id,
    );
    expect(
      (
        await adminDb()
          .collection(COLLECTIONS.memberships)
          .where('budget_id', '==', target.budget_id)
          .get()
      ).size,
    ).toBe(1);

    for (const collection of BACKUP_COLLECTIONS) {
      const records = backup.datasets[collection];
      if (records.length === 0) continue;
      await writeBudgetRestoreChunk(deps, bob, {
        restore_id: session.restore_id,
        chunk_id: `verified-${collection}`,
        documents: records.map((record) => ({
          collection,
          document_id: record.document_id,
          data: record.data,
        })),
      });
    }
    await commitBudgetRestore(deps, bob, { restore_id: session.restore_id });
    const after = await exportBudgetBackup(deps, bob, {
      budget_id: target.budget_id,
    });
    const anonymized = after.membership_history.find(
      (record) => record.document_id === session.membership_mapping[membershipId],
    );
    expect(anonymized?.data.user_id).toBeNull();
    expect(
      (
        await adminDb()
          .collection(COLLECTIONS.memberships)
          .where('budget_id', '==', target.budget_id)
          .get()
      ).size,
    ).toBe(1);
  });

  it('rejects unauthorized targets and keeps the current revision unchanged on failed commit', async () => {
    const deps = testDeps();
    const { budget } = await seedCompleteBudget(deps, alice);
    const backup = await exportBudgetBackup(deps, alice, {
      budget_id: budget.budget_id,
    });
    const target = await createBudget(deps, bob, { name: 'Private target' });
    await adminDb()
      .doc(`categories/existing-${target.budget_id}`)
      .set({
        budget_id: target.budget_id,
        name: 'Existing target category',
        kind: 'EXPENSE',
      });
    const targetBeforeRestore = await exportBudgetBackup(deps, bob, {
      budget_id: target.budget_id,
    });
    const root = adminDb().doc(`budgets/${target.budget_id}`);
    const before = (await root.get()).data();
    const failingChunkCounts: Record<string, number> = countsFor(backup);
    failingChunkCounts.categories += 1;
    const failingChunkSession = await beginBudgetRestore(deps, bob, {
      budget_id: target.budget_id,
      expected_revision_id: null,
      document_counts: failingChunkCounts,
      source_memberships: backup.membership_history,
      currency_settings: backup.currency_settings,
      apply_currency_settings: false,
    });
    const categories = [
      ...backup.datasets.categories,
      {
        document_id: 'category-failing-chunk',
        data: {
          ...backup.datasets.categories[0].data,
          name: 'Must not become visible',
        },
      },
    ];
    await expect(
      writeBudgetRestoreChunk(
        { ...deps, db: failingDb(adminDb(), 2) },
        bob,
        {
          restore_id: failingChunkSession.restore_id,
          chunk_id: 'failing-category-chunk',
          documents: categories.map((record) => ({
            collection: COLLECTIONS.categories,
            ...record,
          })),
        },
      ),
    ).rejects.toThrow('Injected failure');
    expect(
      (
        await adminDb()
          .collection(
            `budgets/${target.budget_id}/revisions/${failingChunkSession.revision_id}/categories`,
          )
          .get()
      ).size,
    ).toBe(0);
    expect((await root.get()).data()).toEqual(before);
    expect(
      (await exportBudgetBackup(deps, bob, { budget_id: target.budget_id }))
        .datasets.categories,
    ).toEqual(targetBeforeRestore.datasets.categories);

    await expect(
      beginBudgetRestore(deps, alice, {
        budget_id: target.budget_id,
        expected_revision_id: null,
        document_counts: countsFor(backup),
        source_memberships: backup.membership_history,
        currency_settings: backup.currency_settings,
        apply_currency_settings: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });

    const session = await uploadPayload(
      deps,
      bob,
      target.budget_id,
      null,
      backup,
    );
    const failingDeps = {
      ...deps,
      db: failingDb(adminDb(), 2),
    };
    await expect(
      commitBudgetRestore(failingDeps, bob, {
        restore_id: session.restore_id,
      }),
    ).rejects.toThrow('Injected failure');
    expect((await root.get()).data()).toEqual(before);
    expect((await root.get()).get('active_revision_id')).toBeNull();
    const targetAfterRestore = await exportBudgetBackup(deps, bob, {
      budget_id: target.budget_id,
    });
    expect(targetAfterRestore.datasets.categories).toEqual(
      targetBeforeRestore.datasets.categories,
    );
  });
});
