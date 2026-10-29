import { createHash } from 'node:crypto';
import type { ExchangeRatePoint } from '../shared/domain/currency';
import { COLLECTIONS } from '../shared/firestorePaths';
import type { ServerDeps } from './context';

export const ECB_PROVIDER = 'ECB';

export function stableDocumentId(value: string): string {
  const hex = createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export interface ResolvedExchangeRate {
  point: ExchangeRatePoint | null;
  cachedRateId: string | null;
  fetched: ExchangeRatePoint[];
}

export async function resolveExchangeRate(
  deps: ServerDeps,
  baseCurrency: string,
  quoteCurrency: string,
  requestedDate: string,
): Promise<ResolvedExchangeRate> {
  if (baseCurrency === quoteCurrency) {
    return {
      point: {
        date: requestedDate,
        base: baseCurrency,
        quote: quoteCurrency,
        rate: '1',
      },
      cachedRateId: null,
      fetched: [],
    };
  }

  const lookupRef = deps.db.doc(
    `${COLLECTIONS.exchangeRateLookups}/${stableDocumentId(
      `exchange-rate-lookup\0${baseCurrency}\0${quoteCurrency}\0${requestedDate}\0${ECB_PROVIDER}`,
    )}`,
  );
  const lookup = await lookupRef.get();
  if (lookup.exists) {
    if (lookup.get('found') !== true) {
      return { point: null, cachedRateId: null, fetched: [] };
    }
    return {
      point: {
        date: lookup.get('rate_date') as string,
        base: baseCurrency,
        quote: quoteCurrency,
        rate: lookup.get('rate') as string,
      },
      cachedRateId: (lookup.get('exchange_rate_id') as string | null) ?? null,
      fetched: [],
    };
  }

  const cached = await deps.db
    .collection(COLLECTIONS.exchangeRates)
    .where('base_currency', '==', baseCurrency)
    .where('quote_currency', '==', quoteCurrency)
    .where('provider', '==', ECB_PROVIDER)
    .where('rate_date', '<=', requestedDate)
    .orderBy('rate_date', 'desc')
    .limit(1)
    .get();
  const cachedDoc = cached.docs[0];
  const cachedPoint: ExchangeRatePoint | null = cachedDoc
    ? {
        date: cachedDoc.get('rate_date') as string,
        base: baseCurrency,
        quote: quoteCurrency,
        rate: cachedDoc.get('rate') as string,
      }
    : null;
  const windows = [0, 14, 31, 90, 365, 1_825, 10_000];
  let fetched: ExchangeRatePoint[] = [];
  for (const days of windows) {
    fetched = await deps.fetchExchangeRates(
      baseCurrency,
      quoteCurrency,
      subtractDays(requestedDate, days),
      requestedDate,
    );
    if (fetched.length > 0) break;
  }
  const point =
    [...fetched, ...(cachedPoint ? [cachedPoint] : [])]
      .filter((rate) => rate.date <= requestedDate)
      .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
  const cachedRateId =
    point && point.date === cachedPoint?.date ? cachedDoc.id : null;

  const rateDocuments = fetched.map((rate) => ({
    id: exchangeRateDocumentId(rate.base, rate.quote, rate.date),
    point: rate,
  }));
  const rateRefs = rateDocuments.map(({ id }) =>
    deps.db.doc(`${COLLECTIONS.exchangeRates}/${id}`),
  );
  await deps.db.runTransaction(async (tx) => {
    await Promise.all([lookupRef, ...rateRefs].map((ref) => tx.get(ref)));
    rateDocuments.forEach(({ point: rate }, index) => {
      tx.set(rateRefs[index], {
        base_currency: rate.base,
        quote_currency: rate.quote,
        rate_date: rate.date,
        rate: rate.rate,
        provider: ECB_PROVIDER,
        fetched_at: deps.now(),
      });
    });
    tx.set(lookupRef, {
      base_currency: baseCurrency,
      quote_currency: quoteCurrency,
      requested_date: requestedDate,
      found: point !== null,
      exchange_rate_id:
        point && point.base !== point.quote
          ? (cachedRateId ??
            exchangeRateDocumentId(point.base, point.quote, point.date))
          : null,
      rate_date: point?.date ?? null,
      rate: point?.rate ?? null,
      provider: ECB_PROVIDER,
      fetched_at: deps.now(),
    });
  });
  return { point, cachedRateId, fetched };
}

export function exchangeRateDocumentId(
  baseCurrency: string,
  quoteCurrency: string,
  rateDate: string,
  provider = ECB_PROVIDER,
): string {
  return stableDocumentId(
    `exchange-rate\0${baseCurrency}\0${quoteCurrency}\0${rateDate}\0${provider}`,
  );
}

export function transactionConversionDocumentId(
  transactionId: string,
  targetCurrency: string,
): string {
  return stableDocumentId(
    `transaction-conversion\0${transactionId}\0${targetCurrency}`,
  );
}
