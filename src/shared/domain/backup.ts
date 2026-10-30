import { BACKUP_COLLECTIONS } from '../firestorePaths';

export const BACKUP_FORMAT = 'income-tracker-backup';
export const BACKUP_SCHEMA_VERSION = 2;
export const BACKUP_MAX_BYTES = 100 * 1024 * 1024;

export interface BackupRecord {
  document_id: string;
  data: Record<string, unknown>;
}

export type BackupDatasets = Record<
  (typeof BACKUP_COLLECTIONS)[number],
  BackupRecord[]
>;

export interface BackupStatementFile {
  import_batch_id: string;
  file_name: string;
  content_type: 'text/csv' | 'application/pdf';
  sha256: string;
  content_base64: string;
}

export interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  schema_version: typeof BACKUP_SCHEMA_VERSION;
  created_at: string;
  source_budget: { budget_id: string; name: string };
  datasets: BackupDatasets;
  membership_history: BackupRecord[];
  currency_settings: {
    primary_currency: string;
    secondary_currencies: string[];
  } | null;
  statement_files: BackupStatementFile[];
}

export interface BackupFile extends BackupPayload {
  integrity: { algorithm: 'SHA-256'; checksum: string };
}

export interface BackupSummary {
  created_at: string;
  budget_name: string;
  budget_id: string;
  record_counts: Record<string, number>;
  statement_file_count: number;
}

export interface MergeConflict {
  collection: string;
  document_id: string;
  current: BackupRecord;
  incoming: BackupRecord;
}

const SECRET_FIELD = /(?:password|passwd|token|secret|credential|private_key)/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function checksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function assertNoSecrets(value: unknown, path = 'backup'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      throw new Error(`Backup contains a forbidden authentication field: ${path}.${key}`);
    }
    assertNoSecrets(nested, `${path}.${key}`);
  }
}

function validateRecordArray(value: unknown, path: string): BackupRecord[] {
  if (!Array.isArray(value)) throw new Error(`Invalid backup ${path}.`);
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.document_id !== 'string' ||
      item.document_id.length === 0 ||
      !isRecord(item.data)
    ) {
      throw new Error(`Invalid backup record at ${path}[${index}].`);
    }
    if (ids.has(item.document_id)) {
      throw new Error(`Duplicate record id in ${path}: ${item.document_id}.`);
    }
    ids.add(item.document_id);
    return { document_id: item.document_id, data: item.data };
  });
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): boolean {
  return typeof record[field] === 'string' && record[field] !== '';
}

