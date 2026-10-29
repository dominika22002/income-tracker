import { describe, expect, it } from 'vitest';
import {
  callerFromAuth,
  CALLABLE_NAMES,
  createHandlers,
  toCallableError,
} from '../../src/server/callable';
import { createServerDeps } from '../../src/server/context';
import type { DomainErrorCode } from '../../src/shared/contracts';
import { DomainError } from '../../src/shared/domain/errors';
import { toDomainError } from '../../src/renderer/src/backend/callableBackend';
import { describeError } from '../../src/renderer/src/features/budgets/errorMessages';

const ALL_CODES: DomainErrorCode[] = [
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
  'DUPLICATE_REVIEW_REQUIRED',
];

describe('callable layer (U-FR-01, U-TR-06)', () => {
  it('derives the caller only from the verified auth context', () => {
    expect(callerFromAuth(null)).toBeNull();
    expect(callerFromAuth(undefined)).toBeNull();
    expect(
      callerFromAuth({
        uid: 'u1',
        token: { email: 'a@b.c', email_verified: true, name: 'A' },
      }),
    ).toEqual({
      uid: 'u1',
      email: 'a@b.c',
      emailVerified: true,
      displayName: 'A',
    });
  });

  it('exposes one handler for every callable name', () => {
    const handlers = createHandlers({
      ...createServerDeps({} as never),
      deleteAuthUser: async () => {},
    });
    expect(Object.keys(handlers).sort()).toEqual([...CALLABLE_NAMES].sort());
  });

  it('rejects every call without authentication before touching the database', async () => {
    const handlers = createHandlers({
      ...createServerDeps({} as never),
      deleteAuthUser: async () => {},
    });
    for (const name of CALLABLE_NAMES) {
      await expect(handlers[name](null, {})).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('maps every domain error to a status and keeps its code', () => {
    for (const code of ALL_CODES) {
      const mapped = toCallableError(new DomainError(code));
      expect(mapped.code).not.toBe('internal');
      expect(mapped.domainCode).toBe(code);
    }
  });

  it('hides details of unexpected errors', () => {
    expect(toCallableError(new Error('secret stack detail'))).toEqual({
      code: 'internal',
      message: 'Internal error.',
    });
  });
});

describe('client error handling (TR-11)', () => {
  it('restores the domain code from a callable error', () => {
    const error = toDomainError({
      message: 'x',
      details: { code: 'INVITATION_NOT_PENDING' },
    });
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('INVITATION_NOT_PENDING');
  });

  it('ignores unknown codes', () => {
    expect(toDomainError({ details: { code: 'NOPE' } })).not.toBeInstanceOf(
      DomainError,
    );
    expect(toDomainError('boom')).toBeInstanceOf(Error);
  });

  it('describes every domain error and never claims success for unknown ones', () => {
    for (const code of ALL_CODES) {
      expect(describeError(new DomainError(code))).toMatch(/\w/);
    }
    expect(describeError(new Error('offline'))).toContain('offline');
    expect(describeError(undefined)).toContain('not saved');
    expect(
      describeError(
        Object.assign(new Error('internal [0]'), {
          code: 'functions/internal',
        }),
      ),
    ).toContain('uruchom lokalne emulatory');
  });
});
