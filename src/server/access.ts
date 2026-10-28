import type { Transaction } from 'firebase-admin/firestore';
import type { MembershipRecord } from '../shared/contracts';
import { activeMemberPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { assertActiveAdmin } from '../shared/domain/membership';
import { membershipFromSnapshot } from './converters';
import type { ServerDeps } from './context';

/**
 * Reads the caller's active membership via the access index and confirms it
 * against the membership document. Both must agree, otherwise the caller is
 * not an active member.
 */
export async function readActiveMembership(
  deps: ServerDeps,
  tx: Transaction,
  budgetId: string,
  uid: string,
): Promise<MembershipRecord | null> {
  const accessSnap = await tx.get(deps.db.doc(activeMemberPath(budgetId, uid)));
  if (!accessSnap.exists) return null;

  const membershipSnap = await tx.get(
    deps.db.doc(
      `${COLLECTIONS.memberships}/${accessSnap.get('membership_id')}`,
    ),
  );
  if (!membershipSnap.exists) return null;

  const membership = membershipFromSnapshot(membershipSnap);
  const consistent =
    membership.status === 'ACTIVE' &&
    membership.budget_id === budgetId &&
    membership.user_id === uid;
  return consistent ? membership : null;
}

export async function requireActiveAdmin(
  deps: ServerDeps,
  tx: Transaction,
  budgetId: string,
  uid: string,
): Promise<MembershipRecord> {
  const membership = await readActiveMembership(deps, tx, budgetId, uid);
  assertActiveAdmin(membership);
  if (!membership) throw new DomainError('NOT_ACTIVE_MEMBER');
  return membership;
}
