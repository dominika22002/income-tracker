/** Firestore layout for Stage 1 (see docs/etap-1-mapowanie.md). */
export const COLLECTIONS = {
  users: 'users',
  userPreferences: 'user_preferences',
  budgets: 'budgets',
  memberships: 'memberships',
  accounts: 'accounts',
  categories: 'categories',
  categorizationRules: 'categorization_rules',
  tags: 'tags',
  transactionTags: 'transaction_tags',
  transactions: 'transactions',
  splitItems: 'split_items',
  transferGroups: 'transfer_groups',
  accountBalanceSnapshots: 'account_balance_snapshots',
  exchangeRates: 'exchange_rates',
  exchangeRateLookups: 'exchange_rate_lookups',
  transactionConversions: 'transaction_conversions',
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
