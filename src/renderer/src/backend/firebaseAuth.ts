import { onAuthStateChanged, signOut, type Auth } from 'firebase/auth';
import type { AuthGateway, Session } from './ports';

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
 * (see README), so sessions arrive through `onAuthStateChanged`.
 */
export function createFirebaseAuthGateway(
  auth: Auth,
  startExternalLogin: () => Promise<void>,
): AuthGateway {
  return {
    subscribe(listener) {
      return onAuthStateChanged(auth, (user) => listener(toSession(user)));
    },
    signIn: startExternalLogin,
    signOut: () => signOut(auth),
  };
}
