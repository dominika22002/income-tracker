import type {
  UpdatePreferencesRequest,
  UserPreferencesRecord,
} from '../shared/contracts';
import { COLLECTIONS } from '../shared/firestorePaths';
import { DomainError } from '../shared/domain/errors';
import { defaultPreferences } from '../shared/domain/preferences';
import { validatePreferencesRequest } from '../shared/validators';
import {
  preferencesFromSnapshot,
  preferencesToData,
  userToData,
} from './converters';
import { requireCaller, type Caller, type ServerDeps } from './context';

/**
 * Creates the profile and default currency preferences on first sign-in.
 * Identity data comes from the verified auth token, never from the client
 * payload. Only the Firebase uid links the profile to the login provider; no
 * passwords or tokens are stored.
 */
export async function ensureUserProfile(
  deps: ServerDeps,
  caller: Caller | null,
): Promise<UserPreferencesRecord> {
  const { uid, email, displayName } = requireCaller(caller);
  const userRef = deps.db.doc(`${COLLECTIONS.users}/${uid}`);
  const prefsRef = deps.db.doc(`${COLLECTIONS.userPreferences}/${uid}`);

  return deps.db.runTransaction(async (tx) => {
    const [userSnap, prefsSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(prefsRef),
    ]);

    if (!userSnap.exists) {
      tx.create(
        userRef,
        userToData({
          email: email ?? null,
          display_name: displayName ?? null,
          created_at: deps.now(),
        }),
      );
    }
    if (prefsSnap.exists) {
      return preferencesFromSnapshot(prefsSnap);
    }

    const defaults = { user_id: uid, ...defaultPreferences() };
    tx.create(prefsRef, preferencesToData(defaults));
    return defaults;
  });
}

export async function updatePreferences(
  deps: ServerDeps,
  caller: Caller | null,
  request: unknown,
): Promise<UserPreferencesRecord> {
  const { uid } = requireCaller(caller);
  const validated: UpdatePreferencesRequest | null =
    validatePreferencesRequest(request);
  if (!validated) {
    throw new DomainError('INVALID_ARGUMENT', 'Invalid currency preferences.');
  }

  const userRef = deps.db.doc(`${COLLECTIONS.users}/${uid}`);
  const prefsRef = deps.db.doc(`${COLLECTIONS.userPreferences}/${uid}`);

  return deps.db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throw new DomainError('NOT_FOUND', 'Profile does not exist.');
    }
    tx.set(prefsRef, preferencesToData(validated));
    return { user_id: uid, ...validated };
  });
}
