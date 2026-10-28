import type {
  AccountType,
  CommitCsvImportRequest,
  CreateAccountRequest,
  CreateBudgetRequest,
  CreateInvitationRequest,
  OAuthCallbackPayload,
  RemoveMemberRequest,
  ReadLocalStatementRequest,
  StatementImportRowRequest,
  UpdatePreferencesRequest,
  WriteTestFileRequest,
} from './contracts';
import { normalizeEmail } from './domain/invitation';
import {
  isIsoCurrencyCode,
  MAX_SECONDARY_CURRENCIES,
} from './domain/preferences';

const MAX_TEST_CONTENT_SIZE = 2_048;
const MAX_LOCAL_STATEMENT_PATH_LENGTH = 4_096;
const MIN_LOCAL_STATEMENT_BYTES = 1_024;
export const MAX_LOCAL_STATEMENT_BYTES = 10 * 1024 * 1024;

export function validateWriteTestFileRequest(
  input: unknown,
): WriteTestFileRequest | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('content' in input) ||
    typeof input.content !== 'string'
  ) {
    return null;
  }

  const trimmed = input.content.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEST_CONTENT_SIZE) {
    return null;
  }

  return { content: trimmed };
}

export function validateReadLocalStatementRequest(
  input: unknown,
): ReadLocalStatementRequest | null {
  const record = asRecord(input);
  if (!record || typeof record.filePath !== 'string') {
    return null;
  }
  const filePath = record.filePath.trim();
  if (
    filePath.length === 0 ||
    filePath.length > MAX_LOCAL_STATEMENT_PATH_LENGTH
  ) {
    return null;
  }
  if (record.maxBytes === undefined) {
    return { filePath, maxBytes: MAX_LOCAL_STATEMENT_BYTES };
  }
  if (
    typeof record.maxBytes !== 'number' ||
    !Number.isInteger(record.maxBytes) ||
    record.maxBytes < MIN_LOCAL_STATEMENT_BYTES ||
    record.maxBytes > MAX_LOCAL_STATEMENT_BYTES
  ) {
    return null;
  }
  return { filePath, maxBytes: record.maxBytes };
}

export function validateOAuthState(
  expectedState: string,
  payload: OAuthCallbackPayload,
): boolean {
  return (
    payload.ok &&
    typeof payload.state === 'string' &&
    payload.state === expectedState
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BUDGET_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_ACCOUNT_LABEL_LENGTH = 100;
const MAX_ACCOUNT_INSTITUTION_LENGTH = 120;
export const MAX_CSV_IMPORT_ROWS = 150;
const ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'CHECKING',
  'SAVINGS',
  'CASH',
  'OTHER',
]);
const TRANSACTION_TYPES = new Set(['EXPENSE', 'INCOME', 'TRANSFER']);
const STATEMENT_PARSER_IDS = new Set(['history-v1', 'savings-v1']);
const DECIMAL_AMOUNT_PATTERN = /^[+-]?\d{1,15}(?:\.\d{1,4})?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const INVITATION_LINK_PREFIX = 'income-tracker://invite?token=';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function validateBudgetName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BUDGET_NAME_LENGTH) {
    return null;
  }
  return trimmed;
}

/** Returns the normalized (trimmed, lower-case) address or null. */
export function validateEmailAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = normalizeEmail(input);
  if (normalized.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && INVITATION_TOKEN_PATTERN.test(value);
}

/** Accepts either a bare token or a full invitation link. */
export function parseInvitationInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const token = trimmed.startsWith(INVITATION_LINK_PREFIX)
    ? trimmed.slice(INVITATION_LINK_PREFIX.length)
    : trimmed;
  return isInvitationToken(token) ? token : null;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

export function validateCreateBudgetRequest(
  input: unknown,
): CreateBudgetRequest | null {
  const record = asRecord(input);
  if (!record) return null;
  const name = validateBudgetName(record.name);
  if (name === null) return null;
  if (record.budget_id === undefined) return { name };
  if (!isUuid(record.budget_id)) return null;
  return { name, budget_id: record.budget_id };
}

function validateAccountLabel(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACCOUNT_LABEL_LENGTH) {
    return null;
  }
  return trimmed;
}

function validateInstitutionName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACCOUNT_INSTITUTION_LENGTH) {
    return null;
  }
  return trimmed;
}

function isAccountType(input: unknown): input is AccountType {
  return typeof input === 'string' && ACCOUNT_TYPES.has(input as AccountType);
}

export function validateCreateAccountRequest(
  input: unknown,
): CreateAccountRequest | null {
  const record = asRecord(input);
  if (!record || !isUuid(record.budget_id)) return null;

  const label = validateAccountLabel(record.label);
  if (!label || !isIsoCurrencyCode(record.currency) || !isAccountType(record.account_type)) {
    return null;
  }

  const request: CreateAccountRequest = {
    budget_id: record.budget_id,
    label,
    currency: record.currency,
    account_type: record.account_type,
  };
  if (record.owner_membership_id !== undefined) {
    if (!isUuid(record.owner_membership_id)) return null;
    request.owner_membership_id = record.owner_membership_id;
  }
  if (record.institution_name !== undefined) {
    const institution = validateInstitutionName(record.institution_name);
    if (!institution) return null;
    request.institution_name = institution;
  }
  if (record.account_id !== undefined) {
    if (!isUuid(record.account_id)) return null;
    request.account_id = record.account_id;
  }
  return request;
}

function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isAmount(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_AMOUNT_PATTERN.test(value);
}

