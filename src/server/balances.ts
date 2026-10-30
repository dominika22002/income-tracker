import { createHash } from 'node:crypto';
import type { SaveAccountBalanceResult } from '../shared/contracts';
import { DomainError } from '../shared/domain/errors';
import { budgetDocumentPath, COLLECTIONS } from '../shared/firestorePaths';
import { validateSaveAccountBalanceRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import { requireCaller, type Caller, type ServerDeps } from './context';

function snapshotId(accountId: string, balanceDate: string): string {
  return createHash('sha256')
    .update(`${accountId}\0${balanceDate}`)
    .digest('hex');
}

export async function saveAccountBalance(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<SaveAccountBalanceResult> {
  const { uid } = requireCaller(caller);
  const request = validateSaveAccountBalanceRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid account balance.');
  }
  const id = snapshotId(request.account_id, request.balance_date);
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const accountRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.accounts,
        request.account_id,
      ),
    );
    const snapshotRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.accountBalanceSnapshots,
        id,
      ),
    );
    const [account, existing] = await Promise.all([
      tx.get(accountRef),
      tx.get(snapshotRef),
    ]);
    if (
      !account.exists ||
      account.get('budget_id') !== request.budget_id ||
      account.get('archived_at') != null
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Account is outside this budget.',
      );
    }
    if (account.get('currency') !== request.currency) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Manual balance currency must match the account currency.',
      );
    }
    if (existing.exists && existing.get('account_id') !== request.account_id) {
      throw new DomainError('ALREADY_EXISTS');
    }
    tx.set(snapshotRef, {
      account_id: request.account_id,
      import_batch_id: null,
      balance_date: request.balance_date,
      balance_amount: request.balance_amount,
      currency: request.currency,
      source: 'MANUAL',
      created_by_membership_id: actor.membership_id,
      created_at: deps.now(),
    });
  });
  return { snapshot_id: id };
}
