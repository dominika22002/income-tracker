import {
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type Auth,
  type User,
} from 'firebase/auth';
import type { AuthGateway, Session } from './ports';

const DEVELOPMENT_USER_EMAIL = 'dominika22002@example.test';
const DEVELOPMENT_USER_PASSWORD = 'income-tracker-emulator-only';
const DEVELOPMENT_USER_NAME = 'dominika22002';

function hasAuthErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Firebase sign-in failed.');
}

export async function signInAsDevelopmentUser(auth: Auth): Promise<User> {
  let user: User;
  try {
    user = (
      await signInWithEmailAndPassword(
        auth,
        DEVELOPMENT_USER_EMAIL,
        DEVELOPMENT_USER_PASSWORD,
      )
    ).user;
  } catch (error) {
    if (!hasAuthErrorCode(error, 'auth/user-not-found')) {
      throw error;
    }
    user = (
      await createUserWithEmailAndPassword(
        auth,
        DEVELOPMENT_USER_EMAIL,
        DEVELOPMENT_USER_PASSWORD,
      )
    ).user;
  }

  await updateProfile(user, { displayName: DEVELOPMENT_USER_NAME });
  await user.getIdToken(true);
  return user;
}

function toSession(
  user: {
    uid: string;
    email: string | null;
    displayName: string | null;
  } | null,
): Session | null {
  return user
    ? { uid: user.uid, email: user.email, displayName: user.displayName }
    : null;
}

/**
 * Firebase Auth session handling; the app stores no passwords or tokens.
 *
 * `startExternalLogin` opens the system browser (Stage 0 OAuth prototype). The
 * token exchange for a live Google login still needs provider configuration
 * (see README). When auth is disabled locally, the gateway creates a fixed
 * development user against the Auth Emulator instead.
 */
export function createFirebaseAuthGateway(
  auth: Auth,
  startExternalLogin: () => Promise<void>,
  requireAuth = true,
): AuthGateway {
  let developmentSignIn: Promise<User> | null = null;
  const signInDevelopmentUser = () => {
    if (!developmentSignIn) {
      developmentSignIn = signInAsDevelopmentUser(auth).finally(() => {
        developmentSignIn = null;
      });
    }
    return developmentSignIn;
  };

  return {
    subscribe(listener, onError) {
      let active = true;
      let developmentSignInPending = false;
      let developmentSessionReady = false;

      const unsubscribe = onIdTokenChanged(
        auth,
        (user) => {
          if (requireAuth) {
            listener(toSession(user));
            return;
          }

          if (
            developmentSessionReady &&
            user?.email === DEVELOPMENT_USER_EMAIL &&
            user.displayName === DEVELOPMENT_USER_NAME
          ) {
            listener(toSession(user));
            return;
          }

          if (developmentSignInPending) return;
          developmentSignInPending = true;
          void signInDevelopmentUser()
            .then((developmentUser) => {
              if (!active) return;
              developmentSessionReady = true;
              listener(toSession(developmentUser));
            })
            .catch((error: unknown) => {
              if (active) onError(asError(error));
            })
            .finally(() => {
              developmentSignInPending = false;
            });
        },
        (error) => {
          if (active) onError(asError(error));
        },
      );

      return () => {
        active = false;
        unsubscribe();
      };
    },
    signIn: requireAuth
      ? startExternalLogin
      : async () => {
          await signInDevelopmentUser();
        },
    signOut: () => signOut(auth),
  };
}
