import type {
  ReviewTransferRequest,
  ReviewTransferResult,
} from '../shared/contracts';
import { multiplyDecimals, sumDecimals } from '../shared/domain/currency';
import { compareDecimalAmounts } from '../shared/domain/transactions';
import { DomainError } from '../shared/domain/errors';
import {
  budgetCollectionPath,
  budgetDocumentPath,
  COLLECTIONS,
} from '../shared/firestorePaths';
import { validateReviewTransferRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import {
  ECB_PROVIDER,
  exchangeRateDocumentId,
  resolveExchangeRate,
  stableDocumentId,
} from './exchangeRates';
import { requireCaller, type Caller, type ServerDeps } from './context';

interface TransferLeg {
  id: string;
  account_id: string;
  budget_id: string;
  operation_date: string;
  description: string;
  amount: string;
  currency: string;
  fee: string | null;
  type: string;
  transfer_group_id: string | null;
}

function groupId(request: ReviewTransferRequest): string {
  return request.decision === 'CONFIRM_UNPAIRED'
    ? stableDocumentId(`transfer\0single\0${request.transaction_id}`)
    : stableDocumentId(
        `transfer\0${request.outgoing_transaction_id}\0${request.incoming_transaction_id}`,
      );
}

function legFromSnapshot(
  id: string,
  snapshot: FirebaseFirestore.DocumentSnapshot,
): TransferLeg {
  return {
    id,
    account_id: snapshot.get('account_id') as string,
    budget_id: snapshot.get('budget_id') as string,
    operation_date: snapshot.get('operation_date') as string,
    description: snapshot.get('description') as string,
    amount: snapshot.get('amount') as string,
    currency: snapshot.get('currency') as string,
    fee: (snapshot.get('fee') as string | null | undefined) ?? null,
    type: snapshot.get('type') as string,
    transfer_group_id:
      (snapshot.get('transfer_group_id') as string | null | undefined) ?? null,
  };
}

function subtractDecimals(left: string, right: string): string {
  return sumDecimals([left, `-${right}`]);
}

function feeExpenseId(transactionId: string): string {
  return stableDocumentId(`transfer-fee\0${transactionId}`);
}

function differenceExpenseId(group: string): string {
  return stableDocumentId(`transfer-difference\0${group}`);
}

export async function reviewTransfer(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<ReviewTransferResult> {
  const { uid } = requireCaller(caller);
  const request = validateReviewTransferRequest(input);
  if (!request)
    throw new DomainError('INVALID_ARGUMENT', 'Invalid transfer review.');

  const transferGroupId = groupId(request);
  const ids =
    request.decision === 'CONFIRM_UNPAIRED'
      ? [request.transaction_id!]
      : [request.outgoing_transaction_id!, request.incoming_transaction_id!];

  const preflight = await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const groupRef = deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        actor.active_revision_id,
        COLLECTIONS.transferGroups,
        transferGroupId,
      ),
    );
    const transactionRefs = ids.map((id) =>
      deps.db.doc(
        budgetDocumentPath(
          request.budget_id,
          actor.active_revision_id,
          COLLECTIONS.transactions,
          id,
        ),
      ),
    );
    const [group, ...transactions] = await Promise.all([
      tx.get(groupRef),
      ...transactionRefs.map((ref) => tx.get(ref)),
    ]);
    const groupAlreadyConfirmed =
      group.exists &&
      ['CONFIRMED', 'CONFIRMED_UNPAIRED'].includes(
        group.get('status') as string,
      );
    if (groupAlreadyConfirmed) {
      return {
        actorMembershipId: actor.membership_id,
        activeRevisionId: actor.active_revision_id,
        existingResult: {
          transfer_group_id: transferGroupId,
          status: group.get('status') as ReviewTransferResult['status'],
        },
        legs: [] as TransferLeg[],
      };
    }
    if (transactions.some((transaction) => !transaction.exists)) {
      throw new DomainError('NOT_FOUND');
    }
    const legs = transactions.map((transaction, index) =>
      legFromSnapshot(ids[index], transaction),
    );
    if (legs.some((leg) => leg.budget_id !== request.budget_id)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Transfer legs must share a budget.',
      );
    }
    if (request.decision !== 'REJECT') {
      const accounts = await Promise.all(
        legs.map((leg) =>
          tx.get(
            deps.db.doc(
              budgetDocumentPath(
                request.budget_id,
                actor.active_revision_id,
                COLLECTIONS.accounts,
                leg.account_id,
              ),
            ),
          ),
        ),
      );
      if (
        accounts.some(
          (account) =>
            !account.exists || account.get('budget_id') !== request.budget_id,
        )
      ) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Transfer account is outside this budget.',
        );
      }
      const splitItems = await Promise.all(
        legs.map((leg) =>
          tx.get(
            deps.db
              .collection(
                budgetCollectionPath(
                  request.budget_id,
                  actor.active_revision_id,
                  COLLECTIONS.splitItems,
                ),
              )
              .where('budget_id', '==', request.budget_id)
              .where('transaction_id', '==', leg.id),
          ),
        ),
      );
      if (splitItems.some((items) => !items.empty)) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Remove transaction splits before confirming a transfer.',
        );
      }
      if (legs.some((leg) => leg.transfer_group_id !== null)) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'A transfer leg is already confirmed.',
        );
      }
      if (request.decision === 'CONFIRM_PAIR') {
        const [outgoing, incoming] = legs;
        if (
          outgoing.account_id === incoming.account_id ||
          outgoing.type !== 'EXPENSE' ||
          incoming.type !== 'INCOME'
        ) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            'A confirmed pair must have one outgoing and one incoming transaction on different accounts.',
          );
        }
      } else if (!['EXPENSE', 'INCOME'].includes(legs[0].type)) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'A one-sided transfer must be an expense or income.',
        );
      }
    }
    return {
      actorMembershipId: actor.membership_id,
      activeRevisionId: actor.active_revision_id,
      existingResult: null,
      legs,
    };
  });
  if (preflight.existingResult) return preflight.existingResult;
  const groupRef = deps.db.doc(
    budgetDocumentPath(
      request.budget_id,
      preflight.activeRevisionId,
      COLLECTIONS.transferGroups,
      transferGroupId,
    ),
  );
  const transactionRefs = ids.map((id) =>
    deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        preflight.activeRevisionId,
        COLLECTIONS.transactions,
        id,
      ),
    ),
  );
  if (request.decision === 'REJECT') {
    await deps.db.runTransaction(async (tx) => {
      const actor = await readActiveMembership(
        deps,
        tx,
        request.budget_id,
        uid,
      );
      if (!actor || actor.membership_id !== preflight.actorMembershipId) {
        throw new DomainError('NOT_ACTIVE_MEMBER');
      }
      if (actor.active_revision_id !== preflight.activeRevisionId) {
        throw new DomainError('INVALID_TRANSITION');
      }
      const [group, ...transactions] = await Promise.all([
        tx.get(groupRef),
        ...transactionRefs.map((ref) => tx.get(ref)),
      ]);
      if (
        group.exists &&
        ['CONFIRMED', 'CONFIRMED_UNPAIRED'].includes(
          group.get('status') as string,
        )
      ) {
        return;
      }
      if (
        transactions.some(
          (transaction) =>
            !transaction.exists ||
            transaction.get('budget_id') !== request.budget_id,
        )
      ) {
        throw new DomainError('NOT_FOUND');
      }
      tx.set(groupRef, {
        budget_id: request.budget_id,
        status: 'REJECTED',
        outgoing_transaction_id: request.outgoing_transaction_id,
        incoming_transaction_id: request.incoming_transaction_id,
        transaction_id: null,
        created_by_membership_id: actor.membership_id,
        confirmed_by_membership_id: null,
        confirmed_at: null,
      });
    });
    return { transfer_group_id: transferGroupId, status: 'REJECTED' };
  }

  const [outgoing, incoming] =
    request.decision === 'CONFIRM_PAIR'
      ? preflight.legs
      : preflight.legs[0].type === 'EXPENSE'
        ? [preflight.legs[0], null]
        : [null, preflight.legs[0]];
  let difference: string | null = null;
  let fxRate: Awaited<ReturnType<typeof resolveExchangeRate>> | null = null;
  if (outgoing && incoming) {
    let incomingInOutgoingCurrency = incoming.amount;
    if (outgoing.currency !== incoming.currency) {
      fxRate = await resolveExchangeRate(
        deps,
        incoming.currency,
        outgoing.currency,
        incoming.operation_date,
      );
      if (!fxRate.point) {
        throw new DomainError(
          'EXCHANGE_RATE_UNAVAILABLE',
          'No ECB rate is available for this transfer date; the transfer was not confirmed.',
        );
      }
      incomingInOutgoingCurrency = multiplyDecimals(
        incoming.amount,
        fxRate.point.rate,
      );
    }
    difference = subtractDecimals(outgoing.amount, incomingInOutgoingCurrency);
  }

  const fees = preflight.legs.filter(
    (leg) => leg.fee && compareDecimalAmounts(leg.fee, '0') > 0,
  );
  const feeRefs = fees.map((leg) =>
    deps.db.doc(
      budgetDocumentPath(
        request.budget_id,
        preflight.activeRevisionId,
        COLLECTIONS.transactions,
        feeExpenseId(leg.id),
      ),
    ),
  );
  const differenceRef =
    difference && compareDecimalAmounts(difference, '0') > 0 && outgoing
      ? deps.db.doc(
          budgetDocumentPath(
            request.budget_id,
            preflight.activeRevisionId,
            COLLECTIONS.transactions,
            differenceExpenseId(transferGroupId),
          ),
        )
      : null;
  const rateRefs = fxRate
    ? fxRate.fetched.map((rate) =>
        deps.db.doc(
          `${COLLECTIONS.exchangeRates}/${exchangeRateDocumentId(
            rate.base,
            rate.quote,
            rate.date,
          )}`,
        ),
      )
    : [];
  const finalStatus =
    request.decision === 'CONFIRM_UNPAIRED'
      ? 'CONFIRMED_UNPAIRED'
      : 'CONFIRMED';

  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (
      !actor ||
      actor.membership_id !== preflight.actorMembershipId ||
      actor.active_revision_id !== preflight.activeRevisionId
    ) {
      throw new DomainError('NOT_ACTIVE_MEMBER');
    }
    const [group, ...transactions] = await Promise.all([
      tx.get(groupRef),
      ...transactionRefs.map((ref) => tx.get(ref)),
    ]);
    if (
      group.exists &&
      ['CONFIRMED', 'CONFIRMED_UNPAIRED'].includes(
        group.get('status') as string,
      )
    ) {
      return;
    }
    const currentLegs = transactions.map((transaction, index) => {
      if (!transaction.exists) throw new DomainError('NOT_FOUND');
      const current = legFromSnapshot(ids[index], transaction);
      const original = preflight.legs[index];
      if (
        current.amount !== original.amount ||
        current.currency !== original.currency ||
        current.operation_date !== original.operation_date ||
        current.type !== original.type ||
        current.transfer_group_id !== null
      ) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'A transaction changed while the transfer was being reviewed.',
        );
      }
      return current;
    });
    const allRefs = [
      ...feeRefs,
      ...(differenceRef ? [differenceRef] : []),
      ...rateRefs,
    ];
    await Promise.all(allRefs.map((ref) => tx.get(ref)));

    tx.set(groupRef, {
      budget_id: request.budget_id,
      status: finalStatus,
      outgoing_transaction_id: outgoing?.id ?? null,
      incoming_transaction_id: incoming?.id ?? null,
      transaction_id: request.transaction_id ?? null,
      fx_difference_amount: difference,
      fx_difference_currency: outgoing?.currency ?? null,
      fx_rate_used: fxRate?.point?.rate ?? null,
      fx_rate_date: fxRate?.point?.date ?? null,
      fx_rate_id:
        fxRate?.point &&
        outgoing &&
        incoming &&
        outgoing.currency !== incoming.currency
          ? exchangeRateDocumentId(
              fxRate.point.base,
              fxRate.point.quote,
              fxRate.point.date,
            )
          : null,
      created_by_membership_id: actor.membership_id,
      confirmed_by_membership_id: actor.membership_id,
      confirmed_at: deps.now(),
    });
    currentLegs.forEach((leg, index) => {
      tx.update(transactionRefs[index], {
        type: 'TRANSFER',
        transfer_group_id: transferGroupId,
        transfer_leg: leg.type === 'EXPENSE' ? 'OUTGOING' : 'INCOMING',
        category_id: null,
      });
    });
    fees.forEach((leg, index) => {
      tx.set(feeRefs[index], {
        budget_id: request.budget_id,
        account_id: leg.account_id,
        import_batch_id: null,
        bank_transaction_id: null,
        operation_date: leg.operation_date,
        description: `Opłata bankowa — ${leg.description}`,
        amount: leg.fee,
        currency: leg.currency,
        type: 'EXPENSE',
        category_id: null,
        fee: null,
        transfer_group_id: transferGroupId,
        transfer_leg: null,
        source_transaction_id: leg.id,
        generated_kind: 'TRANSFER_FEE',
        created_by_membership_id: actor.membership_id,
        created_at: deps.now(),
      });
    });
    if (differenceRef && difference && outgoing) {
      tx.set(differenceRef, {
        budget_id: request.budget_id,
        account_id: outgoing.account_id,
        import_batch_id: null,
        bank_transaction_id: null,
        operation_date: outgoing.operation_date,
        description: 'Różnica kursowa przy transferze',
        amount: difference,
        currency: outgoing.currency,
        type: 'EXPENSE',
        category_id: null,
        fee: null,
        transfer_group_id: transferGroupId,
        transfer_leg: null,
        generated_kind: 'FX_DIFFERENCE',
        created_by_membership_id: actor.membership_id,
        created_at: deps.now(),
      });
    }
    if (fxRate?.point && fxRate.point.base !== fxRate.point.quote) {
      fxRate.fetched.forEach((rate, index) => {
        tx.set(rateRefs[index], {
          base_currency: rate.base,
          quote_currency: rate.quote,
          rate_date: rate.date,
          rate: rate.rate,
          provider: ECB_PROVIDER,
          fetched_at: deps.now(),
        });
      });
    }
  });

  return { transfer_group_id: transferGroupId, status: finalStatus };
}
