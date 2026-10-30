import { createHash } from 'node:crypto';
import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from 'firebase-admin/firestore';
import type {
  BeginBudgetRestoreRequest,
  BeginBudgetRestoreResult,
  RestoreDocument,
  WriteBudgetRestoreChunkRequest,
} from '../shared/contracts';
import type {
  BackupPayload,
  BackupRecord,
} from '../shared/domain/backup';
import { validateBackupPayload } from '../shared/domain/backup';
import {
  BACKUP_COLLECTIONS,
  budgetCollectionPath,
  budgetRevisionPath,
  COLLECTIONS,
  activeMemberPath,
} from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { readActiveMembership } from './access';
import { requireCaller, type Caller, type ServerDeps } from './context';
import { importBatchFileHashDocumentId } from './imports';

const HISTORY_COLLECTION = 'membership_history';
const RESTORE_CHUNKS_COLLECTION = '_restore_chunks';
const MAX_RESTORE_CHUNK_DOCUMENTS = 250;
const MAX_DOCUMENT_ID_LENGTH = 512;
const TIMESTAMP_MARKER = '__incomeTrackerTimestamp';
const FORBIDDEN_FIELD =
  /(?:password|passwd|token|secret|credential|private_key)/i;
const MEMBERSHIP_REFERENCE = /(?:^|_)membership_id$/;
const MEMBERSHIP_FIELDS = new Set([
  'owner_membership_id',
  'created_by_membership_id',
  'confirmed_by_membership_id',
  'hidden_by_membership_id',
  'imported_by_membership_id',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DomainError('INVALID_ARGUMENT', `Invalid backup ${label}.`);
  }
  return value;
}

function requireBudgetId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('/') ||
    value.length > MAX_DOCUMENT_ID_LENGTH
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid budget identifier.');
  }
  return value;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return { [TIMESTAMP_MARKER]: value.toDate().toISOString() };
  }
  if (value instanceof Date) {
    return { [TIMESTAMP_MARKER]: value.toISOString() };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serializeValue(nested)]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new DomainError(
    'INVALID_ARGUMENT',
    'A budget contains a value that cannot be included in a backup.',
  );
}

function hydrateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateValue);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (
    keys.length === 1 &&
    keys[0] === TIMESTAMP_MARKER &&
    typeof value[TIMESTAMP_MARKER] === 'string'
  ) {
    const date = new Date(value[TIMESTAMP_MARKER]);
    if (Number.isNaN(date.getTime())) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid backup timestamp.');
    }
    return date;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, hydrateValue(nested)]),
  );
}

function assertNoSecrets(value: unknown, path = 'backup'): void {
  if (Array.isArray(value)) {
    value.forEach((nested, index) =>
      assertNoSecrets(nested, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `Backup contains a forbidden authentication field (${path}.${key}).`,
      );
    }
    assertNoSecrets(nested, `${path}.${key}`);
  }
}

function mapMembershipReferences(
  value: unknown,
  mapping: Record<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) => mapMembershipReferences(nested, mapping));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      if (
        (MEMBERSHIP_REFERENCE.test(key) || MEMBERSHIP_FIELDS.has(key)) &&
        typeof nested === 'string'
      ) {
        const mapped = mapping[nested];
        if (!mapped) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'The backup references an unknown membership. No access was restored.',
          );
        }
        return [key, mapped];
      }
      return [key, mapMembershipReferences(nested, mapping)];
    }),
  );
}

function documentHash(documents: RestoreDocument[]): string {
  return createHash('sha256')
    .update(JSON.stringify(documents))
    .digest('hex');
}

function validDocumentId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_DOCUMENT_ID_LENGTH &&
    !id.includes('/')
  );
}

function requiredCountMap(value: unknown): Record<string, number> {
  const input = requireRecord(value, 'document counts');
  const allowed = new Set<string>([...BACKUP_COLLECTIONS, HISTORY_COLLECTION]);
  const counts: Record<string, number> = {};
  for (const name of allowed) {
    const count = input[name];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `Invalid document count for ${name}.`,
      );
    }
    counts[name] = count as number;
  }
  if (
    Object.keys(input).some((name) => !allowed.has(name)) ||
    Object.keys(input).length !== allowed.size
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'The restore manifest does not match the supported backup schema.',
    );
  }
  return counts;
}

