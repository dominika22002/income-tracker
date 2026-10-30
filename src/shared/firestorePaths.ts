/** Firestore layout for Stage 1 (see docs/etap-1-mapowanie.md). */
export const COLLECTIONS = {
  users: 'users',
  userPreferences: 'user_preferences',
  budgets: 'budgets',
  memberships: 'memberships',
  importBatches: 'import_batches',
  importProfiles: 'import_profiles',
  importPeriods: 'import_periods',
  importBatchFileHashes: 'import_batch_file_hashes',
  accounts: 'accounts',
  categories: 'categories',
  categorizationRules: 'categorization_rules',
  tags: 'tags',
  transactionTags: 'transaction_tags',
  transactions: 'transactions',
  splitItems: 'split_items',
  transferGroups: 'transfer_groups',
  spendingLimits: 'spending_limits',
  accountBalanceSnapshots: 'account_balance_snapshots',
  exchangeRates: 'exchange_rates',
  exchangeRateLookups: 'exchange_rate_lookups',
  transactionConversions: 'transaction_conversions',
  invitations: 'invitations',
  invitationTokens: 'invitation_tokens',
  budgetPurgeQueue: 'budget_purge_queue',
  budgetRecords: 'budget_records',
  restoreSessions: 'budget_restore_sessions',
} as const;

export const ACTIVE_MEMBERS_SUBCOLLECTION = 'active_members';
export const BUDGET_REVISIONS_SUBCOLLECTION = 'revisions';

export const BACKUP_COLLECTIONS = [
  COLLECTIONS.accounts,
  COLLECTIONS.importBatches,
  COLLECTIONS.importProfiles,
  COLLECTIONS.importPeriods,
  COLLECTIONS.categories,
  COLLECTIONS.categorizationRules,
  COLLECTIONS.transferGroups,
  COLLECTIONS.transactions,
  COLLECTIONS.splitItems,
  COLLECTIONS.spendingLimits,
  COLLECTIONS.accountBalanceSnapshots,
  COLLECTIONS.exchangeRates,
  COLLECTIONS.transactionConversions,
  COLLECTIONS.tags,
  COLLECTIONS.transactionTags,
] as const;

export function activeMembersPath(budgetId: string): string {
  return `${COLLECTIONS.budgets}/${budgetId}/${ACTIVE_MEMBERS_SUBCOLLECTION}`;
}

export function activeMemberPath(budgetId: string, userId: string): string {
  return `${activeMembersPath(budgetId)}/${userId}`;
}

export function budgetRevisionPath(
  budgetId: string,
  revisionId: string,
): string {
  return `${COLLECTIONS.budgets}/${budgetId}/${BUDGET_REVISIONS_SUBCOLLECTION}/${revisionId}`;
}

export function budgetCollectionPath(
  budgetId: string,
  revisionId: string | null,
  collection: string,
): string {
  return revisionId
    ? `${budgetRevisionPath(budgetId, revisionId)}/${collection}`
    : collection;
}

export function budgetDocumentPath(
  budgetId: string,
  revisionId: string | null,
  collection: string,
  documentId: string,
): string {
  return `${budgetCollectionPath(budgetId, revisionId, collection)}/${documentId}`;
}
