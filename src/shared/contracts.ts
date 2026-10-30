import type { BackupPayload, BackupRecord } from './domain/backup';

export interface IpcApi {
  ping(): Promise<{ ok: true; message: string }>;
  saveExportFile(request: SaveExportFileRequest): Promise<ExportFileResult>;
  saveReportPdf(request: SaveReportPdfRequest): Promise<ExportFileResult>;
  selectLocalFile(): Promise<{
    canceled: boolean;
    filePath?: string;
    error?: string;
  }>;
  readLocalStatement(
    request: ReadLocalStatementRequest,
  ): Promise<ReadLocalStatementResult>;
  saveBackupFile(request: SaveBackupFileRequest): Promise<ExportFileResult>;
  selectBackupFile(): Promise<SelectBackupFileResult>;
  archiveImportedStatement(
    request: ArchiveImportedStatementRequest,
  ): Promise<LocalStatementFileResult>;
  listLocalStatementFiles(
    budgetId: string,
  ): Promise<ListLocalStatementFilesResult>;
  restoreLocalStatementFiles(
    request: RestoreLocalStatementFilesRequest,
  ): Promise<RestoreLocalStatementFilesResult>;
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

export interface SaveExportFileRequest {
  fileName: string;
  format: 'CSV' | 'XLSX' | 'JSON';
  contentBase64: string;
}

export interface SaveReportPdfRequest {
  fileName: string;
  report: {
    period: { start: string; end: string };
    currency: string;
    income: string;
    expenses: string;
    cash_flow: string;
    hidden_transactions_included: boolean;
    expenses_by_category: Array<{ category_name: string; amount: string }>;
  };
}

export type ExportFileResult =
  | { status: 'saved'; filePath: string }
  | { status: 'canceled' }
  | { status: 'error'; error: string };

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

export interface SaveBackupFileRequest {
  fileName: string;
  content: string;
}

export type SelectBackupFileResult =
  | { status: 'selected'; content: string; fileName: string }
  | { status: 'canceled' }
  | { status: 'error'; error: string };

export interface ArchiveImportedStatementRequest {
  filePath: string;
  fileSha256: string;
  budgetId: string;
  importBatchId: string;
}

export interface BackupStatementFileRecord {
  import_batch_id: string;
  file_name: string;
  content_type: 'text/csv' | 'application/pdf';
  sha256: string;
  content_base64: string;
}

export type LocalStatementFileResult =
  | { status: 'saved'; filePath: string }
  | { status: 'error'; error: string };

export type ListLocalStatementFilesResult =
  | { status: 'loaded'; files: BackupStatementFileRecord[] }
  | { status: 'error'; error: string };

export type RestoreLocalStatementFilesResult =
  | { status: 'saved'; count: number }
  | { status: 'error'; error: string };

export interface RestoreLocalStatementFilesRequest {
  budgetId: string;
  files: BackupStatementFileRecord[];
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
  active_revision_id?: string | null;
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
  fee?: string | null;
  type: StatementTransactionType;
  category_id: string | null;
  category_name: string | null;
  note: string | null;
  tags: string[];
  expense_frequency?: ExpenseFrequency | null;
  hidden_mode?: HiddenMode | null;
  hidden_until?: string | null;
  hidden_by_membership_id?: string | null;
  hidden_for_viewer?: boolean;
  split_items?: SplitItemView[];
  transfer_group_id?: string | null;
  transfer_leg?: 'OUTGOING' | 'INCOMING' | null;
}

export interface AccountBalanceView {
  snapshot_id: string;
  account_id: string;
  balance_date: string;
  balance_amount: string;
  currency: string;
  source: 'STATEMENT' | 'MANUAL';
}

export interface TransferGroupView {
  transfer_group_id: string;
  budget_id: string;
  status: 'CANDIDATE' | 'CONFIRMED' | 'CONFIRMED_UNPAIRED' | 'REJECTED';
  outgoing_transaction_id: string | null;
  incoming_transaction_id: string | null;
  transaction_id: string | null;
}

export interface TransactionConversionView {
  transaction_id: string;
  target_currency: string;
  exchange_rate_id: string | null;
  rate_used: string;
  rate_date: string;
  converted_amount: string;
  display_amount: string;
  calculated_at: string;
}

export type ExpenseFrequency = 'RECURRING' | 'IRREGULAR' | 'ONE_TIME';
export type ExpenseNature = 'FIXED' | 'VARIABLE' | 'DISCRETIONARY';
export type HiddenMode = 'DESCRIPTION' | 'TRANSACTION';
export type SpendingLimitScope =
  'CATEGORY' | 'ALL_EXPENSES' | 'ONE_TIME_EXPENSES';
export type SpendingLimitPeriod = 'MONTH';

export interface SpendingLimitView {
  spending_limit_id: string;
  budget_id: string;
  limit_scope: SpendingLimitScope;
  category_id: string | null;
  period: SpendingLimitPeriod;
  limit_amount: string;
  currency: string;
}

export interface SaveSpendingLimitRequest {
  budget_id: string;
  limit_scope: SpendingLimitScope;
  category_id?: string | null;
  period: SpendingLimitPeriod;
  limit_amount: string;
  currency: string;
}

export interface SplitItemInput {
  amount: string;
  category_id: string;
  expense_frequency: ExpenseFrequency | null;
  description: string | null;
  note: string | null;
}

export interface SplitItemView extends Omit<SplitItemInput, 'category_id'> {
  split_item_id: string;
  budget_id: string;
  transaction_id: string;
  category_id: string | null;
  position: number;
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
  expense_nature: ExpenseNature | null;
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
  | 'DUPLICATE_REVIEW_REQUIRED'
  | 'EXCHANGE_RATE_UNAVAILABLE';

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

export interface SaveAccountBalanceRequest {
  budget_id: string;
  account_id: string;
  balance_date: string;
  balance_amount: string;
  currency: string;
}

export interface SaveAccountBalanceResult {
  snapshot_id: string;
}

export interface GetTransactionConversionsRequest {
  budget_id: string;
  transaction_id: string;
  target_currency?: string;
}

export interface GetTransactionConversionsResult {
  conversions: TransactionConversionView[];
  unavailable_currencies: string[];
}

export interface ReviewTransferRequest {
  budget_id: string;
  decision: 'CONFIRM_PAIR' | 'REJECT' | 'CONFIRM_UNPAIRED';
  outgoing_transaction_id?: string;
  incoming_transaction_id?: string;
  transaction_id?: string;
}

export interface ReviewTransferResult {
  transfer_group_id: string;
  status: TransferGroupView['status'];
}

export interface SaveTransactionRequest {
  budget_id: string;
  account_id: string;
  operation_date: string;
  description: string;
  amount: string;
  currency: string;
  type: StatementTransactionType;
  expense_frequency?: ExpenseFrequency | null;
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

export interface SaveTransactionSplitRequest {
  budget_id: string;
  transaction_id: string;
  items: SplitItemInput[];
}

export interface DeleteTransactionSplitRequest {
  budget_id: string;
  transaction_id: string;
}

export interface SetTransactionHiddenRequest {
  budget_id: string;
  transaction_id: string;
  hidden_mode: HiddenMode;
  hidden_until: string | null;
}

export interface SaveCategoryRequest {
  budget_id: string;
  category_id?: string;
  parent_category_id?: string | null;
  name: string;
  kind: CategoryKind;
  expense_nature?: ExpenseNature | null;
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
  saveAccountBalance(
    request: SaveAccountBalanceRequest,
  ): Promise<SaveAccountBalanceResult>;
  saveSpendingLimit(request: SaveSpendingLimitRequest): Promise<void>;
  getTransactionConversions(
    request: GetTransactionConversionsRequest,
  ): Promise<GetTransactionConversionsResult>;
  reviewTransfer(request: ReviewTransferRequest): Promise<ReviewTransferResult>;
  saveTransaction(
    request: SaveTransactionRequest,
  ): Promise<SaveTransactionResult>;
  saveTransactionSplit(request: SaveTransactionSplitRequest): Promise<void>;
  deleteTransactionSplit(request: DeleteTransactionSplitRequest): Promise<void>;
  setTransactionHidden(request: SetTransactionHiddenRequest): Promise<void>;
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
  exportBudgetBackup(request: ExportBudgetBackupRequest): Promise<BackupPayload>;
  beginBudgetRestore(request: BeginBudgetRestoreRequest): Promise<BeginBudgetRestoreResult>;
  writeBudgetRestoreChunk(request: WriteBudgetRestoreChunkRequest): Promise<void>;
  commitBudgetRestore(request: CommitBudgetRestoreRequest): Promise<void>;
}

export interface MyBudgetView {
  budget_id: string;
  name: string;
  membership_id: string;
  role: MembershipRole;
  active_revision_id?: string | null;
}

export interface ExportBudgetBackupRequest {
  budget_id: string;
}

export interface BeginBudgetRestoreRequest {
  budget_id: string;
  expected_revision_id: string | null;
  document_counts: Record<string, number>;
  source_memberships: BackupRecord[];
  currency_settings: BackupPayload['currency_settings'];
  apply_currency_settings: boolean;
}

export interface BeginBudgetRestoreResult {
  restore_id: string;
  revision_id: string;
  membership_mapping: Record<string, string>;
}

export interface RestoreDocument {
  collection: string;
  document_id: string;
  data: Record<string, unknown>;
}

export interface WriteBudgetRestoreChunkRequest {
  restore_id: string;
  chunk_id: string;
  documents: RestoreDocument[];
}

export interface CommitBudgetRestoreRequest {
  restore_id: string;
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
