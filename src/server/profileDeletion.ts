import type { DocumentReference, UpdateData } from 'firebase-admin/firestore';
import type { DeleteProfileResult } from '../shared/contracts';
import { COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { normalizeEmail } from '../shared/domain/invitation';
import { requireCaller, type Caller, type ServerDeps } from './context';
import { finishBudgetDeletion, leaveInTransaction } from './memberships';

export interface ProfileDeletionDeps extends ServerDeps {
  /** Removes the login identity; the only step that needs Admin Auth. */
  deleteAuthUser: (uid: string) => Promise<void>;
}

const MAX_PASSES = 5;

async function bulkUpdate(
  deps: ServerDeps,
  updates: { ref: DocumentReference; data: UpdateData<object> }[],
): Promise<void> {
  const writer = deps.db.bulkWriter();
  const results = updates.map(({ ref, data }) => writer.update(ref, data));
  await writer.close();
  await Promise.all(results);
}

/**
 * Permanently deletes the caller's profile (FR-87–FR-89).
 *
 * 1. Every active membership ends; ending and anonymizing (`user_id = null`)
 *    happen in the same transaction as admin succession or, for the last
 *    member, budget deletion.
 * 2. Historical memberships and `created_by_user_id` are anonymized. Nothing
 *    inside a budget is touched, so authored and hidden records stay as they
 *    are; they reference immutable `membership_id`s.
 * 3. Only when no reference to the user remains are the profile documents and
 *    the login identity deleted. Every step is idempotent, so a failed call
 *    can be repeated until it succeeds.
 */
export async function deleteMyProfile(
  deps: ProfileDeletionDeps,
  caller: Caller | null,
): Promise<DeleteProfileResult> {
  const { uid } = requireCaller(caller);
  const deleted: string[] = [];
  const cleanupPending: string[] = [];

  const userSnap = await deps.db.doc(`${COLLECTIONS.users}/${uid}`).get();
  const storedEmail = userSnap.get('email') as string | null | undefined;
  const email = storedEmail ?? caller?.email ?? null;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const active = await deps.db
      .collection(COLLECTIONS.memberships)
      .where('user_id', '==', uid)
      .where('status', '==', 'ACTIVE')
      .get();
    if (active.empty) break;

    for (const membership of active.docs) {
      const budgetId = membership.get('budget_id') as string;
      try {
        const { budgetDeleted } = await deps.db.runTransaction((tx) =>
          leaveInTransaction(deps, tx, budgetId, uid, { anonymize: true }),
        );
        if (budgetDeleted) {
          deleted.push(budgetId);
          if (!(await finishBudgetDeletion(deps, budgetId))) {
            cleanupPending.push(budgetId);
          }
        }
      } catch (error) {
        const raced =
          error instanceof DomainError && error.code === 'NOT_ACTIVE_MEMBER';
        if (!raced) throw error;
      }
    }
  }

  const remaining = await deps.db
    .collection(COLLECTIONS.memberships)
    .where('user_id', '==', uid)
    .get();
  if (remaining.docs.some((doc) => doc.get('status') === 'ACTIVE')) {
    throw new Error(
      'Profile deletion is incomplete: active memberships remain.',
    );
  }
  await bulkUpdate(
    deps,
    remaining.docs.map((doc) => ({ ref: doc.ref, data: { user_id: null } })),
  );

  const createdBudgets = await deps.db
    .collection(COLLECTIONS.budgets)
    .where('created_by_user_id', '==', uid)
    .get();
  await bulkUpdate(
    deps,
    createdBudgets.docs.map((doc) => ({
      ref: doc.ref,
      data: { created_by_user_id: null },
    })),
  );

  if (email) {
    // Ended invitations addressed to this person no longer need their e-mail.
    const addressed = await deps.db
      .collection(COLLECTIONS.invitations)
      .where('invitee_email', '==', normalizeEmail(email))
      .get();
    await bulkUpdate(
      deps,
      addressed.docs
        .filter((doc) => doc.get('status') !== 'PENDING')
        .map((doc) => ({ ref: doc.ref, data: { invitee_email: null } })),
    );
  }

  const stillReferenced = await deps.db
    .collection(COLLECTIONS.memberships)
    .where('user_id', '==', uid)
    .limit(1)
    .get();
  if (!stillReferenced.empty) {
    throw new Error(
      'Profile deletion is incomplete: memberships still reference the user.',
    );
  }

  await Promise.all([
    deps.db.doc(`${COLLECTIONS.users}/${uid}`).delete(),
    deps.db.doc(`${COLLECTIONS.userPreferences}/${uid}`).delete(),
  ]);
  await deps.deleteAuthUser(uid);

  return {
    deleted_budget_ids: deleted,
    cleanup_pending_budget_ids: cleanupPending,
  };
}
