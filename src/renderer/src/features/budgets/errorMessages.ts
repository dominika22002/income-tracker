import { DomainError } from '../../../../shared/domain/errors';
import type { DomainErrorCode } from '../../../../shared/contracts';

const MESSAGES: Record<DomainErrorCode, string> = {
  UNAUTHENTICATED: 'You need to sign in first.',
  INVALID_ARGUMENT: 'The entered data is not valid.',
  PERMISSION_DENIED: 'You do not have permission to do this.',
  NOT_FOUND: 'Nothing was found for this request.',
  ALREADY_EXISTS: 'This already exists.',
  NOT_ACTIVE_MEMBER: 'You are not an active member of this budget.',
  ALREADY_MEMBER: 'You are already a member of this budget.',
  NOT_ADMIN: 'Only the budget administrator can do this.',
  CANNOT_REMOVE_SELF: 'Use “Leave budget” to remove yourself.',
  INVALID_TRANSITION: 'This change is not allowed in the current state.',
  INVITATION_NOT_PENDING:
    'This invitation was already used, declined or cancelled.',
  INVITATION_EXPIRED: 'This invitation has expired.',
  INVITATION_EMAIL_MISMATCH:
    'This invitation is for a different, or unverified, e-mail address.',
  BUDGET_HAS_ACTIVE_MEMBERS: 'The budget still has active members.',
  DUPLICATE_REVIEW_REQUIRED:
    'Possible duplicate transactions need an explicit include or exclude decision.',
};

/** Never reports success: unknown failures are shown as failures. */
export function describeError(error: unknown): string {
  if (error instanceof DomainError) {
    return MESSAGES[error.code];
  }
  const firebaseCode = (error as { code?: unknown } | null)?.code;
  if (
    firebaseCode === 'functions/internal' &&
    error instanceof Error &&
    /^internal \[\d+\]$/i.test(error.message)
  ) {
    return 'Nie można połączyć się z Firebase Functions. Sprawdź połączenie z Firebase lub uruchom lokalne emulatory i spróbuj ponownie.';
  }
  if ((error as { code?: unknown } | null)?.code === 'permission-denied') {
    return 'You no longer have access to this data.';
  }
  return error instanceof Error && error.message
    ? `Something went wrong: ${error.message}`
    : 'Something went wrong. The change was not saved.';
}
