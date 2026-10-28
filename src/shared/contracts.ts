export interface IpcApi {
  ping(): Promise<{ ok: true; message: string }>;
  selectLocalFile(): Promise<{
    canceled: boolean;
    filePath?: string;
    error?: string;
  }>;
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

// ---------------------------------------------------------------------------
// Stage 1: budget access model (see docs/etap-1-mapowanie.md)
// ---------------------------------------------------------------------------

export type MembershipRole = 'ADMIN' | 'MEMBER';
export type MembershipStatus = 'ACTIVE' | 'LEFT' | 'REMOVED';
export type InvitationStatus =
  'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';

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
  | 'BUDGET_HAS_ACTIVE_MEMBERS';

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
