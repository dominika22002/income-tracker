import type {
  GetTransactionConversionsResult,
  TransactionConversionView,
} from '../shared/contracts';
import { createTransactionConversion } from '../shared/domain/currency';
import { DomainError } from '../shared/domain/errors';
import { COLLECTIONS } from '../shared/firestorePaths';
import { validateGetTransactionConversionsRequest } from '../shared/validators';
import { readActiveMembership } from './access';
import {
  resolveExchangeRate,
  transactionConversionDocumentId,
  exchangeRateDocumentId,
} from './exchangeRates';
import { requireCaller, type Caller, type ServerDeps } from './context';

export async function getTransactionConversions(
  deps: ServerDeps,
  caller: Caller | null,
  input: unknown,
): Promise<GetTransactionConversionsResult> {
  const { uid } = requireCaller(caller);
  const request = validateGetTransactionConversionsRequest(input);
  if (!request) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid conversion request.');
  }

  const source = await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor) throw new DomainError('NOT_ACTIVE_MEMBER');
    const transactionRef = deps.db.doc(
      `${COLLECTIONS.transactions}/${request.transaction_id}`,
    );
    const preferencesRef = deps.db.doc(`${COLLECTIONS.userPreferences}/${uid}`);
    const [transaction, preferences] = await Promise.all([
      tx.get(transactionRef),
      tx.get(preferencesRef),
    ]);
    if (
      !transaction.exists ||
      transaction.get('budget_id') !== request.budget_id
    ) {
      throw new DomainError('NOT_FOUND');
    }
    if (!preferences.exists) throw new DomainError('NOT_FOUND');
    const targets = [
      preferences.get('primary_currency') as string,
      ...(preferences.get('secondary_currencies') as string[]),
    ];
    return {
      actorMembershipId: actor.membership_id,
      amount: transaction.get('amount') as string,
      currency: transaction.get('currency') as string,
      operationDate: transaction.get('operation_date') as string,
      targets: [...new Set(targets)],
    };
  });

  const resolved = await Promise.all(
    source.targets.map(async (targetCurrency) => ({
      targetCurrency,
      result: await resolveExchangeRate(
        deps,
        source.currency,
        targetCurrency,
        source.operationDate,
      ),
    })),
  );
  const unavailableCurrencies = resolved
    .filter((item) => item.result.point === null)
    .map((item) => item.targetCurrency);
  const conversions: TransactionConversionView[] = resolved.flatMap(
    ({ targetCurrency, result }) => {
      const conversion = createTransactionConversion(
        source.amount,
        targetCurrency,
        result.point,
      );
      return conversion && result.point
        ? [
            {
              ...conversion,
              transaction_id: request.transaction_id,
              calculated_at: deps.now().toISOString(),
              exchange_rate_id: result.cachedRateId
                ? result.cachedRateId
                : result.point.base === result.point.quote
                  ? null
                  : exchangeRateDocumentId(
                      result.point.base,
                      result.point.quote,
                      result.point.date,
                    ),
            },
          ]
        : [];
    },
  );

  const transactionRef = deps.db.doc(
    `${COLLECTIONS.transactions}/${request.transaction_id}`,
  );
  await deps.db.runTransaction(async (tx) => {
    const actor = await readActiveMembership(deps, tx, request.budget_id, uid);
    if (!actor || actor.membership_id !== source.actorMembershipId) {
      throw new DomainError('NOT_ACTIVE_MEMBER');
    }
    const transaction = await tx.get(transactionRef);
    if (
      !transaction.exists ||
      transaction.get('budget_id') !== request.budget_id
    ) {
      throw new DomainError('NOT_FOUND');
    }
    if (
      transaction.get('amount') !== source.amount ||
      transaction.get('currency') !== source.currency ||
      transaction.get('operation_date') !== source.operationDate
    ) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'Transaction changed while its conversions were being calculated.',
      );
    }

    const conversionRefs = conversions.map((conversion) =>
      deps.db.doc(
        `${COLLECTIONS.transactionConversions}/${transactionConversionDocumentId(
          conversion.transaction_id,
          conversion.target_currency,
        )}`,
      ),
    );
    await Promise.all(conversionRefs.map((ref) => tx.get(ref)));

    const now = deps.now();
    conversions.forEach((conversion, index) => {
      const view: TransactionConversionView = {
        ...conversion,
        calculated_at: now.toISOString(),
      };
      tx.set(conversionRefs[index], {
        transaction_id: request.transaction_id,
        target_currency: conversion.target_currency,
        exchange_rate_id: conversion.exchange_rate_id,
        rate_used: conversion.rate_used,
        rate_date: conversion.rate_date,
        converted_amount: conversion.converted_amount,
        display_amount: conversion.display_amount,
        calculated_at: now,
      });
      conversions[index] = view;
    });
  });

  return {
    conversions,
    unavailable_currencies: unavailableCurrencies,
  };
}
