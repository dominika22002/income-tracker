import type { Functions } from 'firebase/functions';
import { httpsCallable } from 'firebase/functions';
import type { BudgetBackend, DomainErrorCode } from '../../../shared/contracts';
import { DomainError } from '../../../shared/domain/errors';

const KNOWN_CODES = new Set<DomainErrorCode>([
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'NOT_ACTIVE_MEMBER',
  'ALREADY_MEMBER',
  'NOT_ADMIN',
  'CANNOT_REMOVE_SELF',
  'INVALID_TRANSITION',
  'INVITATION_NOT_PENDING',
  'INVITATION_EXPIRED',
  'INVITATION_EMAIL_MISMATCH',
  'BUDGET_HAS_ACTIVE_MEMBERS',
]);

/** Keeps the server's domain code so the UI can explain what went wrong. */
export function toDomainError(error: unknown): Error {
  const details = (error as { details?: { code?: unknown } } | null)?.details;
  const code = details?.code;
  if (typeof code === 'string' && KNOWN_CODES.has(code as DomainErrorCode)) {
    return new DomainError(code as DomainErrorCode, (error as Error).message);
  }
  return error instanceof Error ? error : new Error('Request failed.');
}

export function createCallableBackend(functions: Functions): BudgetBackend {
  async function call<T>(name: string, data?: unknown): Promise<T> {
    try {
      const result = await httpsCallable<unknown, T>(
        functions,
        name,
      )(data ?? {});
      return result.data;
    } catch (error) {
      throw toDomainError(error);
    }
  }

  return {
    ensureUserProfile: () => call('ensureUserProfile'),
    updatePreferences: (request) => call('updatePreferences', request),
    createBudget: (request) => call('createBudget', request),
    createInvitation: (request) => call('createInvitation', request),
    previewInvitation: (token) => call('previewInvitation', { token }),
    acceptInvitation: (token) => call('acceptInvitation', { token }),
    declineInvitation: (token) => call('declineInvitation', { token }),
    cancelInvitation: (invitation_id) =>
      call('cancelInvitation', { invitation_id }),
    leaveBudget: (budget_id) => call('leaveBudget', { budget_id }),
    removeMember: (request) => call('removeMember', request),
    deleteMyProfile: () => call('deleteMyProfile'),
  };
}
