import type {
  BudgetBackend,
  InvitationView,
  MemberView,
  MyBudgetView,
  UserPreferencesRecord,
} from '../../../shared/contracts';

export interface Session {
  uid: string;
  email: string | null;
  displayName: string | null;
}

/** Login provider boundary; the UI never handles passwords or tokens. */
export interface AuthGateway {
  subscribe(listener: (session: Session | null) => void): () => void;
  /** Rejects when the sign-in fails or is cancelled; no session is created. */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export type Unsubscribe = () => void;
export type ErrorListener = (error: Error) => void;

/**
 * Read side. Implementations talk to Firestore with the signed-in user's
 * credentials, so the security rules (not the UI) decide what is returned.
 */
export interface BudgetDataSource {
  subscribeMyBudgets(
    uid: string,
    onData: (budgets: MyBudgetView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeMembers(
    budgetId: string,
    onData: (members: MemberView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeInvitations(
    budgetId: string,
    onData: (invitations: InvitationView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  getPreferences(uid: string): Promise<UserPreferencesRecord | null>;
}

export interface AppServices {
  auth: AuthGateway;
  backend: BudgetBackend;
  data: BudgetDataSource;
}
