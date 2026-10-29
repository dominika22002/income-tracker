import type { ExchangeRatePoint } from '../shared/domain/currency';

const API_URL = 'https://api.frankfurter.dev/v2/rates';
const RATE_PATTERN = /^\d{1,9}(?:\.\d{1,10})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function fetchFrankfurterRateSeries(
  baseCurrency: string,
  quoteCurrency: string,
  fromDate: string,
  toDate: string,
  fetcher: typeof fetch = fetch,
): Promise<ExchangeRatePoint[]> {
  const url = new URL(API_URL);
  url.searchParams.set('base', baseCurrency);
  url.searchParams.set('quotes', quoteCurrency);
  url.searchParams.set('from', fromDate);
  url.searchParams.set('to', toDate);
  url.searchParams.set('providers', 'ecb');

  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Frankfurter returned HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Frankfurter returned an invalid rate series.');
  }

  return payload.map((value): ExchangeRatePoint => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>).date !== 'string' ||
      typeof (value as Record<string, unknown>).base !== 'string' ||
      typeof (value as Record<string, unknown>).quote !== 'string' ||
      typeof (value as Record<string, unknown>).rate !== 'number'
    ) {
      throw new Error('Frankfurter returned a malformed rate row.');
    }
    const row = value as Record<string, unknown>;
    const rate = String(row.rate);
    if (
      !DATE_PATTERN.test(row.date as string) ||
      row.base !== baseCurrency ||
      row.quote !== quoteCurrency ||
      !RATE_PATTERN.test(rate) ||
      Number(rate) <= 0
    ) {
      throw new Error('Frankfurter returned an invalid rate row.');
    }
    return {
      date: row.date as string,
      base: baseCurrency,
      quote: quoteCurrency,
      rate,
    };
  });
}
