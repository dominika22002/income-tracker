import type {
  CreateBudgetRequest,
  CreateInvitationRequest,
  OAuthCallbackPayload,
  RemoveMemberRequest,
  UpdatePreferencesRequest,
  WriteTestFileRequest,
} from './contracts';
import { normalizeEmail } from './domain/invitation';
import {
  isIsoCurrencyCode,
  MAX_SECONDARY_CURRENCIES,
} from './domain/preferences';

const MAX_TEST_CONTENT_SIZE = 2_048;

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
