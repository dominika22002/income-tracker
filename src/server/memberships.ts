import type { Transaction } from 'firebase-admin/firestore';
import type { LeaveBudgetResult } from '../shared/contracts';
import {
  activeMemberPath,
  activeMembersPath,
  COLLECTIONS,
} from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import {
  assertCanRemoveMember,
  assertMembershipTransition,
  planLeave,
  type ActiveMember,
} from '../shared/domain/membership';
import { isUuid, validateRemoveMemberRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import {
  activeMemberFromSnapshot,
  membershipFromSnapshot,
  toTimestamp,
} from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';
import {
  purgeBudgetData,
  purgeMarkerData,
  purgeMarkerRef,
} from './budgetLifecycle';

export interface LeaveOptions {
  /** Also clears `user_id` on the ended membership (profile deletion). */
  anonymize: boolean;
}

/**
 * Ends the user's active membership inside an existing transaction.
 *
 * Reads the complete list of active members, so concurrent leave/remove
 * operations on the same budget conflict and are serialized by Firestore: a
 * retried transaction always plans against the committed state.
 * - member: membership -> LEFT, access document removed
 * - admin with others remaining: the earliest joined remaining member
 *   (then lowest membership_id) becomes admin in the same transaction
 * - last member: the budget document and access index are deleted atomically
 *   and a purge marker is written for the second cleanup phase
 */
export async function leaveInTransaction(
  deps: ServerDeps,
  tx: Transaction,
  budgetId: string,
  uid: string,
  options: LeaveOptions,
): Promise<{ budgetDeleted: boolean }> {
  const activeSnap = await tx.get(
    deps.db.collection(activeMembersPath(budgetId)),
  );
  const active = activeSnap.docs.map(activeMemberFromSnapshot);
  const own = active.find((member) => member.user_id === uid);
  if (!own) {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }

  const ownMembershipRef = deps.db.doc(
    `${COLLECTIONS.memberships}/${own.membership_id}`,
  );
  const ownMembershipSnap = await tx.get(ownMembershipRef);
  if (!ownMembershipSnap.exists) {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }
  const ownMembership = membershipFromSnapshot(ownMembershipSnap);
  if (ownMembership.user_id !== uid || ownMembership.budget_id !== budgetId) {
    throw new DomainError('NOT_ACTIVE_MEMBER');
  }
  assertMembershipTransition(ownMembership.status, 'LEFT');

  const members: ActiveMember[] = active.map((member) => ({
    membership_id: member.membership_id,
    user_id: member.user_id,
    role: member.role,
    joined_at: member.joined_at,
  }));
  const plan = planLeave(members, own.membership_id);
  const now = deps.now();

  tx.update(ownMembershipRef, {
    status: 'LEFT',
    ended_at: toTimestamp(now),
    ...(options.anonymize ? { user_id: null } : {}),
  });
  tx.delete(deps.db.doc(activeMemberPath(budgetId, uid)));

  if (plan.kind === 'admin_leaves_with_successor') {
    const successor = active.find(
      (member) => member.membership_id === plan.successorMembershipId,
    );
    if (!successor) {
      throw new DomainError('NOT_ACTIVE_MEMBER');
    }
    tx.update(
      deps.db.doc(`${COLLECTIONS.memberships}/${successor.membership_id}`),
      { role: 'ADMIN' },
    );
    tx.update(deps.db.doc(activeMemberPath(budgetId, successor.user_id)), {
      role: 'ADMIN',
    });
  }

  if (plan.kind === 'last_member_leaves') {
    tx.delete(deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`));
    tx.set(purgeMarkerRef(deps, budgetId), purgeMarkerData(deps));
  }

  return { budgetDeleted: plan.kind === 'last_member_leaves' };
}

/** Runs phase two of budget deletion; failures leave the marker for a retry. */
export async function finishBudgetDeletion(
  deps: ServerDeps,
  budgetId: string,
): Promise<boolean> {
  try {
    await purgeBudgetData(deps, budgetId);
    return true;
  } catch {
    return false;
  }
}

export async function leaveBudget(
  deps: ServerDeps,
  caller: Caller | null,
  budgetId: unknown,
): Promise<LeaveBudgetResult> {
  const { uid } = requireCaller(caller);
  if (!isUuid(budgetId)) {
    throw new DomainError('INVALID_ARGUMENT', 'Malformed budget id.');
  }

  const { budgetDeleted } = await deps.db.runTransaction((tx) =>
    leaveInTransaction(deps, tx, budgetId, uid, { anonymize: false }),
  );
  if (!budgetDeleted) {
    return { budget_deleted: false, cleanup_pending: false };
  }
  const cleaned = await finishBudgetDeletion(deps, budgetId);
  return { budget_deleted: true, cleanup_pending: !cleaned };
}

/** An admin removes another active member; their history is preserved. */
export async function removeMember(
  deps: ServerDeps,
  caller: Caller | null,
  request: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const validated = validateRemoveMemberRequest(request);
  if (!validated) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid removal request.');
  }

  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(
      deps,
      tx,
      validated.budget_id,
      uid,
    );
    if (!actor) {
      throw new DomainError('NOT_ACTIVE_MEMBER');
    }

    const targetRef = deps.db.doc(
      `${COLLECTIONS.memberships}/${validated.membership_id}`,
    );
    const targetSnap = await tx.get(targetRef);
    if (!targetSnap.exists) {
      throw new DomainError('NOT_FOUND');
    }
    const target = membershipFromSnapshot(targetSnap);
    assertCanRemoveMember(actor, target);
    if (target.user_id === null) {
      throw new DomainError('NOT_ACTIVE_MEMBER');
    }
    assertMembershipTransition(target.status, 'REMOVED');

    tx.update(targetRef, {
      status: 'REMOVED',
      ended_at: toTimestamp(deps.now()),
    });
    tx.delete(
      deps.db.doc(activeMemberPath(validated.budget_id, target.user_id)),
    );
  });
}
