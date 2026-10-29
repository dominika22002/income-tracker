import { getApps, initializeApp } from 'firebase-admin/app';
import {
  getFirestore,
  Timestamp,
  type Firestore,
} from 'firebase-admin/firestore';
import { createServerDeps, type ServerDeps } from '../../src/server/context';
import type { ExchangeRatePoint } from '../../src/shared/domain/currency';

const SYNTHETIC_RATES: ExchangeRatePoint[] = [
  { date: '2026-03-09', base: 'EUR', quote: 'CHF', rate: '0.9123456789' },
  { date: '2026-03-10', base: 'CHF', quote: 'EUR', rate: '1.095' },
];

const PROJECT_ID = 'demo-income-tracker';

// The Admin SDK would otherwise probe the cloud metadata server for credentials.
process.env.METADATA_SERVER_DETECTION ??= 'none';

export function adminDb(): Firestore {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set; run via `npm run test:rules`.',
    );
  }
  const app =
    getApps().find((candidate) => candidate.name === 'integration') ??
    initializeApp({ projectId: PROJECT_ID }, 'integration');
  return getFirestore(app);
}

export async function clearFirestore(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new Error(`Could not clear the emulator: ${response.status}`);
  }
}

export class TestClock {
  private current: Date;

  constructor(start = '2026-03-01T10:00:00.000Z') {
    this.current = new Date(start);
  }

  now = (): Date => new Date(this.current.getTime());

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }
}

export function sequentialIds(prefix = 1): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = String(counter).padStart(12, '0');
    return `${String(prefix).padStart(8, '0')}-0000-4000-8000-${suffix}`;
  };
}

export function testDeps(
  clock: TestClock = new TestClock(),
  db: Firestore = adminDb(),
): ServerDeps {
  return createServerDeps(db, {
    now: clock.now,
    newId: sequentialIds(),
    fetchExchangeRates: async (base, quote, from, to) =>
      SYNTHETIC_RATES.filter(
        (rate) =>
          rate.base === base &&
          rate.quote === quote &&
          rate.date >= from &&
          rate.date <= to,
      ),
  });
}

/**
 * Wraps a Firestore instance so that the Nth write issued inside a
 * transaction throws, simulating a failure halfway through an operation.
 */
export function failingDb(db: Firestore, failOnWrite: number): Firestore {
  const writeMethods = new Set(['set', 'create', 'update', 'delete']);
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'runTransaction') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback: (tx: unknown) => Promise<unknown>) => {
        let writes = 0;
        return target.runTransaction((tx) =>
          callback(
            new Proxy(tx, {
              get(txTarget, txProperty) {
                const value = Reflect.get(txTarget, txProperty);
                if (
                  typeof txProperty === 'string' &&
                  writeMethods.has(txProperty) &&
                  typeof value === 'function'
                ) {
                  return (...args: unknown[]) => {
                    writes += 1;
                    if (writes === failOnWrite) {
                      throw new Error(`Injected failure on write #${writes}`);
                    }
                    return value.apply(txTarget, args);
                  };
                }
                return typeof value === 'function'
                  ? value.bind(txTarget)
                  : value;
              },
            }),
          ),
        );
      };
    },
  });
}

export async function countDocs(db: Firestore, path: string): Promise<number> {
  return (await db.collection(path).count().get()).data().count;
}

export function fixedId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export interface SeedMember {
  uid: string;
  membershipId: string;
  role?: 'ADMIN' | 'MEMBER';
  joinedAt?: string;
}

/** Writes a budget with ACTIVE memberships directly (explicit ids and dates). */
export async function seedBudgetDirect(
  db: Firestore,
  budgetId: string,
  members: SeedMember[],
): Promise<void> {
  const batch = db.batch();
  batch.set(db.doc(`budgets/${budgetId}`), {
    name: 'Seeded',
    created_at: Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')),
    created_by_user_id: members[0]?.uid ?? null,
  });
  for (const member of members) {
    const role = member.role ?? 'MEMBER';
    const joined = Timestamp.fromDate(
      new Date(member.joinedAt ?? '2026-01-01T00:00:00Z'),
    );
    batch.set(db.doc(`memberships/${member.membershipId}`), {
      budget_id: budgetId,
      user_id: member.uid,
      role,
      status: 'ACTIVE',
      joined_at: joined,
      ended_at: null,
    });
    batch.set(db.doc(`budgets/${budgetId}/active_members/${member.uid}`), {
      membership_id: member.membershipId,
      role,
      joined_at: joined,
      display_name: member.uid,
      email: `${member.uid}@example.test`,
    });
  }
  await batch.commit();
}

export async function activeRoles(
  db: Firestore,
  budgetId: string,
): Promise<Record<string, string>> {
  const snapshot = await db
    .collection(`budgets/${budgetId}/active_members`)
    .get();
  return Object.fromEntries(
    snapshot.docs.map((doc) => [doc.id, doc.get('role') as string]),
  );
}
