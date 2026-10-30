import { budgetDocumentPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { validateSaveSpendingLimitRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import { requireCaller, type Caller, type ServerDeps } from './context';
import { stableDocumentId } from './exchangeRates';

export async function saveSpendingLimit(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<void> {
  const { uid } = requireCaller(caller);
  const request = validateSaveSpendingLimitRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid spending limit.');
  }
  const categoryId =
    request.limit_scope === 'CATEGORY' ? request.category_id : null;
  const id = stableDocumentId(
    `spending-limit\0${request.budget_id}\0${request.limit_scope}\0${categoryId ?? ''}\0${request.period}`,
  );
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const limitRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.spendingLimits,
        id,
      ),
    );
    const [existing, category] = await Promise.all([
      tx.get(limitRef),
      categoryId
        ? tx.get(
            deps.db.doc(
              budgetDocumentPath(
                request.budget_id,
                actor.active_revision_id,
                COLLECTIONS.categories,
                categoryId,
              ),
            ),
          )
        : Promise.resolve(null),
    ]);
    if (
      categoryId &&
      (!category?.exists ||
        category.get('budget_id') !== request.budget_id ||
        category.get('kind') !== 'EXPENSE' ||
        category.get('archived_at') != null)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'A category limit requires an active expense category in this budget.',
      );
    }

    tx.set(
      limitRef,
      {
        spending_limit_id: id,
        budget_id: request.budget_id,
        limit_scope: request.limit_scope,
        category_id: categoryId,
        period: request.period,
        limit_amount: request.limit_amount,
        currency: request.currency,
        ...(!existing.exists
          ? { created_by_membership_id: actor.membership_id }
          : {}),
      },
      { merge: true },
    );
  });
}