function membershipData(record: BackupRecord): Record<string, unknown> {
  const data = requireRecord(record.data, 'membership history');
  if (
    typeof data.budget_id !== 'string' ||
    typeof data.role !== 'string' ||
    typeof data.status !== 'string' ||
    (data.user_id !== null && typeof data.user_id !== 'string')
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'The backup membership history is invalid.',
    );
  }
  return data;
}

function remapMembershipHistory(
  memberships: BackupRecord[],
  mapping: Record<string, string>,
  verifiedMembershipIds: Set<string>,
  budgetId: string,
  now: Date,
): BackupRecord[] {
  return memberships.flatMap((record) => {
    const data = membershipData(record);
    const mappedId = mapping[record.document_id];
    if (!mappedId) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'The backup membership history is incomplete.',
      );
    }
    if (verifiedMembershipIds.has(mappedId)) return [];
    return [
      {
        document_id: mappedId,
        data: {
          ...data,
          membership_id: mappedId,
          budget_id: budgetId,
          user_id: null,
          status: data.status === 'ACTIVE' ? 'LEFT' : data.status,
          ended_at:
            data.status === 'ACTIVE'
              ? { [TIMESTAMP_MARKER]: now.toISOString() }
              : data.ended_at,
        },
      },
    ];
  });
}

async function getMembershipMapping(
  deps: ServerDeps,
  budgetId: string,
  sourceMemberships: BackupRecord[],
): Promise<{
  mapping: Record<string, string>;
  verifiedIds: Set<string>;
}> {
  const targetMemberships = await deps.db
    .collection(COLLECTIONS.memberships)
    .where('budget_id', '==', budgetId)
    .where('status', '==', 'ACTIVE')
    .get();
  const activeByUser = new Map<string, string>();
  const verifiedIds = new Set<string>();
  await Promise.all(
    targetMemberships.docs.map(async (membership) => {
      const userId = membership.get('user_id');
      if (typeof userId !== 'string') return;
      const access = await deps.db.doc(activeMemberPath(budgetId, userId)).get();
      if (access.exists && access.get('membership_id') === membership.id) {
        activeByUser.set(userId, membership.id);
        verifiedIds.add(membership.id);
      }
    }),
  );

  const mapping: Record<string, string> = {};
  for (const source of sourceMemberships) {
    const data = membershipData(source);
    const userId = data.user_id;
    mapping[source.document_id] =
      typeof userId === 'string' && activeByUser.has(userId)
        ? activeByUser.get(userId)!
        : deps.newId();
  }
  return { mapping, verifiedIds };
}

function validCurrencySettings(
  value: unknown,
): BeginBudgetRestoreRequest['currency_settings'] {
  if (value === null) return null;
  const settings = requireRecord(value, 'currency settings');
  if (
    typeof settings.primary_currency !== 'string' ||
    !/^[A-Z]{3}$/.test(settings.primary_currency) ||
    !Array.isArray(settings.secondary_currencies) ||
    settings.secondary_currencies.some(
      (currency) =>
        typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency),
    )
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid backup currency settings.');
  }
  return {
    primary_currency: settings.primary_currency,
    secondary_currencies: settings.secondary_currencies as string[],
  };
}

