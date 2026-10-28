import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/shared/domain/errors';
import {
  assertInvitationTransition,
  assertInviteeAllowed,
  canTransitionInvitation,
  computeExpiresAt,
  evaluateInvitationUse,
  isInvitationExpired,
} from '../../src/shared/domain/invitation';
import type { InvitationStatus } from '../../src/shared/contracts';

const CREATED = new Date('2026-03-01T10:00:00.000Z');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('invitation validity (U-FR-04)', () => {
  it('expires exactly 7 days after creation', () => {
    expect(computeExpiresAt(CREATED).getTime() - CREATED.getTime()).toBe(
      SEVEN_DAYS_MS,
    );
  });

  it('is valid just before the boundary and expired at or after it', () => {
    const expires = computeExpiresAt(CREATED);
    expect(isInvitationExpired(expires, new Date(expires.getTime() - 1))).toBe(
      false,
    );
    expect(isInvitationExpired(expires, expires)).toBe(true);
    expect(isInvitationExpired(expires, new Date(expires.getTime() + 1))).toBe(
      true,
    );
  });
});

describe('invitation status transitions (U-FR-04)', () => {
  const all: InvitationStatus[] = [
    'PENDING',
    'ACCEPTED',
    'DECLINED',
    'EXPIRED',
    'CANCELLED',
  ];

  it('allows only transitions out of PENDING', () => {
    for (const from of all) {
      for (const to of all) {
        expect(canTransitionInvitation(from, to)).toBe(
          from === 'PENDING' && to !== 'PENDING',
        );
      }
    }
  });

  it('throws INVALID_TRANSITION for reuse of a terminal invitation', () => {
    expect(() => assertInvitationTransition('ACCEPTED', 'ACCEPTED')).toThrow(
      DomainError,
    );
    expect(() =>
      assertInvitationTransition('PENDING', 'ACCEPTED'),
    ).not.toThrow();
  });
});

describe('evaluateInvitationUse (U-FR-04, single use)', () => {
  const expires_at = computeExpiresAt(CREATED);

  it('is usable only while pending and before expiry', () => {
    expect(
      evaluateInvitationUse({ status: 'PENDING', expires_at }, CREATED),
    ).toBe('usable');
  });

  it('reports expired for a stale pending invitation and for EXPIRED', () => {
    expect(
      evaluateInvitationUse({ status: 'PENDING', expires_at }, expires_at),
    ).toBe('expired');
    expect(
      evaluateInvitationUse({ status: 'EXPIRED', expires_at }, CREATED),
    ).toBe('expired');
  });

  it.each(['ACCEPTED', 'DECLINED', 'CANCELLED'] as const)(
    'rejects reuse of a %s invitation',
    (status) => {
      expect(evaluateInvitationUse({ status, expires_at }, CREATED)).toBe(
        'not_pending',
      );
    },
  );
});

describe('address-restricted invitations (U-FR-04)', () => {
  it('allows anyone when no address is set', () => {
    expect(() => assertInviteeAllowed(null, {})).not.toThrow();
  });

  it('requires a verified, case-insensitive match', () => {
    expect(() =>
      assertInviteeAllowed('guest@example.test', {
        email: ' Guest@Example.TEST ',
        emailVerified: true,
      }),
    ).not.toThrow();
  });

  it('rejects unverified, missing or different addresses', () => {
    for (const auth of [
      { email: 'guest@example.test', emailVerified: false },
      { email: 'guest@example.test' },
      { emailVerified: true },
      { email: 'other@example.test', emailVerified: true },
    ]) {
      expect(() => assertInviteeAllowed('guest@example.test', auth)).toThrow(
        DomainError,
      );
    }
  });
});
