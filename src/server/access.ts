import type { Transaction } from 'firebase-admin/firestore';
import type { MembershipRecord } from '../shared/contracts';
import { activeMemberPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { assertActiveAdmin } from '../shared/domain/membership';
import { membershipFromSnapshot } from './converters';
import type { ServerDeps } from './context';

export interface ActiveBudgetMembership extends MembershipRecord {
  active_revision_id: string | null;
}

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
): Promise<ActiveBudgetMembership | null> {
  const accessRef = deps.db.doc(activeMemberPath(budgetId, uid));
  const budgetRef = deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`);
  const accessSnap = await tx.get(accessRef);
  if (!accessSnap.exists) return null;

  const [membershipSnap, budgetSnap] = await Promise.all([
    tx.get(
      deps.db.doc(
        `${COLLECTIONS.memberships}/${accessSnap.get('membership_id')}`,
      ),
    ),
    tx.get(budgetRef),
  ]);
  if (!membershipSnap.exists || !budgetSnap.exists) return null;

  const membership = membershipFromSnapshot(membershipSnap);
  const consistent =
    membership.status === 'ACTIVE' &&
    membership.budget_id === budgetId &&
    membership.user_id === uid;
  return consistent
    ? {
        ...membership,
        active_revision_id:
          (budgetSnap.get('active_revision_id') as string | null | undefined) ??
          null,
      }
    : null;
}

export async function requireActiveAdmin(
  deps: ServerDeps,
  tx: Transaction,
  budgetId: string,
  uid: string,
): Promise<ActiveBudgetMembership> {
  const membership = await readActiveMembership(deps, tx, budgetId, uid);
  assertActiveAdmin(membership);
  if (!membership) throw new DomainError('NOT_ACTIVE_MEMBER');
  return membership;
}
