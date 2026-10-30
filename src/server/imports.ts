import { createHash } from 'node:crypto';
import type {
  DocumentReference,
  DocumentSnapshot,
  Query,
} from 'firebase-admin/firestore';
import type {
  CommitCsvImportResult,
  ImportPeriodView,
  StatementImportRowRequest,
} from '../shared/contracts';
import {
  budgetCollectionPath,
  budgetDocumentPath,
  COLLECTIONS,
} from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { findMatchingUserRule } from '../shared/domain/transactions';
import { validateCommitCsvImportRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import { accountFromSnapshot, toTimestamp } from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';

const HASH_INDEX = 'import_batch_file_hashes';
const TRANSACTIONS = 'transactions';
const IMPORT_BATCHES = 'import_batches';
const IMPORT_PERIODS = 'import_periods';
const BALANCE_SNAPSHOTS = 'account_balance_snapshots';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function importHashKey(accountId: string, fileHash: string): string {
  return sha256(`${accountId}\0${fileHash}`);
}

export function importBatchFileHashDocumentId(
  accountId: string,
  fileHash: string,
): string {
  return importHashKey(accountId, fileHash);
}

function bankKey(accountId: string, bankId: string): string {
  const hex = sha256(`${accountId}\0${bankId}`).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function normalizedFingerprint(row: StatementImportRowRequest): string {
  const description = row
    .description!.normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pl-PL');
  const amount = row.amount!.replace(/^\+/, '');
  return sha256(
    [
      row.operation_date,
      description,
      amount,
      row.currency,
      row.transaction_type,
    ].join('\0'),
  );
}

function balanceSnapshotId(accountId: string, date: string): string {
  return sha256(`${accountId}\0${date}`);
}

function periodsFor(dates: readonly string[]): ImportPeriodView[] {
  const uniqueDates = [...new Set(dates)].sort();
  const periods: ImportPeriodView[] = [];
  for (const date of uniqueDates) {
    const current = periods.at(-1);
    if (!current) {
      periods.push({ period_start: date, period_end: date });
      continue;
    }
    const nextDay = new Date(`${current.period_end}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (nextDay.toISOString().slice(0, 10) === date) {
      current.period_end = date;
    } else {
      periods.push({ period_start: date, period_end: date });
    }
  }
  return periods;
}

function priorResult(
  value: FirebaseFirestore.DocumentData,
): CommitCsvImportResult {
  return {
    import_batch_id: value.import_batch_id as string,
    imported_row_count: value.imported_row_count as number,
    skipped_duplicate_row_numbers:
      (value.skipped_duplicate_row_numbers as number[] | undefined) ?? [],
    periods: (value.periods as ImportPeriodView[] | undefined) ?? [],
    already_imported: true,
  };
}

interface RowReference {
  row: StatementImportRowRequest;
  fingerprint: string;
  transactionId: string;
  transactionRef: DocumentReference;
  duplicateCheck:
    | { kind: 'bank'; ref: DocumentReference }
    | { kind: 'fingerprint'; query: Query };
  previousDuplicate?: DocumentSnapshot;
}

/**
 * Commits a reviewed CSV preview in a single Firestore transaction.
 *
 * CSV ownership is never client-selectable: the account must belong to the
 * authenticated caller's active membership. Idempotency and per-row keys are
 * persisted in the same transaction as batches and transactions.
 */
export async function commitCsvImport(
  deps: ServerDeps,
  caller: Caller | null,
  request: unknown,
): Promise<CommitCsvImportResult> {
  const { uid } = requireCaller(caller);
  const validated = validateCommitCsvImportRequest(request);
  if (!validated) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid CSV import request.');
  }

  const importId = deps.newId();

  return deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(
      deps,
      tx,
      validated.budget_id,
      uid,
    );
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const accountRef = deps.db.doc(
      budgetDocumentPath(
        validated.budget_id,
        actor.active_revision_id,
        COLLECTIONS.accounts,
        validated.account_id,
      ),
    );
    const batchRef = deps.db.doc(
      budgetDocumentPath(
        validated.budget_id,
        actor.active_revision_id,
        IMPORT_BATCHES,
        importId,
      ),
    );
    const hashRef = deps.db.doc(
      budgetDocumentPath(
        validated.budget_id,
        actor.active_revision_id,
        HASH_INDEX,
        importHashKey(validated.account_id, validated.file_sha256),
      ),
    );

    const [accountSnap, previousHash] = await Promise.all([
      tx.get(accountRef),
      tx.get(hashRef),
    ]);
    if (!accountSnap.exists) throw new DomainError('NOT_FOUND');
    const account = accountFromSnapshot(accountSnap);
    if (account.budget_id !== validated.budget_id) {
      throw new DomainError('NOT_FOUND');
    }
    if (account.archived_at) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'An archived account cannot receive an import.',
      );
    }
    if (account.owner_membership_id !== actor.membership_id) {
      throw new DomainError(
        'PERMISSION_DENIED',
        'CSV imports must belong to the signed-in member.',
      );
    }
    if (previousHash.exists) {
      const existingBatch = await tx.get(
        deps.db.doc(
          budgetDocumentPath(
            validated.budget_id,
            actor.active_revision_id,
            IMPORT_BATCHES,
            previousHash.get('import_batch_id') as string,
          ),
        ),
      );
      if (!existingBatch.exists) {
        throw new Error('Import hash index points to a missing batch.');
      }
      return priorResult(previousHash.data() ?? {});
    }

    const [categories, categorizationRules] = await Promise.all([
      tx.get(
        deps.db
          .collection(
            budgetCollectionPath(
              validated.budget_id,
              actor.active_revision_id,
              COLLECTIONS.categories,
            ),
          )
          .where('budget_id', '==', validated.budget_id),
      ),
      tx.get(
        deps.db
          .collection(
            budgetCollectionPath(
              validated.budget_id,
              actor.active_revision_id,
              COLLECTIONS.categorizationRules,
            ),
          )
          .where('budget_id', '==', validated.budget_id)
          .where('source', '==', 'USER')
          .where('enabled', '==', true),
      ),
    ]);
    const categoriesById = new Map(
      categories.docs.map((category) => [category.id, category]),
    );

    const includeRows = validated.rows.filter(
      (row) => row.decision === 'include',
    );
    const refs: RowReference[] = includeRows.map((row) => {
      const fingerprint = normalizedFingerprint(row);
      if (row.bank_transaction_id) {
        const transactionId = bankKey(
          validated.account_id,
          row.bank_transaction_id,
        );
        const transactionRef = deps.db.doc(
          budgetDocumentPath(
            validated.budget_id,
            actor.active_revision_id,
            TRANSACTIONS,
            transactionId,
          ),
        );
        return {
          row,
          fingerprint,
          transactionId,
          transactionRef,
          duplicateCheck: { kind: 'bank', ref: transactionRef },
        };
      }
      const duplicateQuery = deps.db
        .collection(
          budgetCollectionPath(
            validated.budget_id,
            actor.active_revision_id,
            TRANSACTIONS,
          ),
        )
        .where('account_id', '==', validated.account_id)
        .where('normalized_fingerprint', '==', fingerprint)
        .limit(1);
      const transactionId = deps.newId();
      return {
        row,
        fingerprint,
        transactionId,
        transactionRef: deps.db.doc(
          budgetDocumentPath(
            validated.budget_id,
            actor.active_revision_id,
            TRANSACTIONS,
            transactionId,
          ),
        ),
        duplicateCheck: { kind: 'fingerprint', query: duplicateQuery },
      };
    });

    const duplicateSnapshots = await Promise.all(
      refs.map((item) =>
        item.duplicateCheck.kind === 'bank'
          ? tx.get(item.duplicateCheck.ref)
          : tx.get(item.duplicateCheck.query),
      ),
    );
    refs.forEach((item, index) => {
      const snapshot = duplicateSnapshots[index];
      item.previousDuplicate = 'docs' in snapshot ? snapshot.docs[0] : snapshot;
    });

    const balanceRows = new Map<string, { amount: string; currency: string }>();
    for (const row of includeRows) {
      if (row.balance && row.balance_currency && row.operation_date) {
        balanceRows.set(row.operation_date, {
          amount: row.balance,
          currency: row.balance_currency,
        });
      }
    }
    const balanceRefs = new Map(
      [...balanceRows.keys()].map((date) => [
        date,
        deps.db.doc(
          budgetDocumentPath(
            validated.budget_id,
            actor.active_revision_id,
            BALANCE_SNAPSHOTS,
            balanceSnapshotId(validated.account_id, date),
          ),
        ),
      ]),
    );
    const existingBalances = await Promise.all(
      [...balanceRefs.values()].map((ref) => tx.get(ref)),
    );
    const existingBalanceByDate = new Map(
      [...balanceRefs.keys()].map((date, index) => [
        date,
        existingBalances[index].exists,
      ]),
    );

    const accepted: RowReference[] = [];
    const skippedDuplicateRows: number[] = validated.rows
      .filter((row) => row.decision === 'exclude')
      .map((row) => row.row_number);
    const seenFingerprints = new Set<string>();
    const seenBankIds = new Set<string>();

    for (const item of refs) {
      const bankId = item.row.bank_transaction_id;
      if (item.previousDuplicate?.exists) {
        if (item.duplicateCheck.kind === 'bank') {
          skippedDuplicateRows.push(item.row.row_number);
          continue;
        }
        const decision = item.row.possible_duplicate_decision;
        if (!decision || decision === 'pending') {
          throw new DomainError(
            'DUPLICATE_REVIEW_REQUIRED',
            `Row ${item.row.row_number} may duplicate an existing transaction and requires an explicit decision.`,
          );
        }
        if (decision === 'exclude') {
          skippedDuplicateRows.push(item.row.row_number);
          continue;
        }
        accepted.push(item);
        seenFingerprints.add(item.fingerprint);
        continue;
      }

      if (bankId && seenBankIds.has(bankId)) {
        skippedDuplicateRows.push(item.row.row_number);
        continue;
      }
      const possibleDuplicate = seenFingerprints.has(item.fingerprint);
      if (possibleDuplicate) {
        const decision = item.row.possible_duplicate_decision;
        if (!decision || decision === 'pending') {
          throw new DomainError(
            'DUPLICATE_REVIEW_REQUIRED',
            `Row ${item.row.row_number} may duplicate an existing transaction and requires an explicit decision.`,
          );
        }
        if (decision === 'exclude') {
          skippedDuplicateRows.push(item.row.row_number);
          continue;
        }
      }

      accepted.push(item);
      seenFingerprints.add(item.fingerprint);
      if (bankId) seenBankIds.add(bankId);
    }

    const balanceRowsToWrite = new Map(
      accepted.flatMap((item) =>
        item.row.balance && item.row.balance_currency && item.row.operation_date
          ? [
              [
                item.row.operation_date,
                {
                  amount: item.row.balance,
                  currency: item.row.balance_currency,
                },
              ] as const,
            ]
          : [],
      ),
    );
    const periods = periodsFor(
      accepted.map((item) => item.row.operation_date!),
    );
    const now = deps.now();
    for (const item of accepted) {
      const row = item.row;
      const rule = findMatchingUserRule(
        {
          description: row.description!,
          amount: row.amount!,
          account_id: validated.account_id,
        },
        categorizationRules.docs.map((candidate) => ({
          rule_id: candidate.id,
          category_id: candidate.get('category_id') as string,
          match_field: candidate.get('match_field'),
          operator: candidate.get('operator'),
          match_value: candidate.get('match_value') as string,
          priority: candidate.get('priority') as number,
          enabled: candidate.get('enabled') === true,
        })),
      );
      const matchedCategory = rule
        ? categoriesById.get(rule.category_id)
        : undefined;
      const categoryId =
        matchedCategory &&
        matchedCategory.get('kind') === row.transaction_type &&
        matchedCategory.get('archived_at') == null
          ? matchedCategory.id
          : null;
      tx.create(item.transactionRef, {
        budget_id: validated.budget_id,
        account_id: validated.account_id,
        import_batch_id: importId,
        source_row_number: row.row_number,
        bank_transaction_id: row.bank_transaction_id ?? null,
        normalized_fingerprint: item.fingerprint,
        operation_date: row.operation_date,
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        type: row.transaction_type,
        category_id: categoryId,
        fee: row.fee ?? null,
        source_status: row.source_status ?? null,
        balance: row.balance ?? null,
        balance_currency: row.balance_currency ?? null,
        created_by_membership_id: actor.membership_id,
        imported_by_membership_id: actor.membership_id,
        created_at: toTimestamp(now),
      });
    }

    tx.create(batchRef, {
      budget_id: validated.budget_id,
      account_id: validated.account_id,
      imported_by_membership_id: actor.membership_id,
      file_sha256: validated.file_sha256,
      source_format: 'CSV',
      parser_id: validated.parser_id,
      parser_version: validated.parser_version,
      status: 'IMPORTED',
      imported_at: toTimestamp(now),
      row_count: accepted.length,
      source_row_count: validated.rows.length,
      skipped_duplicate_row_numbers: skippedDuplicateRows,
    });
    for (const period of periods) {
      const periodId = deps.newId();
      tx.create(
        deps.db.doc(
          budgetDocumentPath(
            validated.budget_id,
            actor.active_revision_id,
            IMPORT_PERIODS,
            periodId,
          ),
        ),
        {
          budget_id: validated.budget_id,
          import_batch_id: importId,
          period_start: period.period_start,
          period_end: period.period_end,
        },
      );
    }
    for (const [date, balance] of balanceRowsToWrite) {
      const ref = balanceRefs.get(date)!;
      const data = {
        account_id: validated.account_id,
        import_batch_id: importId,
        balance_date: date,
        balance_amount: balance.amount,
        currency: balance.currency,
        source: 'STATEMENT',
        created_by_membership_id: actor.membership_id,
        created_at: toTimestamp(now),
      };
      if (existingBalanceByDate.get(date)) {
        tx.set(ref, data);
      } else {
        tx.create(ref, data);
      }
    }

    const result: CommitCsvImportResult = {
      import_batch_id: importId,
      imported_row_count: accepted.length,
      skipped_duplicate_row_numbers: skippedDuplicateRows,
      periods,
      already_imported: false,
    };
    tx.create(hashRef, {
      import_batch_id: importId,
      imported_row_count: result.imported_row_count,
      skipped_duplicate_row_numbers: result.skipped_duplicate_row_numbers,
      periods: result.periods,
    });
    return result;
  });
}
