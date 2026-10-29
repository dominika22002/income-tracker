export interface IpcApi {
  ping(): Promise<{ ok: true; message: string }>;
  selectLocalFile(): Promise<{
    canceled: boolean;
    filePath?: string;
    error?: string;
  }>;
  readLocalStatement(
    request: ReadLocalStatementRequest,
  ): Promise<ReadLocalStatementResult>;
  writeTestFile(content: string): Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  startGoogleOAuth(): Promise<{
    launched: boolean;
    state?: string;
    error?: string;
  }>;
  onOAuthCallback(
    listener: (payload: OAuthCallbackPayload) => void,
  ): () => void;
}

export interface OAuthCallbackPayload {
  ok: boolean;
  state?: string;
  code?: string;
  error?: string;
}

export interface WriteTestFileRequest {
  content: string;
}

export interface ReadLocalStatementRequest {
  filePath: string;
  maxBytes?: number;
}

export interface ReadLocalStatementResult {
  success: boolean;
  filePath?: string;
  fileName?: string;
  extension?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  fileSha256?: string;
  contentBase64?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Stage 1: budget access model (see docs/etap-1-mapowanie.md)
// ---------------------------------------------------------------------------

export type MembershipRole = 'ADMIN' | 'MEMBER';
export type MembershipStatus = 'ACTIVE' | 'LEFT' | 'REMOVED';
export type InvitationStatus =
  'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
export type AccountType = 'CHECKING' | 'SAVINGS' | 'CASH' | 'OTHER';

export interface UserRecord {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: Date;
}

export interface UserPreferencesRecord {
  user_id: string;
  primary_currency: string;
  secondary_currencies: string[];
}

export interface BudgetRecord {
  budget_id: string;
  name: string;
  created_at: Date;
  created_by_user_id: string | null;
}

export interface MembershipRecord {
  membership_id: string;
  budget_id: string;
  user_id: string | null;
  role: MembershipRole;
  status: MembershipStatus;
  joined_at: Date;
  ended_at: Date | null;
}

export interface InvitationRecord {
  invitation_id: string;
  budget_id: string;
  invited_by_membership_id: string;
  invitee_email: string | null;
  token_hash: string;
  status: InvitationStatus;
  created_at: Date;
  expires_at: Date;
}

export interface AccountRecord {
  account_id: string;
  budget_id: string;
  owner_membership_id: string;
  label: string;
  institution_name: string | null;
  currency: string;
  account_type: AccountType;
  created_at: Date;
  archived_at: Date | null;
}

export interface AccountView {
  account_id: string;
  budget_id: string;
  owner_membership_id: string;
  label: string;
  currency: string;
  account_type: AccountType;
  archived_at: string | null;
}

export interface TransactionView {
  transaction_id: string;
  budget_id: string;
  account_id: string;
  account_label: string | null;
  account_owner_membership_id: string | null;
  import_batch_id: string | null;
  imported_by_membership_id: string | null;
  bank_transaction_id: string | null;
  operation_date: string;
  description: string;
  amount: string;
  currency: string;
  type: StatementTransactionType;
  category_id: string | null;
  category_name: string | null;
  note: string | null;
  tags: string[];
}

export type CategoryKind = StatementTransactionType;
export type CategorizationMatchField = 'DESCRIPTION' | 'ACCOUNT' | 'AMOUNT';
export type CategorizationMatchOperator = 'CONTAINS' | 'EQUALS' | 'STARTS_WITH';

export interface CategoryView {
  category_id: string;
  budget_id: string;
  parent_category_id: string | null;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  archived_at: string | null;
}

export interface CategorizationRuleView {
  rule_id: string;
  budget_id: string;
  category_id: string;
  category_name: string;
  source: 'USER' | 'LEARNED';
  match_field: CategorizationMatchField;
  operator: CategorizationMatchOperator;
  match_value: string;
  priority: number;
  enabled: boolean;
}

export type DomainErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_ACTIVE_MEMBER'
  | 'ALREADY_MEMBER'
  | 'NOT_ADMIN'
  | 'CANNOT_REMOVE_SELF'
  | 'INVALID_TRANSITION'
  | 'INVITATION_NOT_PENDING'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_EMAIL_MISMATCH'
  | 'BUDGET_HAS_ACTIVE_MEMBERS'
  | 'DUPLICATE_REVIEW_REQUIRED';

export interface CreateBudgetRequest {
  name: string;
  budget_id?: string;
}

export interface CreateBudgetResult {
  budget_id: string;
  membership_id: string;
}

export interface CreateInvitationRequest {
  budget_id: string;
  invitee_email?: string;
  invitation_id?: string;
}

export interface CreateInvitationResult {
  invitation_id: string;
  token: string;
  link: string;
  expires_at: string;
}

export interface InvitationPreview {
  invitation_id: string;
  budget_id: string;
  budget_name: string | null;
  status: InvitationStatus;
  expires_at: string;
  restricted_to_email: boolean;
}

export interface JoinBudgetResult {
  budget_id: string;
  membership_id: string;
}

export interface RemoveMemberRequest {
  budget_id: string;
  membership_id: string;
}

export interface CreateAccountRequest {
  budget_id: string;
  label: string;
  currency: string;
  account_type: AccountType;
  owner_membership_id?: string;
  institution_name?: string;
  account_id?: string;
}

export interface CreateAccountResult {
  account_id: string;
}

export interface SaveTransactionRequest {
  budget_id: string;
  account_id: string;
  operation_date: string;
  description: string;
  amount: string;
  currency: string;
  type: StatementTransactionType;
  category_id?: string | null;
  note?: string | null;
  tags?: string[];
  transaction_id?: string;
  create_rule?: {
    match_field: CategorizationMatchField;
    operator: CategorizationMatchOperator;
    match_value: string;
    priority: number;
  };
}

export interface SaveTransactionResult {
  transaction_id: string;
}

export interface SaveCategoryRequest {
  budget_id: string;
  category_id?: string;
  parent_category_id?: string | null;
  name: string;
  kind: CategoryKind;
  sort_order: number;
}

export interface SaveCategoryResult {
  category_id: string;
}

export interface ArchiveCategoryRequest {
  budget_id: string;
  category_id: string;
}

export interface SaveCategorizationRuleRequest {
  budget_id: string;
  category_id: string;
  match_field: CategorizationMatchField;
  operator: CategorizationMatchOperator;
  match_value: string;
  priority: number;
  enabled?: boolean;
  rule_id?: string;
}

export interface SaveCategorizationRuleResult {
  rule_id: string;
}

export type StatementImportFormat = 'CSV' | 'PDF';
export type StatementImportRowDecision = 'include' | 'exclude' | 'pending';
export type StatementTransactionType = 'EXPENSE' | 'INCOME' | 'TRANSFER';

export interface StatementImportRowRequest {
  row_number: number;
  decision: StatementImportRowDecision;
  operation_date?: string;
  description?: string;
  amount?: string;
  currency?: string;
  transaction_type?: StatementTransactionType;
  fee?: string | null;
  bank_transaction_id?: string | null;
  source_status?: string | null;
  balance?: string | null;
  balance_currency?: string | null;
  possible_duplicate_decision?: 'confirm' | 'exclude' | 'pending';
}

export interface CommitCsvImportRequest {
  budget_id: string;
  account_id: string;
  file_sha256: string;
  parser_id: string;
  parser_version: string;
  rows: StatementImportRowRequest[];
}

export interface ImportPeriodView {
  period_start: string;
  period_end: string;
}

export interface CommitCsvImportResult {
  import_batch_id: string;
  imported_row_count: number;
  skipped_duplicate_row_numbers: number[];
  periods: ImportPeriodView[];
  already_imported: boolean;
}

export interface DeleteProfileResult {
  deleted_budget_ids: string[];
  cleanup_pending_budget_ids: string[];
}

/** Operations that only trusted server code may perform (callable functions). */
export interface BudgetBackend {
  ensureUserProfile(): Promise<UserPreferencesRecord>;
  updatePreferences(
    request: UpdatePreferencesRequest,
  ): Promise<UserPreferencesRecord>;
  createBudget(request: CreateBudgetRequest): Promise<CreateBudgetResult>;
  createAccount(request: CreateAccountRequest): Promise<CreateAccountResult>;
  saveTransaction(
    request: SaveTransactionRequest,
  ): Promise<SaveTransactionResult>;
  saveCategory(request: SaveCategoryRequest): Promise<SaveCategoryResult>;
  archiveCategory(request: ArchiveCategoryRequest): Promise<void>;
  saveCategorizationRule(
    request: SaveCategorizationRuleRequest,
  ): Promise<SaveCategorizationRuleResult>;
  commitCsvImport(
    request: CommitCsvImportRequest,
  ): Promise<CommitCsvImportResult>;
  createInvitation(
    request: CreateInvitationRequest,
  ): Promise<CreateInvitationResult>;
  previewInvitation(token: string): Promise<InvitationPreview>;
  acceptInvitation(token: string): Promise<JoinBudgetResult>;
  declineInvitation(token: string): Promise<void>;
  cancelInvitation(invitationId: string): Promise<void>;
  leaveBudget(budgetId: string): Promise<LeaveBudgetResult>;
  removeMember(request: RemoveMemberRequest): Promise<void>;
  deleteMyProfile(): Promise<DeleteProfileResult>;
}

export interface MyBudgetView {
  budget_id: string;
  name: string;
  membership_id: string;
  role: MembershipRole;
}

export interface MemberView {
  user_id: string;
  membership_id: string;
  role: MembershipRole;
  joined_at: string;
  display_name: string | null;
  email: string | null;
}

export interface InvitationView {
  invitation_id: string;
  status: InvitationStatus;
  invitee_email: string | null;
  created_at: string;
  expires_at: string;
}

export interface LeaveBudgetResult {
  /** True when the caller was the last active member and the budget was deleted. */
  budget_deleted: boolean;
  /** True when deleting the remaining budget data still has to be completed. */
  cleanup_pending: boolean;
}

export interface UpdatePreferencesRequest {
  primary_currency: string;
  secondary_currencies: string[];
}
