import type {
  SaveCategorizationRuleRequest,
  SaveCategorizationRuleResult,
} from '../shared/contracts';
import { COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { validateSaveCategorizationRuleRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import { requireCaller, type Caller, type ServerDeps } from './context';

export async function saveCategorizationRule(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<SaveCategorizationRuleResult> {
  const { uid } = requireCaller(caller);
  const request: SaveCategorizationRuleRequest | null =
    validateSaveCategorizationRuleRequest(input);
  if (!request) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Invalid categorization rule request.',
    );
  }
  const ruleId = request.rule_id ?? deps.newId();
  const ruleRef = deps.db.doc(`${COLLECTIONS.categorizationRules}/${ruleId}`);
  const categoryRef = deps.db.doc(
    `${COLLECTIONS.categories}/${request.category_id}`,
  );

  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const [category, existing, account] = await Promise.all([
      tx.get(categoryRef),
      tx.get(ruleRef),
      request.match_field === 'ACCOUNT'
        ? tx.get(deps.db.doc(`${COLLECTIONS.accounts}/${request.match_value}`))
        : Promise.resolve(null),
    ]);
    if (
      !category.exists ||
      category.get('budget_id') !== request.budget_id ||
      category.get('archived_at') != null
    ) {
      throw new DomainError('INVALID_ARGUMENT', 'Category is not available.');
    }
    if (request.match_field === 'ACCOUNT') {
      if (
        !account?.exists ||
        account.get('budget_id') !== request.budget_id ||
        account.get('archived_at') != null
      ) {
        throw new DomainError('INVALID_ARGUMENT', 'Account is not available.');
      }
    }
    if (request.rule_id) {
      if (
        !existing.exists ||
        existing.get('budget_id') !== request.budget_id ||
        existing.get('source') !== 'USER'
      ) {
        throw new DomainError('NOT_FOUND');
      }
    }

    const ruleData = {
      budget_id: request.budget_id,
      category_id: request.category_id,
      created_by_membership_id:
        existing.get('created_by_membership_id') ?? actor.membership_id,
      source: 'USER',
      match_field: request.match_field,
      operator: request.operator,
      match_value: request.match_value,
      priority: request.priority,
      enabled: request.enabled ?? true,
    };
    if (existing.exists) tx.set(ruleRef, ruleData);
    else tx.create(ruleRef, ruleData);
  });
  return { rule_id: ruleId };
}