export async function exportBudgetBackup(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<BackupPayload> {
  const { uid } = requireCaller(caller);
  const request = requireRecord(input, 'export request');
  const budgetId = requireBudgetId(request.budget_id);
  const access = await deps.db.runTransaction(async (tx) => {
    const membership = await readActiveMembership(deps, tx, budgetId, uid);
    if (!membership) throw new DomainError('NOT_ACTIVE_MEMBER');
    const budget = await tx.get(
      deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`),
    );
    return {
      revisionId: membership.active_revision_id,
      name: budget.get('name') as string,
    };
  });
  const datasets = {} as BackupPayload['datasets'];
  for (const collectionName of BACKUP_COLLECTIONS) {
    const snapshot = await deps.db
      .collection(
        budgetCollectionPath(budgetId, access.revisionId, collectionName),
      )
      .get();
    const documents =
      access.revisionId === null &&
      collectionName === COLLECTIONS.exchangeRates
        ? []
        : snapshot.docs;
    datasets[collectionName] = documents.map((document) => ({
      document_id: document.id,
      data: serializeValue(document.data()) as Record<string, unknown>,
    }));
  }

  const [liveMemberships, revisionMemberships] = await Promise.all([
    deps.db
      .collection(COLLECTIONS.memberships)
      .where('budget_id', '==', budgetId)
      .get(),
    access.revisionId === null
      ? Promise.resolve(null)
      : deps.db
          .collection(
            budgetCollectionPath(
              budgetId,
              access.revisionId,
              HISTORY_COLLECTION,
            ),
          )
          .get(),
  ]);
  const membershipById = new Map(
    (revisionMemberships?.docs ?? []).map((document) => [
      document.id,
      document,
    ]),
  );
  liveMemberships.docs.forEach((document) =>
    membershipById.set(document.id, document),
  );
  const membershipHistory = [...membershipById.values()].map((document) => ({
    document_id: document.id,
    data: serializeValue(document.data()) as Record<string, unknown>,
  }));
  const referencedRates = new Set(
    [
      ...datasets.transaction_conversions.map(
        (record) => record.data.exchange_rate_id,
      ),
      ...datasets.transfer_groups.map((record) => record.data.fx_rate_id),
    ].filter((id): id is string => typeof id === 'string'),
  );
  const presentRateIds = new Set(
    datasets.exchange_rates.map((record) => record.document_id),
  );
  const missingRates = await Promise.all(
    [...referencedRates]
      .filter((id) => !presentRateIds.has(id))
      .map((id) => deps.db.doc(`${COLLECTIONS.exchangeRates}/${id}`).get()),
  );
  datasets.exchange_rates.push(
    ...missingRates
      .filter((rate) => rate.exists)
      .map((rate) => ({
        document_id: rate.id,
        data: serializeValue(rate.data() ?? {}) as Record<string, unknown>,
      })),
  );
  const preferences = await deps.db
    .doc(`${COLLECTIONS.userPreferences}/${uid}`)
    .get();
  const currencySettings = preferences.exists
    ? {
        primary_currency: preferences.get('primary_currency') as string,
        secondary_currencies: preferences.get(
          'secondary_currencies',
        ) as string[],
      }
    : null;
  const payload: BackupPayload = {
    format: 'income-tracker-backup',
    schema_version: 2,
    created_at: deps.now().toISOString(),
    source_budget: { budget_id: budgetId, name: access.name },
    datasets,
    membership_history: membershipHistory,
    currency_settings: currencySettings,
    statement_files: [],
  };
  assertNoSecrets(payload);
  return payload;
}

export async function beginBudgetRestore(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<BeginBudgetRestoreResult> {
  const { uid } = requireCaller(caller);
  const request = requireRecord(input, 'restore request');
  const budgetId = requireBudgetId(request.budget_id);
  const expectedRevisionId =
    request.expected_revision_id === null
      ? null
      : requireBudgetId(request.expected_revision_id);
  const counts = requiredCountMap(request.document_counts);
  if (!Array.isArray(request.source_memberships)) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid backup membership history.');
  }
  const sourceMemberships = request.source_memberships.map((record, index) => {
    if (
      !isRecord(record) ||
      !validDocumentId(record.document_id) ||
      !isRecord(record.data)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `Invalid backup membership at index ${index}.`,
      );
    }
    return { document_id: record.document_id, data: record.data };
  });
  if (sourceMemberships.length !== counts[HISTORY_COLLECTION]) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'The restore manifest does not match the membership history.',
    );
  }
  const currencySettings = validCurrencySettings(request.currency_settings);
  const shouldApplySettings = request.apply_currency_settings === true;
  const membership = await deps.db.runTransaction(async (tx) => {
    const active = await readActiveMembership(deps, tx, budgetId, uid);
    if (!active) throw new DomainError('NOT_ACTIVE_MEMBER');
    if (active.active_revision_id !== expectedRevisionId) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'The budget changed while the restore was being prepared. Review it again.',
      );
    }
    return active;
  });
  const { mapping, verifiedIds } = await getMembershipMapping(
    deps,
    budgetId,
    sourceMemberships,
  );
  const restoreId = deps.newId();
  const revisionId = deps.newId();
  const safeHistory = remapMembershipHistory(
    sourceMemberships,
    mapping,
    verifiedIds,
    budgetId,
    deps.now(),
  );
  counts[HISTORY_COLLECTION] = safeHistory.length;
  for (const mappedId of Object.values(mapping)) {
    mapping[mappedId] ??= mappedId;
  }
  const sessionRef = deps.db.doc(
    `${COLLECTIONS.restoreSessions}/${restoreId}`,
  );
  await sessionRef.create({
    owner_uid: uid,
    budget_id: budgetId,
    expected_revision_id: membership.active_revision_id,
    revision_id: revisionId,
    status: 'STAGING',
    document_counts: counts,
    received_counts: Object.fromEntries(
      Object.keys(counts).map((collectionName) => [collectionName, 0]),
    ),
    membership_mapping: mapping,
    verified_membership_ids: [...verifiedIds],
    apply_currency_settings: shouldApplySettings,
    currency_settings: currencySettings,
    created_at: deps.now(),
  });
  if (safeHistory.length > 0) {
    const historyDocuments: RestoreDocument[] = safeHistory.map((record) => ({
      collection: HISTORY_COLLECTION,
      document_id: record.document_id,
      data: record.data,
    }));
    for (let offset = 0; offset < historyDocuments.length; offset += MAX_RESTORE_CHUNK_DOCUMENTS) {
      await writeRestoreChunkForSession(
        deps,
        sessionRef,
        restoreId,
        {
          restore_id: restoreId,
          chunk_id: `membership-history-${offset}`,
          documents: historyDocuments.slice(
            offset,
            offset + MAX_RESTORE_CHUNK_DOCUMENTS,
          ),
        },
        uid,
      );
    }
  }
  return { restore_id: restoreId, revision_id: revisionId, membership_mapping: mapping };
}

async function writeRestoreChunkForSession(
  deps: ServerDeps,
  sessionRef: FirebaseFirestore.DocumentReference,
  restoreId: string,
  request: WriteBudgetRestoreChunkRequest,
  uid: string,
): Promise<void> {
  if (
    !validDocumentId(request.chunk_id) ||
    request.documents.length === 0 ||
    request.documents.length > MAX_RESTORE_CHUNK_DOCUMENTS
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid restore data chunk.');
  }
  const chunkCollection = request.documents[0].collection;
  if (
    ![...BACKUP_COLLECTIONS, HISTORY_COLLECTION].includes(
      chunkCollection as (typeof BACKUP_COLLECTIONS)[number],
    ) ||
    request.documents.some(
      (document) =>
        !document ||
        typeof document !== 'object' ||
        !validDocumentId(document.document_id) ||
        !isRecord(document.data),
    ) ||
    request.documents.some(
      (document) => document.collection !== chunkCollection,
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'A restore chunk must contain documents from one supported dataset.',
    );
  }
  const target = await sessionRef.get();
  if (
    !target.exists ||
    target.get('owner_uid') !== uid ||
    target.get('status') !== 'STAGING'
  ) {
    throw new DomainError('NOT_FOUND', 'Restore session is unavailable.');
  }
  const budgetId = target.get('budget_id') as string;
  const revisionId = target.get('revision_id') as string;
  const mapping = target.get('membership_mapping') as Record<string, string>;
  const verifiedIds = new Set(
    (target.get('verified_membership_ids') as string[] | undefined) ?? [],
  );
  const documents = request.documents.map((document) => {
    if (!validDocumentId(document.document_id)) {
      throw new DomainError('INVALID_ARGUMENT', 'Invalid restore document id.');
    }
    const data = requireRecord(document.data, 'document');
    assertNoSecrets(data);
    const mapped = mapMembershipReferences(data, mapping) as Record<
      string,
      unknown
    >;
    if (chunkCollection === HISTORY_COLLECTION) {
      const mappedId = mapping[document.document_id];
      if (!mappedId) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'The backup membership history is invalid.',
        );
      }
      if (!verifiedIds.has(mappedId)) {
        mapped.user_id = null;
        if (mapped.status === 'ACTIVE') {
          mapped.status = 'LEFT';
          mapped.ended_at = Timestamp.fromDate(deps.now());
        }
      }
      mapped.membership_id = mappedId;
      mapped.budget_id = budgetId;
      return { ...document, document_id: mappedId, data: mapped };
    }
    if (typeof mapped.budget_id === 'string') mapped.budget_id = budgetId;
    return { ...document, data: mapped };
  });
  const expected = target.get('document_counts') as Record<string, number>;
  if (
    (target.get('received_counts') as Record<string, number>)[chunkCollection] +
      documents.length >
    expected[chunkCollection]
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `The restore contains too many ${chunkCollection} documents.`,
    );
  }
  const revisionPath = budgetRevisionPath(budgetId, revisionId);
  const receiptRef = deps.db.doc(
    `${revisionPath}/${RESTORE_CHUNKS_COLLECTION}/${request.chunk_id}`,
  );
  const refs = documents.map((document) =>
    deps.db.doc(
      `${revisionPath}/${document.collection}/${document.document_id}`,
    ),
  );
  const hash = documentHash(request.documents);
  await deps.db.runTransaction(async (tx) => {
    const [receipt, session] = await Promise.all([
      tx.get(receiptRef),
      tx.get(sessionRef),
    ]);
    if (
      !session.exists ||
      session.get('owner_uid') !== uid ||
      session.get('status') !== 'STAGING'
    ) {
      throw new DomainError('NOT_FOUND', 'Restore session is unavailable.');
    }
    if (receipt.exists) {
      if (receipt.get('hash') !== hash) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'A restore chunk id was reused with different content.',
        );
      }
      return;
    }
    const existing = await Promise.all(refs.map((ref) => tx.get(ref)));
    if (existing.some((document) => document.exists)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'The restore contains a duplicate document id.',
      );
    }
    for (const [index, document] of documents.entries()) {
      tx.create(refs[index], hydrateValue(document.data) as DocumentData);
    }
    tx.create(receiptRef, {
      hash,
      collection: chunkCollection,
      document_count: documents.length,
    });
    const counts = session.get('received_counts') as Record<string, number>;
    tx.update(sessionRef, {
      received_counts: {
        ...counts,
        [chunkCollection]: counts[chunkCollection] + documents.length,
      },
    });
  });
}

export async function writeBudgetRestoreChunk(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request = requireRecord(input, 'restore chunk');
  if (
    typeof request.restore_id !== 'string' ||
    !validDocumentId(request.restore_id) ||
    typeof request.chunk_id !== 'string' ||
    !validDocumentId(request.chunk_id) ||
    !Array.isArray(request.documents)
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid restore chunk.');
  }
  const sessionRef = deps.db.doc(
    `${COLLECTIONS.restoreSessions}/${request.restore_id}`,
  );
  const session = await sessionRef.get();
  if (!session.exists || session.get('owner_uid') !== uid) {
    throw new DomainError('NOT_FOUND', 'Restore session is unavailable.');
  }
  const active = await deps.db.runTransaction((tx) =>
    readActiveMembership(
      deps,
      tx,
      session.get('budget_id') as string,
      uid,
    ),
  );
  if (
    !active ||
    active.active_revision_id !== session.get('expected_revision_id')
  ) {
    throw new DomainError(
      'NOT_ACTIVE_MEMBER',
      'Budget access changed during restore.',
    );
  }
  await writeRestoreChunkForSession(
    deps,
    sessionRef,
    request.restore_id,
    request as unknown as WriteBudgetRestoreChunkRequest,
    uid,
  );
}

async function validateStagedRevision(
  deps: ServerDeps,
  budgetId: string,
  revisionId: string,
): Promise<void> {
  const path = budgetRevisionPath(budgetId, revisionId);
  const datasets = {} as BackupPayload['datasets'];
  for (const collectionName of BACKUP_COLLECTIONS) {
    const snapshot = await deps.db
      .collection(`${path}/${collectionName}`)
      .get();
    datasets[collectionName] = snapshot.docs.map((document) => ({
      document_id: document.id,
      data: serializeValue(document.data()) as Record<string, unknown>,
    }));
  }
  const [budget, storedHistory, liveHistory] = await Promise.all([
    deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`).get(),
    deps.db.collection(`${path}/${HISTORY_COLLECTION}`).get(),
    deps.db
      .collection(COLLECTIONS.memberships)
      .where('budget_id', '==', budgetId)
      .get(),
  ]);
  if (!budget.exists) throw new DomainError('NOT_FOUND');
  const historyById = new Map(
    storedHistory.docs.map((document) => [
      document.id,
      {
        document_id: document.id,
        data: serializeValue(document.data()) as Record<string, unknown>,
      },
    ]),
  );
  liveHistory.docs.forEach((document) =>
    historyById.set(document.id, {
      document_id: document.id,
      data: serializeValue(document.data()) as Record<string, unknown>,
    }),
  );
  validateBackupPayload({
    format: 'income-tracker-backup',
    schema_version: 2,
    created_at: deps.now().toISOString(),
    source_budget: {
      budget_id: budgetId,
      name: budget.get('name') as string,
    },
    datasets,
    membership_history: [...historyById.values()],
    currency_settings: null,
    statement_files: [],
  });
  const importBatches = datasets.import_batches;
  await Promise.all(
    importBatches.map(async (batch) => {
      const data = batch.data;
      const hashId = importBatchFileHashDocumentId(
        data.account_id as string,
        data.file_sha256 as string,
      );
      const periods = await deps.db
        .collection(`${path}/${COLLECTIONS.importPeriods}`)
        .where('import_batch_id', '==', batch.document_id)
        .get();
      await deps.db
        .doc(`${path}/${COLLECTIONS.importBatchFileHashes}/${hashId}`)
        .set({
          import_batch_id: batch.document_id,
          imported_row_count: data.row_count,
          skipped_duplicate_row_numbers:
            data.skipped_duplicate_row_numbers ?? [],
          periods: periods.docs.map((period) => ({
            period_start: period.get('period_start'),
            period_end: period.get('period_end'),
          })),
        });
    }),
  );
}

export async function commitBudgetRestore(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request = requireRecord(input, 'restore commit');
  if (
    typeof request.restore_id !== 'string' ||
    !validDocumentId(request.restore_id)
  ) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid restore session id.');
  }
  const sessionRef = deps.db.doc(
    `${COLLECTIONS.restoreSessions}/${request.restore_id}`,
  );
  const session = await sessionRef.get();
  if (!session.exists || session.get('owner_uid') !== uid) {
    throw new DomainError('NOT_FOUND', 'Restore session is unavailable.');
  }
  const budgetId = session.get('budget_id') as string;
  const revisionId = session.get('revision_id') as string;
  if (session.get('status') === 'COMMITTED') return;
  const expected = session.get('document_counts') as Record<string, number>;
  const received = session.get('received_counts') as Record<string, number>;
  if (Object.entries(expected).some(([name, count]) => received[name] !== count)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'The restore upload is incomplete; the current budget was not changed.',
    );
  }
  try {
    await validateStagedRevision(deps, budgetId, revisionId);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'INVALID_ARGUMENT',
      error instanceof Error
        ? `Restore validation failed: ${error.message}`
        : 'Restore validation failed.',
    );
  }

  await deps.db.runTransaction(async (tx) => {
    const active = await readActiveMembership(deps, tx, budgetId, uid);
    if (!active) throw new DomainError('NOT_ACTIVE_MEMBER');
    const [budget, currentSession] = await Promise.all([
      tx.get(deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`)),
      tx.get(sessionRef),
    ]);
    if (!budget.exists || !currentSession.exists) {
      throw new DomainError('NOT_FOUND');
    }
    if (
      currentSession.get('status') === 'COMMITTED' &&
      budget.get('active_revision_id') === revisionId
    ) {
      return;
    }
    if (
      currentSession.get('status') !== 'STAGING' ||
      active.active_revision_id !==
        currentSession.get('expected_revision_id')
    ) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'The budget changed during restore; no data was replaced.',
      );
    }
    const applySettings =
      currentSession.get('apply_currency_settings') === true;
    const settings = currentSession.get('currency_settings') as
      | BeginBudgetRestoreRequest['currency_settings']
      | undefined;
    const preferencesRef = deps.db.doc(`${COLLECTIONS.userPreferences}/${uid}`);
    const preferences = applySettings ? await tx.get(preferencesRef) : null;
    if (applySettings && settings && !preferences?.exists) {
      throw new DomainError(
        'NOT_FOUND',
        'Currency preferences are unavailable; the budget was not changed.',
      );
    }
    tx.update(budget.ref, { active_revision_id: revisionId });
    if (applySettings && settings && preferences?.exists) {
      tx.set(
        preferencesRef,
        {
          primary_currency: settings.primary_currency,
          secondary_currencies: settings.secondary_currencies,
        },
        { merge: true },
      );
    }
    tx.update(sessionRef, {
      status: 'COMMITTED',
      completed_at: deps.now(),
      membership_mapping: FieldValue.delete(),
      verified_membership_ids: FieldValue.delete(),
    });
  });
}
