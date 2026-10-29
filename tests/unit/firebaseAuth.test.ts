import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  updateProfile,
  type Auth,
  type User,
  type UserCredential,
} from 'firebase/auth';
import {
  createFirebaseAuthGateway,
  signInAsDevelopmentUser,
} from '../../src/renderer/src/backend/firebaseAuth';

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(),
  onIdTokenChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
}));

describe('development Firebase sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and signs in as dominika22002 on the auth emulator', async () => {
    const auth = {} as Auth;
    const user = {
      displayName: null,
      getIdToken: vi.fn().mockResolvedValue('id-token'),
    } as unknown as User;
    const credential = { user } as UserCredential;

    vi.mocked(signInWithEmailAndPassword).mockImplementation(() =>
      Promise.reject({ code: 'auth/user-not-found' }),
    );
    vi.mocked(createUserWithEmailAndPassword).mockResolvedValue(credential);

    await signInAsDevelopmentUser(auth);

    expect(createUserWithEmailAndPassword).toHaveBeenCalledWith(
      auth,
      'dominika22002@example.test',
      'income-tracker-emulator-only',
    );
    expect(updateProfile).toHaveBeenCalledWith(user, {
      displayName: 'dominika22002',
    });
    expect(user.getIdToken).toHaveBeenCalledWith(true);
  });

  it('automatically signs in as Dominika without starting OAuth', async () => {
    const user = {
      uid: 'dominika-emulator-uid',
      email: 'dominika22002@example.test',
      displayName: null,
      getIdToken: vi.fn().mockResolvedValue('id-token'),
    } as unknown as User;
    const auth = { currentUser: user } as Auth;

    vi.mocked(onIdTokenChanged).mockImplementation((_auth, onNext) => {
      if (typeof onNext === 'function') onNext(null);
      return () => undefined;
    });
    vi.mocked(signInWithEmailAndPassword).mockRejectedValue({
      code: 'auth/user-not-found',
    });
    vi.mocked(createUserWithEmailAndPassword).mockResolvedValue({
      user,
    } as UserCredential);
    vi.mocked(updateProfile).mockImplementation(async (_user, profile) => {
      Object.assign(user, profile);
    });

    const startExternalLogin = vi.fn();
    const onSession = vi.fn();
    const onError = vi.fn();
    const authGateway = createFirebaseAuthGateway(
      auth,
      startExternalLogin,
      false,
    );

    authGateway.subscribe(onSession, onError);
    await vi.waitFor(() =>
      expect(onSession).toHaveBeenCalledWith({
        uid: 'dominika-emulator-uid',
        email: 'dominika22002@example.test',
        displayName: 'dominika22002',
      }),
    );

    expect(startExternalLogin).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
