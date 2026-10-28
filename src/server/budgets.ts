import type { CreateBudgetResult } from '../shared/contracts';
import { activeMemberPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { validateCreateBudgetRequest } from '../shared/validators';
import {
  activeMemberFromSnapshot,
  activeMemberToData,
  budgetToData,
  membershipToData,
} from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';

/**
 * Creates a budget together with the creator's first ACTIVE admin membership
 * and its access-index document in a single transaction: either all three
 * documents exist afterwards or none of them.
 *
 * A client-supplied `budget_id` acts as an idempotency key (TR-12): repeating
 * the call for a budget the caller already created returns the same result.
 */
export async function createBudget(
  deps: ServerDeps,
  caller: Caller | null,
  request: unknown,
): Promise<CreateBudgetResult> {
  const { uid, email, displayName } = requireCaller(caller);
  const validated = validateCreateBudgetRequest(request);
  if (!validated) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid budget request.');
  }

  const budgetId = validated.budget_id ?? deps.newId();
  const membershipId = deps.newId();
  const budgetRef = deps.db.doc(`${COLLECTIONS.budgets}/${budgetId}`);
  const membershipRef = deps.db.doc(
    `${COLLECTIONS.memberships}/${membershipId}`,
  );
  const accessRef = deps.db.doc(activeMemberPath(budgetId, uid));

  return deps.db.runTransaction(async (tx) => {
    const [budgetSnap, accessSnap] = await Promise.all([
      tx.get(budgetRef),
      tx.get(accessRef),
    ]);

    if (budgetSnap.exists) {
      const createdByCaller = budgetSnap.get('created_by_user_id') === uid;
      if (!createdByCaller || !accessSnap.exists) {
        throw new DomainError('ALREADY_EXISTS');
      }
      return {
        budget_id: budgetId,
        membership_id: activeMemberFromSnapshot(accessSnap).membership_id,
      };
    }

    const now = deps.now();
    tx.create(
      budgetRef,
      budgetToData({
        name: validated.name,
        created_at: now,
        created_by_user_id: uid,
      }),
    );
    tx.create(
      membershipRef,
      membershipToData({
        budget_id: budgetId,
        user_id: uid,
        role: 'ADMIN',
        status: 'ACTIVE',
        joined_at: now,
        ended_at: null,
      }),
    );
    tx.create(
      accessRef,
      activeMemberToData({
        membership_id: membershipId,
        role: 'ADMIN',
        joined_at: now,
        display_name: displayName ?? null,
        email: email ?? null,
      }),
    );
    return { budget_id: budgetId, membership_id: membershipId };
  });
}
