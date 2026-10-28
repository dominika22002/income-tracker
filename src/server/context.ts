import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { DomainError } from '../shared/domain/errors';

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
}

export function createServerDeps(
  db: Firestore,
  overrides: Partial<Omit<ServerDeps, 'db'>> = {},
): ServerDeps {
  return {
    db,
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? (() => randomUUID()),
  };
}

export function requireCaller(caller: Caller | null | undefined): Caller {
  if (!caller || typeof caller.uid !== 'string' || caller.uid === '') {
    throw new DomainError('UNAUTHENTICATED');
  }
  return caller;
}
