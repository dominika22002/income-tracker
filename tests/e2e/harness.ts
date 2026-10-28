import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { Firestore } from 'firebase/firestore';
import { createFirestoreDataSource } from '../../src/renderer/src/backend/firestoreData';
import type {
  AppServices,
  AuthGateway,
  Session,
} from '../../src/renderer/src/backend/ports';
import { createHandlers, createLocalBackend } from '../../src/server/callable';
import { testDeps, TestClock } from '../integration/helpers';

export interface TestUser {
  uid: string;
  email: string;
  displayName: string;
}

/** Stands in for the Google OAuth provider (the real flow is a manual test). */
export class FakeAuthGateway implements AuthGateway {
  private session: Session | null = null;
  private readonly listeners = new Set<(session: Session | null) => void>();
  failNextSignIn: Error | null = null;

  constructor(private readonly user: TestUser) {}

  subscribe(listener: (session: Session | null) => void) {
    this.listeners.add(listener);
    listener(this.session);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async signIn() {
    if (this.failNextSignIn) {
      const error = this.failNextSignIn;
      this.failNextSignIn = null;
      throw error;
    }
    this.session = {
      uid: this.user.uid,
      email: this.user.email,
      displayName: this.user.displayName,
    };
    this.emit();
  }

  async signOut() {
    this.session = null;
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener(this.session);
  }
}

export async function createRulesEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: 'demo-income-tracker',
    firestore: {
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
    },
  });
}

/**
 * Real trusted services (in-process transport) plus a real Firestore client
 * that is subject to the production security rules.
 */
export function servicesFor(
  env: RulesTestEnvironment,
  user: TestUser,
  clock: TestClock,
): { services: AppServices; auth: FakeAuthGateway } {
  const handlers = createHandlers({
    ...testDeps(clock),
    deleteAuthUser: async () => {},
  });
  const backend = createLocalBackend(handlers, {
    uid: user.uid,
    token: {
      email: user.email,
      email_verified: true,
      name: user.displayName,
    },
  });
  const db = env
    .authenticatedContext(user.uid, {
      email: user.email,
      email_verified: true,
    })
    .firestore() as unknown as Firestore;
  const auth = new FakeAuthGateway(user);
  return {
    auth,
    services: { auth, backend, data: createFirestoreDataSource(db) },
  };
}
