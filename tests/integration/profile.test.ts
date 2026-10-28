import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/shared/domain/errors';
import { ensureUserProfile, updatePreferences } from '../../src/server/profile';
import { adminDb, clearFirestore, failingDb, testDeps } from './helpers';

const alice = {
  uid: 'alice',
  email: 'alice@example.test',
  displayName: 'Alice',
};

describe('user profile and preferences (I-FR-01, I-FR-21, I-FR-22)', () => {
  beforeEach(clearFirestore);

  it('creates the profile with default CHF/PLN/EUR preferences', async () => {
    const deps = testDeps();
    const prefs = await ensureUserProfile(deps, alice);
    expect(prefs).toEqual({
      user_id: 'alice',
      primary_currency: 'CHF',
      secondary_currencies: ['PLN', 'EUR'],
    });

    const user = (await adminDb().doc('users/alice').get()).data();
    expect(user).toMatchObject({
      email: 'alice@example.test',
      display_name: 'Alice',
    });
    // Only provider-independent profile data is stored: no secrets or tokens.
    expect(Object.keys(user ?? {}).sort()).toEqual([
      'created_at',
      'display_name',
      'email',
    ]);
  });

  it('is idempotent and keeps the preferences chosen by the user', async () => {
    const deps = testDeps();
    await ensureUserProfile(deps, alice);
    await updatePreferences(deps, alice, {
      primary_currency: 'USD',
      secondary_currencies: ['GBP'],
    });

    const again = await ensureUserProfile(deps, alice);
    expect(again.primary_currency).toBe('USD');
    expect(again.secondary_currencies).toEqual(['GBP']);
  });

  it('keeps preferences personal to each user', async () => {
    const deps = testDeps();
    await ensureUserProfile(deps, alice);
    await ensureUserProfile(deps, { uid: 'bob', email: 'bob@example.test' });
    await updatePreferences(deps, alice, {
      primary_currency: 'EUR',
      secondary_currencies: [],
    });

    const bob = (await adminDb().doc('user_preferences/bob').get()).data();
    expect(bob?.primary_currency).toBe('CHF');
  });

  it('rejects unauthenticated callers and invalid preferences', async () => {
    const deps = testDeps();
    await expect(ensureUserProfile(deps, null)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await ensureUserProfile(deps, alice);
    await expect(
      updatePreferences(deps, alice, {
        primary_currency: 'CHF',
        secondary_currencies: ['CHF'],
      }),
    ).rejects.toBeInstanceOf(DomainError);
    const stored = (await adminDb().doc('user_preferences/alice').get()).data();
    expect(stored?.secondary_currencies).toEqual(['PLN', 'EUR']);
  });

  it('refuses to set preferences without a profile', async () => {
    await expect(
      updatePreferences(testDeps(), alice, {
        primary_currency: 'USD',
        secondary_currencies: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('never leaves a profile without preferences if the operation fails midway', async () => {
    const deps = testDeps(undefined, failingDb(adminDb(), 2));
    await expect(ensureUserProfile(deps, alice)).rejects.toThrow(
      'Injected failure',
    );
    expect((await adminDb().doc('users/alice').get()).exists).toBe(false);
    expect((await adminDb().doc('user_preferences/alice').get()).exists).toBe(
      false,
    );
  });
});
