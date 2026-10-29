import type { BudgetBackend, DomainErrorCode } from '../shared/contracts';
import { DomainError } from '../shared/domain/errors';
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  declineInvitation,
  previewInvitation,
} from './invitations';
import { createBudget } from './budgets';
import { createAccount } from './accounts';
import { archiveCategory, saveCategory } from './categories';
import { saveCategorizationRule } from './categorization';
import { commitCsvImport } from './imports';
import { saveTransaction } from './transactions';
import type { Caller } from './context';
import { leaveBudget, removeMember } from './memberships';
import { ensureUserProfile, updatePreferences } from './profile';
import { deleteMyProfile, type ProfileDeletionDeps } from './profileDeletion';

/** Subset of the callable-function auth context that the services need. */
export interface CallableAuth {
  uid: string;
  token: { email?: string; email_verified?: boolean; name?: string };
}

export function callerFromAuth(
  auth: CallableAuth | null | undefined,
): Caller | null {
  if (!auth) return null;
  return {
    uid: auth.uid,
    email: auth.token.email,
    emailVerified: auth.token.email_verified,
    displayName: auth.token.name,
  };
}

export const CALLABLE_NAMES = [
  'ensureUserProfile',
  'updatePreferences',
  'createBudget',
  'createAccount',
  'saveTransaction',
  'saveCategory',
  'archiveCategory',
  'saveCategorizationRule',
  'commitCsvImport',
  'createInvitation',
  'previewInvitation',
  'acceptInvitation',
  'declineInvitation',
  'cancelInvitation',
  'leaveBudget',
  'removeMember',
  'deleteMyProfile',
] as const;

export type CallableName = (typeof CALLABLE_NAMES)[number];
export type CallableHandler = (
  auth: CallableAuth | null | undefined,
  data: unknown,
) => Promise<unknown>;

function field(data: unknown, name: string): unknown {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)[name]
    : undefined;
}

export function createHandlers(
  deps: ProfileDeletionDeps,
): Record<CallableName, CallableHandler> {
  return {
    ensureUserProfile: (auth) => ensureUserProfile(deps, callerFromAuth(auth)),
    updatePreferences: (auth, data) =>
      updatePreferences(deps, callerFromAuth(auth), data),
    createBudget: (auth, data) =>
      createBudget(deps, callerFromAuth(auth), data),
    createAccount: (auth, data) =>
      createAccount(deps, callerFromAuth(auth), data),
    saveTransaction: (auth, data) =>
      saveTransaction(deps, callerFromAuth(auth), data),
    saveCategory: (auth, data) =>
      saveCategory(deps, callerFromAuth(auth), data),
    archiveCategory: async (auth, data) => {
      await archiveCategory(deps, callerFromAuth(auth), data);
    },
    saveCategorizationRule: (auth, data) =>
      saveCategorizationRule(deps, callerFromAuth(auth), data),
    commitCsvImport: (auth, data) =>
      commitCsvImport(deps, callerFromAuth(auth), data),
    createInvitation: (auth, data) =>
      createInvitation(deps, callerFromAuth(auth), data),
    previewInvitation: (auth, data) =>
      previewInvitation(deps, callerFromAuth(auth), field(data, 'token')),
    acceptInvitation: (auth, data) =>
      acceptInvitation(deps, callerFromAuth(auth), field(data, 'token')),
    declineInvitation: async (auth, data) => {
      await declineInvitation(deps, callerFromAuth(auth), field(data, 'token'));
    },
    cancelInvitation: async (auth, data) => {
      await cancelInvitation(
        deps,
        callerFromAuth(auth),
        field(data, 'invitation_id'),
      );
    },
    leaveBudget: (auth, data) =>
      leaveBudget(deps, callerFromAuth(auth), field(data, 'budget_id')),
    removeMember: async (auth, data) => {
      await removeMember(deps, callerFromAuth(auth), data);
    },
    deleteMyProfile: (auth) => deleteMyProfile(deps, callerFromAuth(auth)),
  };
}

export type CallableErrorCode =
  | 'unauthenticated'
  | 'invalid-argument'
  | 'permission-denied'
  | 'not-found'
  | 'already-exists'
  | 'failed-precondition'
  | 'internal';

export interface CallableError {
  code: CallableErrorCode;
  message: string;
  domainCode?: DomainErrorCode;
}

const CODE_MAP: Record<DomainErrorCode, CallableErrorCode> = {
  UNAUTHENTICATED: 'unauthenticated',
  INVALID_ARGUMENT: 'invalid-argument',
  PERMISSION_DENIED: 'permission-denied',
  NOT_ADMIN: 'permission-denied',
  NOT_ACTIVE_MEMBER: 'permission-denied',
  INVITATION_EMAIL_MISMATCH: 'permission-denied',
  CANNOT_REMOVE_SELF: 'failed-precondition',
  NOT_FOUND: 'not-found',
  ALREADY_EXISTS: 'already-exists',
  ALREADY_MEMBER: 'already-exists',
  INVALID_TRANSITION: 'failed-precondition',
  INVITATION_NOT_PENDING: 'failed-precondition',
  INVITATION_EXPIRED: 'failed-precondition',
  BUDGET_HAS_ACTIVE_MEMBERS: 'failed-precondition',
  DUPLICATE_REVIEW_REQUIRED: 'failed-precondition',
};

/** Domain errors keep their code; anything else is reported as opaque. */
export function toCallableError(error: unknown): CallableError {
  if (error instanceof DomainError) {
    return {
      code: CODE_MAP[error.code],
      message: error.message,
      domainCode: error.code,
    };
  }
  return { code: 'internal', message: 'Internal error.' };
}

/** In-process transport with the same handlers as the deployed functions. */
export function createLocalBackend(
  handlers: Record<CallableName, CallableHandler>,
  auth: CallableAuth | null,
): BudgetBackend {
  const call = <T>(name: CallableName, data?: unknown) =>
    handlers[name](auth, data) as Promise<T>;
  return {
    ensureUserProfile: () => call('ensureUserProfile'),
    updatePreferences: (request) => call('updatePreferences', request),
    createBudget: (request) => call('createBudget', request),
    createAccount: (request) => call('createAccount', request),
    saveTransaction: (request) => call('saveTransaction', request),
    saveCategory: (request) => call('saveCategory', request),
    archiveCategory: (request) => call('archiveCategory', request),
    saveCategorizationRule: (request) =>
      call('saveCategorizationRule', request),
    commitCsvImport: (request) => call('commitCsvImport', request),
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
