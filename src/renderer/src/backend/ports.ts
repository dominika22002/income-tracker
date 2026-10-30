import type {
  AccountView,
  AccountBalanceView,
  CategorizationRuleView,
  CategoryView,
  BudgetBackend,
  InvitationView,
  MemberView,
  MyBudgetView,
  SpendingLimitView,
  TransactionView,
  TransferGroupView,
  UserPreferencesRecord,
} from '../../../shared/contracts';
import type { BackupPayload } from '../../../shared/domain/backup';

export interface Session {
  uid: string;
  email: string | null;
  displayName: string | null;
}

/** Login provider boundary; the UI never handles passwords or tokens. */
export interface AuthGateway {
  subscribe(
    listener: (session: Session | null) => void,
    onError: ErrorListener,
  ): () => void;
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
  exportBudgetSnapshot(budgetId: string, userId: string): Promise<BackupPayload>;
  subscribeMyBudgets(
    uid: string,
    onData: (budgets: MyBudgetView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeAccounts(
    budgetId: string,
    ownerMembershipId: string,
    onData: (accounts: AccountView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeTransactions(
    budgetId: string,
    viewerMembershipId: string,
    onData: (transactions: TransactionView[]) => void,
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
  subscribeBudgetAccounts(
    budgetId: string,
    onData: (accounts: AccountView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeAccountBalances(
    budgetId: string,
    accountIds: readonly string[],
    onData: (balances: AccountBalanceView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeSpendingLimits(
    budgetId: string,
    onData: (limits: SpendingLimitView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeTransferGroups(
    budgetId: string,
    onData: (groups: TransferGroupView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeCategories(
    budgetId: string,
    onData: (categories: CategoryView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
  subscribeCategorizationRules(
    budgetId: string,
    onData: (rules: CategorizationRuleView[]) => void,
    onError: ErrorListener,
  ): Unsubscribe;
}

export interface AppServices {
  auth: AuthGateway;
  backend: BudgetBackend;
  data: BudgetDataSource;
}
