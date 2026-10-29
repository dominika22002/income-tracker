import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { DomainError } from '../shared/domain/errors';
import type { ExchangeRatePoint } from '../shared/domain/currency';
import { fetchFrankfurterRateSeries } from './frankfurter';

export type ExchangeRateFetcher = (
  baseCurrency: string,
  quoteCurrency: string,
  fromDate: string,
  toDate: string,
) => Promise<ExchangeRatePoint[]>;

export interface Caller {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
}

export interface ServerDeps {
  db: Firestore;
  now: () => Date;
  newId: () => string;
  fetchExchangeRates: ExchangeRateFetcher;
}

export function createServerDeps(
  db: Firestore,
  overrides: Partial<Omit<ServerDeps, 'db'>> = {},
): ServerDeps {
  return {
    db,
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? (() => randomUUID()),
    fetchExchangeRates:
      overrides.fetchExchangeRates ?? fetchFrankfurterRateSeries,
  };
}

export function requireCaller(caller: Caller | null | undefined): Caller {
  if (!caller || typeof caller.uid !== 'string' || caller.uid === '') {
    throw new DomainError('UNAUTHENTICATED');
  }
  return caller;
}
