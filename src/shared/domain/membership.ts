import type { MembershipRecord, MembershipStatus } from '../contracts';
import { DomainError } from './errors';

export type ActiveMember = Pick<
  MembershipRecord,
  'membership_id' | 'user_id' | 'role' | 'joined_at'
>;

const MEMBERSHIP_TRANSITIONS: Readonly<
  Record<MembershipStatus, readonly MembershipStatus[]>
> = {
  ACTIVE: ['LEFT', 'REMOVED'],
  LEFT: [],
  REMOVED: [],
};

export function canTransitionMembership(
  from: MembershipStatus,
  to: MembershipStatus,
): boolean {
  return MEMBERSHIP_TRANSITIONS[from].includes(to);
}

export function assertMembershipTransition(
  from: MembershipStatus,
  to: MembershipStatus,
): void {
  if (!canTransitionMembership(from, to)) {
    throw new DomainError(
      'INVALID_TRANSITION',
      `Membership cannot change from ${from} to ${to}.`,
    );
  }
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Order used for admin succession: earliest `joined_at`, then `membership_id`. */
export function compareMembersForSuccession(
  a: ActiveMember,
  b: ActiveMember,
): number {
  const byDate = a.joined_at.getTime() - b.joined_at.getTime();
  if (byDate !== 0) return byDate;
  return compareCodeUnits(a.membership_id, b.membership_id);
}

export function selectSuccessor(
  activeMembers: readonly ActiveMember[],
  leavingMembershipId: string,
): ActiveMember | null {
  const remaining = activeMembers
    .filter((member) => member.membership_id !== leavingMembershipId)
    .sort(compareMembersForSuccession);
  return remaining[0] ?? null;
}

export function hasExactlyOneAdmin(
  activeMembers: readonly ActiveMember[],
): boolean {
  return activeMembers.filter((member) => member.role === 'ADMIN').length === 1;
}

export type LeavePlan =
  | { kind: 'member_leaves' }
  | { kind: 'admin_leaves_with_successor'; successorMembershipId: string }
  | { kind: 'last_member_leaves' };

/**
 * Decides what must happen when an active member leaves. `activeMembers` must
 * be the complete, current list of active members of the budget.
 */
export function planLeave(
  activeMembers: readonly ActiveMember[],
  leavingMembershipId: string,
): LeavePlan {
  const leaving = activeMembers.find(
    (member) => member.membership_id === leavingMembershipId,
  );
  if (!leaving) {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }

  const successor = selectSuccessor(activeMembers, leavingMembershipId);
  if (!successor) {
    return { kind: 'last_member_leaves' };
  }
  if (leaving.role === 'ADMIN') {
    return {
      kind: 'admin_leaves_with_successor',
      successorMembershipId: successor.membership_id,
    };
  }
  return { kind: 'member_leaves' };
}

/** Validates that `actor` may remove `target` from the same budget. */
export function assertCanRemoveMember(
  actor: Pick<
    MembershipRecord,
    'membership_id' | 'budget_id' | 'role' | 'status'
  >,
  target: Pick<MembershipRecord, 'membership_id' | 'budget_id' | 'status'>,
): void {
  if (actor.status !== 'ACTIVE') {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }
  if (actor.role !== 'ADMIN') {
    throw new DomainError('NOT_ADMIN');
  }
  if (target.budget_id !== actor.budget_id) {
    throw new DomainError('NOT_FOUND');
  }
  if (target.membership_id === actor.membership_id) {
    throw new DomainError('CANNOT_REMOVE_SELF');
  }
  if (target.status !== 'ACTIVE') {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }
}

/** A user may hold at most one active membership per budget. */
export function assertNoActiveMembership(
  existingActiveMembershipIds: readonly string[],
): void {
  if (existingActiveMembershipIds.length > 0) {
    throw new DomainError('ALREADY_MEMBER');
  }
}

export function assertActiveAdmin(
  member: Pick<MembershipRecord, 'role' | 'status'> | null,
): void {
  if (!member || member.status !== 'ACTIVE') {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }
  if (member.role !== 'ADMIN') {
    throw new DomainError('NOT_ADMIN');
  }
}
