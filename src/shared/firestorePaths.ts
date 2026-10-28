/** Firestore layout for Stage 1 (see docs/etap-1-mapowanie.md). */
export const COLLECTIONS = {
  users: 'users',
  userPreferences: 'user_preferences',
  budgets: 'budgets',
  memberships: 'memberships',
  accounts: 'accounts',
  invitations: 'invitations',
  invitationTokens: 'invitation_tokens',
  budgetPurgeQueue: 'budget_purge_queue',
  budgetRecords: 'budget_records',
} as const;

export const ACTIVE_MEMBERS_SUBCOLLECTION = 'active_members';

export function activeMembersPath(budgetId: string): string {
  return `${COLLECTIONS.budgets}/${budgetId}/${ACTIVE_MEMBERS_SUBCOLLECTION}`;
}

export function activeMemberPath(budgetId: string, userId: string): string {
  return `${activeMembersPath(budgetId)}/${userId}`;
}
