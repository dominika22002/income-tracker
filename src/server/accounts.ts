import type { CreateAccountResult, MembershipRecord } from '../shared/contracts';
import { budgetDocumentPath, COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { validateCreateAccountRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import { accountToData, membershipFromSnapshot } from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';

function ensureActiveOwner(
  owner: MembershipRecord,
  budgetId: string,
): void {
  if (owner.budget_id !== budgetId || owner.status !== 'ACTIVE') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Account owner must be an active member of this budget.',
    );
  }
}

/**
 * Creates a source account in the caller's budget scope.
 *
 * If `owner_membership_id` is omitted, the caller's active membership is used.
 * This keeps CSV imports tied to the signed-in member by default.
 */
export async function createAccount(
  deps: ServerDeps,
  caller: Caller | null,
  request: unknown,
): Promise<CreateAccountResult> {
  const { uid } = requireCaller(caller);
  const validated = validateCreateAccountRequest(request);
  if (!validated) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid account request.');
  }

  const accountId = validated.account_id ?? deps.newId();

  return deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, validated.budget_id, uid);
    if (!actor) {
      throw new DomainError('NOT_ACTIVE_MEMBER');
    }
    const accountRef = deps.db.doc(
      budgetDocumentPath(
        validated.budget_id,
        actor.active_revision_id,
        COLLECTIONS.accounts,
        accountId,
      ),
    );

    const ownerMembershipId = validated.owner_membership_id ?? actor.membership_id;
    const ownerSnap = await tx.get(
      deps.db.doc(`${COLLECTIONS.memberships}/${ownerMembershipId}`),
    );
    if (!ownerSnap.exists) {
      throw new DomainError('INVALID_ARGUMENT', 'Account owner does not exist.');
    }
    const owner = membershipFromSnapshot(ownerSnap);
    ensureActiveOwner(owner, validated.budget_id);

    const existing = await tx.get(accountRef);
    if (existing.exists) {
      throw new DomainError('ALREADY_EXISTS');
    }

    tx.create(
      accountRef,
      accountToData({
        budget_id: validated.budget_id,
        owner_membership_id: ownerMembershipId,
        label: validated.label,
        institution_name: validated.institution_name ?? null,
        currency: validated.currency,
        account_type: validated.account_type,
        created_at: deps.now(),
        archived_at: null,
      }),
    );
    return { account_id: accountId };
  });
}
