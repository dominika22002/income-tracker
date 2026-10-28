import { describe, expect, it } from 'vitest';
import type { ActiveMember } from '../../src/shared/domain/membership';
import {
  assertActiveAdmin,
  assertCanRemoveMember,
  assertMembershipTransition,
  assertNoActiveMembership,
  canTransitionMembership,
  hasExactlyOneAdmin,
  planLeave,
  selectSuccessor,
} from '../../src/shared/domain/membership';
import { DomainError } from '../../src/shared/domain/errors';
import type { MembershipStatus } from '../../src/shared/contracts';

function member(
  id: string,
  joinedAt: string,
  role: 'ADMIN' | 'MEMBER' = 'MEMBER',
): ActiveMember {
  return {
    membership_id: id,
    user_id: `user-${id}`,
    role,
    joined_at: new Date(joinedAt),
  };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('membership status transitions (U-FR-06, U-TR-09)', () => {
  const all: MembershipStatus[] = ['ACTIVE', 'LEFT', 'REMOVED'];

  it('allows only ACTIVE -> LEFT and ACTIVE -> REMOVED', () => {
    const allowed: string[] = [];
    for (const from of all) {
      for (const to of all) {
        if (canTransitionMembership(from, to)) allowed.push(`${from}>${to}`);
      }
    }
    expect(allowed).toEqual(['ACTIVE>LEFT', 'ACTIVE>REMOVED']);
  });

  it('rejects leaving the terminal states', () => {
    expect(codeOf(() => assertMembershipTransition('LEFT', 'ACTIVE'))).toBe(
      'INVALID_TRANSITION',
    );
    expect(codeOf(() => assertMembershipTransition('REMOVED', 'LEFT'))).toBe(
      'INVALID_TRANSITION',
    );
    expect(codeOf(() => assertMembershipTransition('ACTIVE', 'ACTIVE'))).toBe(
      'INVALID_TRANSITION',
    );
    expect(
      codeOf(() => assertMembershipTransition('ACTIVE', 'LEFT')),
    ).toBeUndefined();
  });
});

describe('admin succession (U-FR-07)', () => {
  it('picks the earliest joined member', () => {
    const members = [
      member('a', '2026-01-01T00:00:00Z', 'ADMIN'),
      member('c', '2026-03-01T00:00:00Z'),
      member('b', '2026-02-01T00:00:00Z'),
    ];
    expect(selectSuccessor(members, 'a')?.membership_id).toBe('b');
  });

  it('breaks joined_at ties with membership_id', () => {
    const members = [
      member('m-3', '2026-02-01T00:00:00Z'),
      member('a', '2026-01-01T00:00:00Z', 'ADMIN'),
      member('m-1', '2026-02-01T00:00:00Z'),
      member('m-2', '2026-02-01T00:00:00Z'),
    ];
    expect(selectSuccessor(members, 'a')?.membership_id).toBe('m-1');
  });

  it('is independent of input order and does not mutate it', () => {
    const base = [
      member('a', '2026-01-01T00:00:00Z', 'ADMIN'),
      member('x', '2026-02-01T00:00:00Z'),
      member('y', '2026-02-01T00:00:00Z'),
    ];
    const reversed = [...base].reverse();
    const snapshot = base.map((m) => m.membership_id);
    expect(selectSuccessor(base, 'a')?.membership_id).toBe('x');
    expect(selectSuccessor(reversed, 'a')?.membership_id).toBe('x');
    expect(base.map((m) => m.membership_id)).toEqual(snapshot);
  });

  it('compares ids by code units, not by locale', () => {
    const members = [
      member('a', '2026-01-01T00:00:00Z', 'ADMIN'),
      member('b', '2026-02-01T00:00:00Z'),
      member('B', '2026-02-01T00:00:00Z'),
    ];
    expect(selectSuccessor(members, 'a')?.membership_id).toBe('B');
  });

  it('returns null when nobody remains (no phantom admin)', () => {
    expect(
      selectSuccessor([member('a', '2026-01-01T00:00:00Z', 'ADMIN')], 'a'),
    ).toBeNull();
  });
});

describe('leave planning (U-FR-07, U-FR-09)', () => {
  it('lets a regular member leave without role changes', () => {
    const members = [
      member('a', '2026-01-01T00:00:00Z', 'ADMIN'),
      member('b', '2026-02-01T00:00:00Z'),
    ];
    expect(planLeave(members, 'b')).toEqual({ kind: 'member_leaves' });
  });

  it('transfers the admin role to the deterministic successor', () => {
    const members = [
      member('a', '2026-01-01T00:00:00Z', 'ADMIN'),
      member('z', '2026-02-01T00:00:00Z'),
      member('b', '2026-02-01T00:00:00Z'),
    ];
    expect(planLeave(members, 'a')).toEqual({
      kind: 'admin_leaves_with_successor',
      successorMembershipId: 'b',
    });
  });

  it('flags the last member so the budget is removed', () => {
    const members = [member('a', '2026-01-01T00:00:00Z', 'ADMIN')];
    expect(planLeave(members, 'a')).toEqual({ kind: 'last_member_leaves' });
  });

  it('rejects someone who is not an active member', () => {
    const members = [member('a', '2026-01-01T00:00:00Z', 'ADMIN')];
    expect(codeOf(() => planLeave(members, 'ghost'))).toBe('NOT_ACTIVE_MEMBER');
  });
});

describe('member removal and roles (U-FR-06)', () => {
  const admin = {
    membership_id: 'a',
    budget_id: 'b1',
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
  };
  const target = {
    membership_id: 't',
    budget_id: 'b1',
    status: 'ACTIVE' as const,
  };

  it('lets an active admin remove another active member of the same budget', () => {
    expect(codeOf(() => assertCanRemoveMember(admin, target))).toBeUndefined();
  });

  it('rejects removal by a regular member', () => {
    expect(
      codeOf(() => assertCanRemoveMember({ ...admin, role: 'MEMBER' }, target)),
    ).toBe('NOT_ADMIN');
  });

  it('rejects removal by an inactive admin', () => {
    expect(
      codeOf(() => assertCanRemoveMember({ ...admin, status: 'LEFT' }, target)),
    ).toBe('NOT_ACTIVE_MEMBER');
  });

  it('rejects removing yourself, a foreign-budget member or an ended membership', () => {
    expect(
      codeOf(() =>
        assertCanRemoveMember(admin, { ...target, membership_id: 'a' }),
      ),
    ).toBe('CANNOT_REMOVE_SELF');
    expect(
      codeOf(() =>
        assertCanRemoveMember(admin, { ...target, budget_id: 'b2' }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      codeOf(() => assertCanRemoveMember(admin, { ...target, status: 'LEFT' })),
    ).toBe('NOT_ACTIVE_MEMBER');
  });

  it('checks admin role for privileged operations', () => {
    expect(
      codeOf(() => assertActiveAdmin({ role: 'ADMIN', status: 'ACTIVE' })),
    ).toBeUndefined();
    expect(
      codeOf(() => assertActiveAdmin({ role: 'MEMBER', status: 'ACTIVE' })),
    ).toBe('NOT_ADMIN');
    expect(
      codeOf(() => assertActiveAdmin({ role: 'ADMIN', status: 'REMOVED' })),
    ).toBe('NOT_ACTIVE_MEMBER');
    expect(codeOf(() => assertActiveAdmin(null))).toBe('NOT_ACTIVE_MEMBER');
  });
});

describe('budget invariants (U-FR-05)', () => {
  it('allows at most one active membership per user and budget', () => {
    expect(codeOf(() => assertNoActiveMembership([]))).toBeUndefined();
    expect(codeOf(() => assertNoActiveMembership(['m1']))).toBe(
      'ALREADY_MEMBER',
    );
  });

  it('requires exactly one active admin', () => {
    const admin = member('a', '2026-01-01T00:00:00Z', 'ADMIN');
    const other = member('b', '2026-01-02T00:00:00Z');
    expect(hasExactlyOneAdmin([admin, other])).toBe(true);
    expect(hasExactlyOneAdmin([other])).toBe(false);
    expect(hasExactlyOneAdmin([admin, { ...other, role: 'ADMIN' }])).toBe(
      false,
    );
  });
});
