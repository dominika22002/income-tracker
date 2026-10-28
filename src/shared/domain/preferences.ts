import type { UpdatePreferencesRequest } from '../contracts';

export const DEFAULT_PRIMARY_CURRENCY = 'CHF';
export const DEFAULT_SECONDARY_CURRENCIES: readonly string[] = ['PLN', 'EUR'];
export const MAX_SECONDARY_CURRENCIES = 10;

export function defaultPreferences(): UpdatePreferencesRequest {
  return {
    primary_currency: DEFAULT_PRIMARY_CURRENCY,
    secondary_currencies: [...DEFAULT_SECONDARY_CURRENCIES],
  };
}

let knownCurrencies: ReadonlySet<string> | undefined;

export function isIsoCurrencyCode(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    return false;
  }
  knownCurrencies ??= new Set(Intl.supportedValuesOf('currency'));
  return knownCurrencies.has(value);
}