function validateStatementImportRow(
  input: unknown,
): StatementImportRowRequest | null {
  const record = asRecord(input);
  if (
    !record ||
    !Number.isInteger(record.row_number) ||
    (record.row_number as number) < 2 ||
    !['include', 'exclude', 'pending'].includes(String(record.decision))
  ) {
    return null;
  }
  const row: StatementImportRowRequest = {
    row_number: record.row_number as number,
    decision: record.decision as StatementImportRowRequest['decision'],
  };
  if (row.decision !== 'include') {
    if (record.possible_duplicate_decision !== undefined) return null;
    return row;
  }

  if (
    typeof record.operation_date !== 'string' ||
    !isValidCalendarDate(record.operation_date) ||
    typeof record.description !== 'string' ||
    record.description.trim().length === 0 ||
    record.description.length > 1_000 ||
    !isAmount(record.amount) ||
    !isIsoCurrencyCode(record.currency) ||
    typeof record.transaction_type !== 'string' ||
    !TRANSACTION_TYPES.has(record.transaction_type)
  ) {
    return null;
  }
  row.operation_date = record.operation_date;
  row.description = record.description.trim();
  row.amount = record.amount;
  row.currency = record.currency;
  row.transaction_type =
    record.transaction_type as StatementImportRowRequest['transaction_type'];

  for (const field of ['fee', 'balance'] as const) {
    const value = record[field];
    if (value !== undefined && value !== null) {
      if (!isAmount(value)) return null;
      row[field] = value;
    } else if (value === null) {
      row[field] = null;
    }
  }
  for (const field of ['source_status', 'bank_transaction_id'] as const) {
    const value = record[field];
    if (value !== undefined && value !== null) {
      const max = field === 'source_status' ? 100 : 200;
      if (typeof value !== 'string' || value.length > max) return null;
      row[field] = value.trim() || null;
    } else if (value === null) {
      row[field] = null;
    }
  }
  if (record.balance_currency !== undefined) {
    if (
      record.balance_currency !== null &&
      !isIsoCurrencyCode(record.balance_currency)
    ) {
      return null;
    }
    row.balance_currency = record.balance_currency as string | null;
  }
  if ((row.balance === undefined) !== (row.balance_currency === undefined)) {
    return null;
  }
  if (record.possible_duplicate_decision !== undefined) {
    if (
      !['confirm', 'exclude', 'pending'].includes(
        String(record.possible_duplicate_decision),
      )
    ) {
      return null;
    }
    row.possible_duplicate_decision =
      record.possible_duplicate_decision as NonNullable<
        StatementImportRowRequest['possible_duplicate_decision']
      >;
  }
  return row;
}

export function validateCommitCsvImportRequest(
  input: unknown,
): CommitCsvImportRequest | null {
  const record = asRecord(input);
  if (
    !record ||
    !isUuid(record.budget_id) ||
    !isUuid(record.account_id) ||
    typeof record.file_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.file_sha256) ||
    typeof record.parser_id !== 'string' ||
    !STATEMENT_PARSER_IDS.has(record.parser_id) ||
    typeof record.parser_version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(record.parser_version) ||
    !Array.isArray(record.rows) ||
    record.rows.length === 0 ||
    record.rows.length > MAX_CSV_IMPORT_ROWS
  ) {
    return null;
  }
  const rows = record.rows.map(validateStatementImportRow);
  if (
    rows.some((row) => row === null) ||
    (rows as StatementImportRowRequest[]).some(
      (row) => row.decision === 'pending',
    ) ||
    new Set((rows as StatementImportRowRequest[]).map((row) => row.row_number))
      .size !== rows.length
  ) {
    return null;
  }
  return {
    budget_id: record.budget_id,
    account_id: record.account_id,
    file_sha256: record.file_sha256,
    parser_id: record.parser_id,
    parser_version: record.parser_version,
    rows: rows as StatementImportRowRequest[],
  };
}

export function validateCreateInvitationRequest(
  input: unknown,
): CreateInvitationRequest | null {
  const record = asRecord(input);
  if (!record || !isUuid(record.budget_id)) return null;

  const request: CreateInvitationRequest = { budget_id: record.budget_id };
  if (record.invitee_email !== undefined) {
    const email = validateEmailAddress(record.invitee_email);
    if (email === null) return null;
    request.invitee_email = email;
  }
  if (record.invitation_id !== undefined) {
    if (!isUuid(record.invitation_id)) return null;
    request.invitation_id = record.invitation_id;
  }
  return request;
}

export function validateRemoveMemberRequest(
  input: unknown,
): RemoveMemberRequest | null {
  const record = asRecord(input);
  if (!record || !isUuid(record.budget_id) || !isUuid(record.membership_id)) {
    return null;
  }
  return { budget_id: record.budget_id, membership_id: record.membership_id };
}

/**
 * Preferences are personal: one primary currency and a set of distinct
 * secondary currencies that does not repeat the primary one.
 */
export function validatePreferencesRequest(
  input: unknown,
): UpdatePreferencesRequest | null {
  const record = asRecord(input);
  if (!record) return null;
  const primary = record.primary_currency;
  const secondary = record.secondary_currencies;

  if (!isIsoCurrencyCode(primary) || !Array.isArray(secondary)) return null;
  if (secondary.length > MAX_SECONDARY_CURRENCIES) return null;
  if (!secondary.every(isIsoCurrencyCode)) return null;
  if (new Set(secondary).size !== secondary.length) return null;
  if (secondary.includes(primary)) return null;

  return { primary_currency: primary, secondary_currencies: [...secondary] };
}
