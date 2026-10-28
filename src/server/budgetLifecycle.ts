import type { DocumentReference } from 'firebase-admin/firestore';
import { activeMembersPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { toTimestamp } from './converters';
import type { ServerDeps } from './context';

export function purgeMarkerRef(deps: ServerDeps, budgetId: string) {
  return deps.db.doc(`${COLLECTIONS.budgetPurgeQueue}/${budgetId}`);
}

export function purgeMarkerData(deps: ServerDeps) {
  return { requested_at: toTimestamp(deps.now()) };
}

async function deleteAll(
  deps: ServerDeps,
  refs: DocumentReference[],
): Promise<void> {
  const writer = deps.db.bulkWriter();
  const results = refs.map((ref) => writer.delete(ref));
  await writer.close();
  await Promise.all(results);
}

/**
 * Second phase of budget deletion. The budget document and its access index
 * are removed atomically in the transaction that ended the last membership, so
 * access is already blocked; this removes everything else and is safe to
 * repeat after a crash. It refuses to run while the budget has active members
 * (FR-09).
 */
export async function purgeBudgetData(
  deps: ServerDeps,
  budgetId: string,
): Promise<void> {
  const [budgetSnap, activeSnap] = await Promise.all([
    deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`).get(),
    deps.db.collection(activeMembersPath(budgetId)).limit(1).get(),
  ]);
  if (budgetSnap.exists || !activeSnap.empty) {
    throw new DomainError('BUDGET_HAS_ACTIVE_MEMBERS');
  }

  const invitations = await deps.db
    .collection(COLLECTIONS.invitations)
    .where('budget_id', '==', budgetId)
    .get();
  const memberships = await deps.db
    .collection(COLLECTIONS.memberships)
    .where('budget_id', '==', budgetId)
    .get();

  await deleteAll(deps, [
    ...invitations.docs.map((doc) =>
      deps.db.doc(
        `${COLLECTIONS.invitationTokens}/${doc.get('token_hash') as string}`,
      ),
    ),
    ...invitations.docs.map((doc) => doc.ref),
    ...memberships.docs.map((doc) => doc.ref),
  ]);

  await deps.db.recursiveDelete(
    deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`),
  );
  await deps.db.recursiveDelete(
    deps.db.doc(`${COLLECTIONS.budgetRecords}/${budgetId}`),
  );
  await purgeMarkerRef(deps, budgetId).delete();
}

/** Finishes deletions interrupted after the access-blocking transaction. */
export async function purgePendingBudgets(
  deps: ServerDeps,
): Promise<{ purged: string[]; failed: string[] }> {
  const markers = await deps.db.collection(COLLECTIONS.budgetPurgeQueue).get();
  const purged: string[] = [];
  const failed: string[] = [];
  for (const marker of markers.docs) {
    try {
      await purgeBudgetData(deps, marker.id);
      purged.push(marker.id);
    } catch {
      failed.push(marker.id);
    }
  }
  return { purged, failed };
}