function validateDatasetRelationships(
  datasets: BackupDatasets,
  membershipHistory: BackupRecord[],
  budgetId: string,
): void {
  const ids = (name: keyof BackupDatasets) =>
    new Set(datasets[name].map((record) => record.document_id));
  const accounts = ids('accounts');
  const batches = ids('import_batches');
  const categories = ids('categories');
  const transactions = ids('transactions');
  const tags = ids('tags');
  const rates = ids('exchange_rates');
  const memberships = new Set(
    membershipHistory.map((record) => record.document_id),
  );
  const checkMembership = (data: Record<string, unknown>, field: string) =>
    data[field] == null ||
    (typeof data[field] === 'string' && memberships.has(data[field] as string));
  const requireFields: Record<string, string[]> = {
    accounts: ['budget_id', 'owner_membership_id', 'label', 'currency'],
    import_batches: [
      'budget_id',
      'account_id',
      'imported_by_membership_id',
      'file_sha256',
      'source_format',
      'parser_id',
      'parser_version',
      'status',
    ],
    import_profiles: ['budget_id', 'account_id', 'source_format', 'parser_id'],
    import_periods: [
      'budget_id',
      'import_batch_id',
      'period_start',
      'period_end',
    ],
    categories: ['budget_id', 'name', 'kind', 'created_by_membership_id'],
    categorization_rules: [
      'budget_id',
      'category_id',
      'created_by_membership_id',
      'match_value',
    ],
    transfer_groups: ['budget_id', 'status', 'created_by_membership_id'],
    transactions: [
      'budget_id',
      'account_id',
      'operation_date',
      'description',
      'amount',
      'currency',
      'type',
    ],
    split_items: ['budget_id', 'transaction_id', 'amount'],
    spending_limits: [
      'budget_id',
      'limit_scope',
      'period',
      'limit_amount',
      'currency',
      'created_by_membership_id',
    ],
    account_balance_snapshots: [
      'account_id',
      'balance_date',
      'balance_amount',
      'currency',
      'source',
      'created_by_membership_id',
    ],
    exchange_rates: [
      'base_currency',
      'quote_currency',
      'rate_date',
      'rate',
      'provider',
    ],
    transaction_conversions: [
      'transaction_id',
      'target_currency',
      'rate_used',
      'rate_date',
      'converted_amount',
      'display_amount',
    ],
    tags: ['budget_id', 'name', 'created_by_membership_id'],
    transaction_tags: ['transaction_id', 'tag_id'],
  };
  for (const [collection, fields] of Object.entries(requireFields)) {
    for (const record of datasets[collection as keyof BackupDatasets]) {
      if (fields.some((field) => !requiredString(record.data, field))) {
        throw new Error(
          `Invalid backup record structure in ${collection}/${record.document_id}.`,
        );
      }
      if (
        record.data.budget_id !== undefined &&
        record.data.budget_id !== budgetId
      ) {
        throw new Error(
          `A ${collection} record belongs to a different source budget.`,
        );
      }
    }
  }
  if (
    datasets.split_items.some(
      (record) =>
        !Number.isSafeInteger(record.data.position) ||
        (record.data.position as number) < 0,
    )
  ) {
    throw new Error('Invalid split item position.');
  }
  for (const record of datasets.accounts) {
    if (!checkMembership(record.data, 'owner_membership_id')) {
      throw new Error('An account references missing membership history.');
    }
  }
  for (const record of datasets.import_batches) {
    if (
      !accounts.has(record.data.account_id as string) ||
      !checkMembership(record.data, 'imported_by_membership_id')
    ) {
      throw new Error('An import references missing account or membership data.');
    }
  }
  for (const record of datasets.import_profiles) {
    if (!accounts.has(record.data.account_id as string)) {
      throw new Error('An import profile references a missing account.');
    }
  }
  for (const record of datasets.import_periods) {
    if (!batches.has(record.data.import_batch_id as string)) {
      throw new Error('An import period references a missing import.');
    }
  }
  for (const record of datasets.categories) {
    const parentId = record.data.parent_category_id;
    if (parentId != null && !categories.has(parentId as string)) {
      throw new Error('A category references a missing parent category.');
    }
    if (!checkMembership(record.data, 'created_by_membership_id')) {
      throw new Error('A category references missing membership history.');
    }
  }
  for (const record of datasets.categorization_rules) {
    if (
      !categories.has(record.data.category_id as string) ||
      !checkMembership(record.data, 'created_by_membership_id')
    ) {
      throw new Error('A categorization rule references missing data.');
    }
  }
  for (const record of datasets.transactions) {
    if (
      !accounts.has(record.data.account_id as string) ||
      (record.data.transfer_group_id != null &&
        !datasets.transfer_groups.some(
          (group) => group.document_id === record.data.transfer_group_id,
        )) ||
      (record.data.source_transaction_id != null &&
        !transactions.has(record.data.source_transaction_id as string)) ||
      (record.data.category_id != null &&
        !categories.has(record.data.category_id as string)) ||
      (record.data.import_batch_id != null &&
        !batches.has(record.data.import_batch_id as string)) ||
      !checkMembership(record.data, 'created_by_membership_id') ||
      !checkMembership(record.data, 'hidden_by_membership_id') ||
      !checkMembership(record.data, 'imported_by_membership_id')
    ) {
      throw new Error('A transaction references missing backup data.');
    }
  }
  for (const record of datasets.split_items) {
    if (
      !transactions.has(record.data.transaction_id as string) ||
      (record.data.category_id != null &&
        !categories.has(record.data.category_id as string))
    ) {
      throw new Error('A split references missing backup data.');
    }
  }
  for (const record of datasets.spending_limits) {
    if (
      (record.data.category_id != null &&
        !categories.has(record.data.category_id as string)) ||
      !checkMembership(record.data, 'created_by_membership_id')
    ) {
      throw new Error('A spending limit references missing backup data.');
    }
  }
  for (const record of datasets.account_balance_snapshots) {
    if (
      !accounts.has(record.data.account_id as string) ||
      (record.data.import_batch_id != null &&
        !batches.has(record.data.import_batch_id as string)) ||
      !checkMembership(record.data, 'created_by_membership_id')
    ) {
      throw new Error('An account balance references missing backup data.');
    }
  }
  for (const record of datasets.transaction_conversions) {
    if (
      !transactions.has(record.data.transaction_id as string) ||
      (record.data.exchange_rate_id != null &&
        !rates.has(record.data.exchange_rate_id as string))
    ) {
      throw new Error('A transaction conversion references a missing transaction.');
    }
  }
  for (const record of datasets.transfer_groups) {
    if (
      record.data.fx_rate_id != null &&
      !rates.has(record.data.fx_rate_id as string)
    ) {
      throw new Error('A transfer references a missing exchange rate.');
    }
  }
  for (const record of datasets.tags) {
    if (!checkMembership(record.data, 'created_by_membership_id')) {
      throw new Error('A tag references missing membership history.');
    }
  }
  for (const record of datasets.transaction_tags) {
    if (
      !transactions.has(record.data.transaction_id as string) ||
      !tags.has(record.data.tag_id as string)
    ) {
      throw new Error('A transaction tag references missing backup data.');
    }
    for (const record of datasets.transfer_groups) {
      if (
        !checkMembership(record.data, 'created_by_membership_id') ||
        !checkMembership(record.data, 'confirmed_by_membership_id')
      ) {
        throw new Error('A transfer references missing membership history.');
      }
    }
  }
  for (const record of membershipHistory) {
    if (
      !requiredString(record.data, 'budget_id') ||
      !requiredString(record.data, 'role') ||
      !requiredString(record.data, 'status') ||
      (record.data.user_id !== null &&
        typeof record.data.user_id !== 'string')
    ) {
      throw new Error('Invalid backup membership history record.');
    }
  }
}

function migrateV1(value: Record<string, unknown>): Record<string, unknown> {
  if (value.schema_version !== 1) {
    throw new Error(`Unsupported backup schema version: ${String(value.schema_version)}.`);
  }
  return {
    ...value,
    schema_version: BACKUP_SCHEMA_VERSION,
    membership_history: value.membership_history ?? [],
    currency_settings: null,
    statement_files: [],
  };
}

function validatePayload(value: unknown): BackupPayload {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) {
    throw new Error('The selected file is not an Income Tracker backup.');
  }
  let migrated = value;
  if (value.schema_version === 1) migrated = migrateV1(value);
  if (migrated.schema_version !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version: ${String(migrated.schema_version)}.`);
  }
  if (
    typeof migrated.created_at !== 'string' ||
    Number.isNaN(Date.parse(migrated.created_at)) ||
    !isRecord(migrated.source_budget) ||
    typeof migrated.source_budget.budget_id !== 'string' ||
    typeof migrated.source_budget.name !== 'string' ||
    !isRecord(migrated.datasets)
  ) {
    throw new Error('The backup metadata or dataset structure is invalid.');
  }
  const datasets = {} as BackupDatasets;
  for (const collection of BACKUP_COLLECTIONS) {
    datasets[collection] = validateRecordArray(
      migrated.datasets[collection],
      `datasets.${collection}`,
    );
  }
  const membershipHistory = validateRecordArray(
    migrated.membership_history,
    'membership_history',
  );
  validateDatasetRelationships(
    datasets,
    membershipHistory,
    migrated.source_budget.budget_id,
  );
  if (!Array.isArray(migrated.statement_files)) {
    throw new Error('Invalid backup statement file list.');
  }
  const statementFiles = migrated.statement_files.map((file, index) => {
    if (
      !isRecord(file) ||
      typeof file.import_batch_id !== 'string' ||
      typeof file.file_name !== 'string' ||
      (file.content_type !== 'text/csv' &&
        file.content_type !== 'application/pdf') ||
      typeof file.sha256 !== 'string' ||
      !HASH_PATTERN.test(file.sha256) ||
      typeof file.content_base64 !== 'string'
    ) {
      throw new Error(`Invalid backup statement file at index ${index}.`);
    }
    return file as unknown as BackupStatementFile;
  });
  let currencySettings: BackupPayload['currency_settings'] = null;
  if (migrated.currency_settings !== null) {
    if (
      !isRecord(migrated.currency_settings) ||
      typeof migrated.currency_settings.primary_currency !== 'string' ||
      !/^[A-Z]{3}$/.test(migrated.currency_settings.primary_currency) ||
      !Array.isArray(migrated.currency_settings.secondary_currencies) ||
      migrated.currency_settings.secondary_currencies.some(
        (currency) =>
          typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency),
      )
    ) {
      throw new Error('Invalid backup currency settings.');
    }
    currencySettings = {
      primary_currency: migrated.currency_settings.primary_currency,
      secondary_currencies:
        migrated.currency_settings.secondary_currencies as string[],
    };
  }
  const payload: BackupPayload = {
    format: BACKUP_FORMAT,
    schema_version: BACKUP_SCHEMA_VERSION,
    created_at: migrated.created_at,
    source_budget: {
      budget_id: migrated.source_budget.budget_id,
      name: migrated.source_budget.name,
    },
    datasets,
    membership_history: membershipHistory,
    currency_settings: currencySettings,
    statement_files: statementFiles,
  };
  assertNoSecrets(payload);
  return payload;
}

export function validateBackupPayload(value: unknown): BackupPayload {
  return validatePayload(value);
}

export async function createBackupFile(
  payload: BackupPayload,
): Promise<string> {
  const validated = validatePayload(payload);
  await verifyStatementFiles(validated.statement_files);
  const integrity = {
    algorithm: 'SHA-256' as const,
    checksum: await checksum(validated),
  };
  const file: BackupFile = { ...validated, integrity };
  const content = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(content).byteLength > BACKUP_MAX_BYTES) {
    throw new Error('The backup exceeds the supported 100 MB file size.');
  }
  return content;
}

export async function parseBackupFile(content: string): Promise<BackupFile> {
  if (new TextEncoder().encode(content).byteLength > BACKUP_MAX_BYTES) {
    throw new Error('The selected backup exceeds the supported 100 MB file size.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('The selected backup file is not valid JSON.');
  }
  if (!isRecord(parsed) || !isRecord(parsed.integrity)) {
    throw new Error('The backup integrity information is missing.');
  }
  const expected = parsed.integrity.checksum;
  if (
    parsed.integrity.algorithm !== 'SHA-256' ||
    typeof expected !== 'string' ||
    !HASH_PATTERN.test(expected)
  ) {
    throw new Error('The backup integrity information is invalid.');
  }
  const untrustedPayload = { ...parsed };
  delete untrustedPayload.integrity;
  const isV1 = untrustedPayload.schema_version === 1;
  if (
    (await checksum(untrustedPayload)) !== expected &&
    isV1
  ) {
    throw new Error('The backup integrity check failed; no data was restored.');
  }
  const payload = validatePayload(
    isV1 ? migrateV1(untrustedPayload) : untrustedPayload,
  );
  await verifyStatementFiles(payload.statement_files);
  if (!isV1 && (await checksum(payload)) !== expected) {
    throw new Error('The backup integrity check failed; no data was restored.');
  }
  return { ...payload, integrity: { algorithm: 'SHA-256', checksum: expected } };
}

async function verifyStatementFiles(files: BackupStatementFile[]): Promise<void> {
  for (const file of files) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.content_base64,
      )
    ) {
      throw new Error(`The original statement ${file.file_name} is invalid.`);
    }
    const binary = atob(file.content_base64);
    if (binary.length === 0 || btoa(binary) !== file.content_base64) {
      throw new Error(`The original statement ${file.file_name} is invalid.`);
    }
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (actual !== file.sha256) {
      throw new Error(`The original statement ${file.file_name} failed its integrity check.`);
    }
  }
}

export function summarizeBackup(backup: BackupFile): BackupSummary {
  return {
    created_at: backup.created_at,
    budget_name: backup.source_budget.name,
    budget_id: backup.source_budget.budget_id,
    record_counts: Object.fromEntries(
      Object.entries(backup.datasets).map(([name, records]) => [
        name,
        records.length,
      ]),
    ),
    statement_file_count: backup.statement_files.length,
  };
}

export function planBackupMerge(
  current: BackupPayload,
  incoming: BackupPayload,
): { merged: BackupPayload; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const mergedDatasets = {} as BackupDatasets;
  for (const collection of BACKUP_COLLECTIONS) {
    const currentById = new Map(
      current.datasets[collection].map((record) => [
        record.document_id,
        record,
      ]),
    );
    const incomingById = new Map(
      incoming.datasets[collection].map((record) => [
        record.document_id,
        record,
      ]),
    );
    const merged = new Map(currentById);
    for (const [documentId, incomingRecord] of incomingById) {
      const currentRecord = currentById.get(documentId);
      if (!currentRecord) {
        merged.set(documentId, incomingRecord);
      } else if (canonical(currentRecord.data) !== canonical(incomingRecord.data)) {
        conflicts.push({
          collection,
          document_id: documentId,
          current: currentRecord,
          incoming: incomingRecord,
        });
      }
    }
    mergedDatasets[collection] = [...merged.values()];
  }
  return {
    merged: {
      ...current,
      datasets: mergedDatasets,
      membership_history: [
        ...current.membership_history,
        ...incoming.membership_history.filter(
          (record) =>
            !current.membership_history.some(
              (currentRecord) =>
                currentRecord.document_id === record.document_id,
            ),
        ),
      ],
      statement_files: [
        ...current.statement_files,
        ...incoming.statement_files.filter(
          (file) =>
            !current.statement_files.some(
              (currentFile) =>
                currentFile.import_batch_id === file.import_batch_id &&
                currentFile.sha256 === file.sha256,
            ),
        ),
      ],
    },
    conflicts,
  };
}

export function resolveBackupMerge(
  plan: ReturnType<typeof planBackupMerge>,
  choices: Record<string, 'current' | 'incoming'>,
): BackupPayload {
  const datasets = { ...plan.merged.datasets };
  for (const conflict of plan.conflicts) {
    const key = `${conflict.collection}/${conflict.document_id}`;
    const choice = choices[key];
    if (choice !== 'current' && choice !== 'incoming') {
      throw new Error(`A choice is required for merge conflict ${key}.`);
    }
    if (choice === 'incoming') {
      const records = [...datasets[conflict.collection as keyof BackupDatasets]];
      const index = records.findIndex(
        (record) => record.document_id === conflict.document_id,
      );
      records[index] = conflict.incoming;
      datasets[conflict.collection as keyof BackupDatasets] =
        records as BackupDatasets[keyof BackupDatasets];
    }
  }
  return { ...plan.merged, datasets };
}
