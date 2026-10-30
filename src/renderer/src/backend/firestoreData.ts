import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  Timestamp,
  type CollectionReference,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import {
  BACKUP_COLLECTIONS,
  COLLECTIONS,
  budgetCollectionPath,
  budgetDocumentPath,
} from '../../../shared/firestorePaths';
import type { BackupPayload, BackupRecord } from '../../../shared/domain/backup';
import type {
  AccountView,
  AccountBalanceView,
  CategorizationRuleView,
  CategoryView,
  InvitationView,
  MemberView,
  MyBudgetView,
  SpendingLimitView,
  TransactionView,
  TransferGroupView,
  UserPreferencesRecord,
} from '../../../shared/contracts';
import { compareMembersForSuccession } from '../../../shared/domain/membership';
import {
  maskTransactionsForMember,
  nextHiddenExpiry,
} from '../../../shared/domain/transactionFeatures';
import type { BudgetDataSource } from './ports';

function iso(value: unknown): string {
  return (value as Timestamp).toDate().toISOString();
}

function serializable(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return { __incomeTrackerTimestamp: value.toDate().toISOString() };
  }
  if (value instanceof Date) {
    return { __incomeTrackerTimestamp: value.toISOString() };
  }
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, serializable(nested)]),
    );
  }
  return value;
}

function backupRecords(
  documents: QueryDocumentSnapshot[],
): BackupRecord[] {
  return documents.map((document) => ({
    document_id: document.id,
    data: serializable(document.data()) as Record<string, unknown>,
  }));
}

async function documentsByValues(
  db: Firestore,
  path: string,
  field: string,
  values: string[],
): Promise<QueryDocumentSnapshot[]> {
  const snapshots = await Promise.all(
    Array.from({ length: Math.ceil(values.length / 30) }, (_, index) =>
      getDocs(
        query(
          collection(db, path),
          where(field, 'in', values.slice(index * 30, (index + 1) * 30)),
        ),
      ),
    ),
  );
  return snapshots.flatMap((snapshot) => snapshot.docs);
}

function subscribeBudgetCollection<T>(
  db: Firestore,
  budgetId: string,
  collectionName: string,
  createQuery: (source: CollectionReference) => Query,
  onData: (snapshot: T, revisionId: string | null) => void,
  onError: (error: Error) => void,
): () => void {
  let activeRevisionId: string | null | undefined;
  let unsubscribeRecords: (() => void) | undefined;
  const unsubscribeBudget = onSnapshot(
    doc(db, 'budgets', budgetId),
    (budget) => {
      if (!budget.exists()) {
        onError(new Error('The selected budget no longer exists.'));
        return;
      }
      const revisionId =
        (budget.get('active_revision_id') as string | null | undefined) ?? null;
      if (revisionId === activeRevisionId) return;
      activeRevisionId = revisionId;
      unsubscribeRecords?.();
      unsubscribeRecords = onSnapshot(
        createQuery(
          collection(
            db,
            budgetCollectionPath(budgetId, revisionId, collectionName),
          ),
        ),
        (snapshot) => onData(snapshot as T, revisionId),
        onError,
      );
    },
    onError,
  );
  return () => {
    unsubscribeRecords?.();
    unsubscribeBudget();
  };
}

export function createFirestoreDataSource(db: Firestore): BudgetDataSource {
  return {
    async exportBudgetSnapshot(budgetId, userId): Promise<BackupPayload> {
      const budgetRef = doc(db, 'budgets', budgetId);
      const budget = await getDoc(budgetRef);
      if (!budget.exists()) {
        throw new Error('The selected budget no longer exists.');
      }
      const revisionId =
        (budget.get('active_revision_id') as string | null | undefined) ?? null;
      const paths = Object.fromEntries(
        BACKUP_COLLECTIONS.map((name) => [
          name,
          budgetCollectionPath(budgetId, revisionId, name),
        ]),
      ) as Record<(typeof BACKUP_COLLECTIONS)[number], string>;

      const scoped = await Promise.all(
        BACKUP_COLLECTIONS.map(async (name) => {
          if (
            name === COLLECTIONS.exchangeRates ||
            name === COLLECTIONS.transactionConversions ||
            name === COLLECTIONS.transactionTags ||
            name === COLLECTIONS.accountBalanceSnapshots
          ) {
            return [name, []] as const;
          }
          const result = await getDocs(
            query(
              collection(db, paths[name]),
              where('budget_id', '==', budgetId),
            ),
          );
          return [name, backupRecords(result.docs)] as const;
        }),
      );
      const datasets = Object.fromEntries(scoped) as BackupPayload['datasets'];
      const transactionIds = datasets.transactions.map(
        (record) => record.document_id,
      );
      const accountIds = datasets.accounts.map((record) => record.document_id);
      const [tagLinks, conversions, balances] = await Promise.all([
        documentsByValues(
          db,
          paths[COLLECTIONS.transactionTags],
          'transaction_id',
          transactionIds,
        ),
        documentsByValues(
          db,
          paths[COLLECTIONS.transactionConversions],
          'transaction_id',
          transactionIds,
        ),
        documentsByValues(
          db,
          paths[COLLECTIONS.accountBalanceSnapshots],
          'account_id',
          accountIds,
        ),
      ]);
      datasets.transaction_tags = backupRecords(tagLinks);
      datasets.transaction_conversions = backupRecords(conversions);
      datasets.account_balance_snapshots = backupRecords(balances);

      const nestedRates =
        revisionId === null
          ? []
          : backupRecords(
              (
                await getDocs(
                  collection(db, paths[COLLECTIONS.exchangeRates]),
                )
              ).docs,
            );
      const referencedRateIds = [
        ...datasets.transaction_conversions.map(
          (record) => record.data.exchange_rate_id,
        ),
        ...datasets.transfer_groups.map((record) => record.data.fx_rate_id),
      ].filter((value): value is string => typeof value === 'string');
      const presentRateIds = new Set(
        nestedRates.map((record) => record.document_id),
      );
      const legacyRates =
        revisionId === null
          ? await Promise.all(
              [...new Set(referencedRateIds)]
                .filter((id) => !presentRateIds.has(id))
                .map(async (id) => {
                  const rate = await getDoc(
                    doc(db, COLLECTIONS.exchangeRates, id),
                  );
                  return rate.exists()
                    ? {
                        document_id: rate.id,
                        data: serializable(
                          rate.data(),
                        ) as Record<string, unknown>,
                      }
                    : null;
                }),
            )
          : [];
      datasets.exchange_rates = [
        ...nestedRates,
        ...legacyRates.filter(
          (record): record is BackupRecord => record !== null,
        ),
      ];

      const [liveMemberships, revisionMemberships, preferences] =
        await Promise.all([
          getDocs(
            query(
              collection(db, COLLECTIONS.memberships),
              where('budget_id', '==', budgetId),
            ),
          ),
          revisionId === null
            ? Promise.resolve(null)
            : getDocs(
                collection(
                  db,
                  `${budgetCollectionPath(
                    budgetId,
                    revisionId,
                    'membership_history',
                  )}`,
                ),
              ),
          getDoc(doc(db, COLLECTIONS.userPreferences, userId)),
        ]);
      const membershipsById = new Map(
        (revisionMemberships?.docs ?? []).map((document) => [
          document.id,
          {
            document_id: document.id,
            data: serializable(document.data()) as Record<string, unknown>,
          },
        ]),
      );
      liveMemberships.docs.forEach((document) =>
        membershipsById.set(document.id, {
          document_id: document.id,
          data: serializable(document.data()) as Record<string, unknown>,
        }),
      );
      const currentBudget = await getDoc(budgetRef);
      if (
        !currentBudget.exists() ||
        ((currentBudget.get('active_revision_id') as string | null | undefined) ??
          null) !== revisionId
      ) {
        throw new Error(
          'The budget changed while the backup was being read. Retry the backup.',
        );
      }
      return {
        format: 'income-tracker-backup',
        schema_version: 2,
        created_at: new Date().toISOString(),
        source_budget: {
          budget_id: budgetId,
          name: budget.get('name') as string,
        },
        datasets,
        membership_history: [...membershipsById.values()],
        currency_settings: preferences.exists()
          ? {
              primary_currency: preferences.get(
                'primary_currency',
              ) as string,
              secondary_currencies: preferences.get(
                'secondary_currencies',
              ) as string[],
            }
          : null,
        statement_files: [],
      };
    },

    subscribeMyBudgets(uid, onData, onError) {
      let active = true;
      const unsubscribe = onSnapshot(
        query(
          collection(db, 'memberships'),
          where('user_id', '==', uid),
          where('status', '==', 'ACTIVE'),
        ),
        (snapshot) => {
          void Promise.all(
            snapshot.docs.map(
              async (membership): Promise<MyBudgetView | null> => {
                try {
                  const budget = await getDoc(
                    doc(db, 'budgets', membership.get('budget_id') as string),
                  );
                  if (!budget.exists()) return null;
                  return {
                    budget_id: budget.id,
                    name: budget.get('name') as string,
                    membership_id: membership.id,
                    role: membership.get('role') as MyBudgetView['role'],
                    active_revision_id:
                      (budget.get('active_revision_id') as
                        | string
                        | null
                        | undefined) ?? null,
                  };
                } catch {
                  // Access was revoked between the two reads.
                  return null;
                }
              },
            ),
          ).then((budgets) => {
            if (!active) return;
            onData(
              budgets
                .filter((budget): budget is MyBudgetView => budget !== null)
                .sort((a, b) => a.name.localeCompare(b.name)),
            );
          });
        },
        onError,
      );
      return () => {
        active = false;
        unsubscribe();
      };
    },

    subscribeAccounts(budgetId, ownerMembershipId, onData, onError) {
      return subscribeBudgetCollection(
        db,
        budgetId,
        'accounts',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot: QuerySnapshot) => {
          const accounts: AccountView[] = snapshot.docs
            .filter(
              (account) =>
                account.get('owner_membership_id') === ownerMembershipId &&
                account.get('archived_at') == null,
            )
            .map((account) => ({
              account_id: account.id,
              budget_id: account.get('budget_id') as string,
              owner_membership_id: account.get('owner_membership_id') as string,
              label: account.get('label') as string,
              currency: account.get('currency') as string,
              account_type: account.get(
                'account_type',
              ) as AccountView['account_type'],
              archived_at: null,
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
          onData(accounts);
        },
        onError,
      );
    },

    subscribeTransactions(budgetId, viewerMembershipId, onData, onError) {
      let active = true;
      let revision = 0;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      let latestTransactions: TransactionView[] = [];
      const publishForViewer = () => {
        if (!active) return;
        const now = new Date();
        onData(
          maskTransactionsForMember(
            latestTransactions,
            viewerMembershipId,
            now,
          ),
        );
        if (expiryTimer) clearTimeout(expiryTimer);
        const nextExpiry = nextHiddenExpiry(
          latestTransactions,
          viewerMembershipId,
          now,
        );
        if (nextExpiry !== null) {
          expiryTimer = setTimeout(
            publishForViewer,
            Math.min(nextExpiry - now.getTime(), 2_147_000_000),
          );
        }
      };
      const unsubscribe = subscribeBudgetCollection<QuerySnapshot>(
        db,
        budgetId,
        'transactions',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot, activeRevisionId) => {
          const currentRevision = ++revision;
          const accountIds = [
            ...new Set(
              snapshot.docs.map(
                (transaction) => transaction.get('account_id') as string,
              ),
            ),
          ];
          const categoryIds = [
            ...new Set(
              snapshot.docs.flatMap((transaction) => {
                const categoryId =
                  (transaction.get('category_id') as string | null) ?? null;
                return categoryId ? [categoryId] : [];
              }),
            ),
          ];
          const importIds = [
            ...new Set(
              snapshot.docs
                .map(
                  (transaction) =>
                    transaction.get('import_batch_id') as string | null,
                )
                .filter((importId): importId is string => Boolean(importId)),
            ),
          ];
          void Promise.all([
            Promise.all(
              accountIds.map(async (accountId) => {
                const account = await getDoc(
                  doc(
                    db,
                    budgetDocumentPath(
                      budgetId,
                      activeRevisionId,
                      'accounts',
                      accountId,
                    ),
                  ),
                );
                return [
                  accountId,
                  account.exists() && account.get('budget_id') === budgetId
                    ? {
                        label: account.get('label') as string,
                        owner: account.get('owner_membership_id') as string,
                      }
                    : null,
                ] as const;
              }),
            ),
            getDocs(
              query(
                collection(
                  db,
                  budgetCollectionPath(
                    budgetId,
                    activeRevisionId,
                    'categories',
                  ),
                ),
                where('budget_id', '==', budgetId),
              ),
            ).then((categorySnapshot) => {
              const names = new Map(
                categorySnapshot.docs.map(
                  (category) =>
                    [category.id, category.get('name') as string] as const,
                ),
              );
              return categoryIds.map(
                (categoryId) =>
                  [categoryId, names.get(categoryId) ?? null] as const,
              );
            }),
            Promise.all(
              importIds.map(async (importId) => {
                const batch = await getDoc(
                  doc(
                    db,
                    budgetDocumentPath(
                      budgetId,
                      activeRevisionId,
                      'import_batches',
                      importId,
                    ),
                  ),
                );
                return [
                  importId,
                  batch.exists() && batch.get('budget_id') === budgetId
                    ? (batch.get('imported_by_membership_id') as string)
                    : null,
                ] as const;
              }),
            ),
            Promise.all(
              snapshot.docs.map(async (transaction) => {
                const links = await getDocs(
                  query(
                    collection(
                      db,
                      budgetCollectionPath(
                        budgetId,
                        activeRevisionId,
                        'transaction_tags',
                      ),
                    ),
                    where('transaction_id', '==', transaction.id),
                  ),
                );
                const tagIds = links.docs.map(
                  (link) => link.get('tag_id') as string,
                );
                const tags = await Promise.all(
                  tagIds.map((tagId) =>
                    getDoc(
                      doc(
                        db,
                        budgetDocumentPath(
                          budgetId,
                          activeRevisionId,
                          'tags',
                          tagId,
                        ),
                      ),
                    ),
                  ),
                );
                return [
                  transaction.id,
                  tags
                    .filter(
                      (tag) =>
                        tag.exists() && tag.get('budget_id') === budgetId,
                    )
                    .map((tag) => tag.get('name') as string)
                    .sort((a, b) => a.localeCompare(b, 'pl')),
                ] as const;
              }),
            ),
            getDocs(
              query(
                collection(
                  db,
                  budgetCollectionPath(
                    budgetId,
                    activeRevisionId,
                    'split_items',
                  ),
                ),
                where('budget_id', '==', budgetId),
              ),
            ),
          ])
            .then(
              ([
                accountEntries,
                categoryEntries,
                importEntries,
                tagEntries,
                splitItemSnapshot,
              ]) => {
                if (!active || currentRevision !== revision) return;
                const accounts = new Map(accountEntries);
                const categories = new Map(categoryEntries);
                const importers = new Map(importEntries);
                const tagsByTransaction = new Map(tagEntries);
                const splitItemsByTransaction = new Map<
                  string,
                  TransactionView['split_items']
                >();
                for (const item of splitItemSnapshot.docs) {
                  const transactionId = item.get('transaction_id') as string;
                  const splitItems =
                    splitItemsByTransaction.get(transactionId) ?? [];
                  splitItems.push({
                    split_item_id: item.id,
                    budget_id: item.get('budget_id') as string,
                    transaction_id: transactionId,
                    category_id: item.get('category_id') as string,
                    amount: item.get('amount') as string,
                    expense_frequency:
                      (item.get('expense_frequency') as
                        TransactionView['expense_frequency'] | undefined) ??
                      null,
                    description:
                      (item.get('description') as string | null) ?? null,
                    note: (item.get('note') as string | null) ?? null,
                    position: item.get('position') as number,
                  });
                  splitItemsByTransaction.set(transactionId, splitItems);
                }
                latestTransactions = snapshot.docs
                  .map((transaction) => {
                    const accountId = transaction.get('account_id') as string;
                    const categoryId =
                      (transaction.get('category_id') as string | null) ?? null;
                    const importId =
                      (transaction.get('import_batch_id') as string | null) ??
                      null;
                    return {
                      transaction_id: transaction.id,
                      budget_id: transaction.get('budget_id') as string,
                      account_id: accountId,
                      account_label: accounts.get(accountId)?.label ?? null,
                      account_owner_membership_id:
                        accounts.get(accountId)?.owner ?? null,
                      import_batch_id: importId,
                      imported_by_membership_id: importId
                        ? (importers.get(importId) ?? null)
                        : null,
                      bank_transaction_id:
                        (transaction.get('bank_transaction_id') as
                          string | null) ?? null,
                      operation_date: transaction.get(
                        'operation_date',
                      ) as string,
                      description: transaction.get('description') as string,
                      amount: transaction.get('amount') as string,
                      currency: transaction.get('currency') as string,
                      fee: (transaction.get('fee') as string | null) ?? null,
                      type: transaction.get('type') as TransactionView['type'],
                      category_id: categoryId,
                      category_name: categoryId
                        ? (categories.get(categoryId) ?? null)
                        : null,
                      note: (transaction.get('note') as string | null) ?? null,
                      tags: tagsByTransaction.get(transaction.id) ?? [],
                      expense_frequency:
                        (transaction.get('expense_frequency') as
                          TransactionView['expense_frequency'] | undefined) ??
                        null,
                      hidden_mode:
                        (transaction.get('hidden_mode') as
                          TransactionView['hidden_mode'] | undefined) ?? null,
                      hidden_until:
                        transaction.get('hidden_until') == null
                          ? null
                          : iso(transaction.get('hidden_until')),
                      hidden_by_membership_id:
                        (transaction.get('hidden_by_membership_id') as
                          string | null) ?? null,
                      split_items: (
                        splitItemsByTransaction.get(transaction.id) ?? []
                      ).sort((left, right) => left.position - right.position),
                      transfer_group_id:
                        (transaction.get('transfer_group_id') as
                          string | null) ?? null,
                      transfer_leg:
                        (transaction.get(
                          'transfer_leg',
                        ) as TransactionView['transfer_leg']) ?? null,
                    };
                  })
                  .sort((a, b) =>
                    b.operation_date.localeCompare(a.operation_date),
                  );
                publishForViewer();
              },
            )
            .catch((error: unknown) => {
              if (!active || currentRevision !== revision) return;
              onError(
                error instanceof Error
                  ? error
                  : new Error('Failed to load budget transactions.'),
              );
            });
        },
        onError,
      );
      return () => {
        active = false;
        revision += 1;
        if (expiryTimer) clearTimeout(expiryTimer);
        unsubscribe();
      };
    },

    subscribeMembers(budgetId, onData, onError) {
      return onSnapshot(
        collection(db, 'budgets', budgetId, 'active_members'),
        (snapshot) => {
          const members = snapshot.docs.map((member) => ({
            user_id: member.id,
            membership_id: member.get('membership_id') as string,
            role: member.get('role') as MemberView['role'],
            joined_at: iso(member.get('joined_at')),
            display_name: (member.get('display_name') as string | null) ?? null,
            email: (member.get('email') as string | null) ?? null,
          }));
          members.sort((a, b) =>
            compareMembersForSuccession(
              { ...a, joined_at: new Date(a.joined_at) },
              { ...b, joined_at: new Date(b.joined_at) },
            ),
          );
          onData(members);
        },
        onError,
      );
    },

    subscribeBudgetAccounts(budgetId, onData, onError) {
      return subscribeBudgetCollection<QuerySnapshot>(
        db,
        budgetId,
        'accounts',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot) => {
          const accounts: AccountView[] = snapshot.docs
            .filter((account) => account.get('archived_at') == null)
            .map((account) => ({
              account_id: account.id,
              budget_id: account.get('budget_id') as string,
              owner_membership_id: account.get('owner_membership_id') as string,
              label: account.get('label') as string,
              currency: account.get('currency') as string,
              account_type: account.get(
                'account_type',
              ) as AccountView['account_type'],
              archived_at: null,
            }))
            .sort((a, b) => a.label.localeCompare(b.label, 'pl'));
          onData(accounts);
        },
        onError,
      );
    },

    subscribeAccountBalances(budgetId, accountIds, onData, onError) {
      if (accountIds.length === 0) {
        onData([]);
        return () => undefined;
      }
      const byAccount = new Map<string, AccountBalanceView[]>();
      const publish = () => onData([...byAccount.values()].flat());
      const unsubs = accountIds.map((accountId) =>
        subscribeBudgetCollection<QuerySnapshot>(
          db,
          budgetId,
          'account_balance_snapshots',
          (source) => query(source, where('account_id', '==', accountId)),
          (snapshot) => {
            byAccount.set(
              accountId,
              snapshot.docs.map((balance) => ({
                snapshot_id: balance.id,
                account_id: accountId,
                balance_date: balance.get('balance_date') as string,
                balance_amount: balance.get('balance_amount') as string,
                currency: balance.get('currency') as string,
                source: balance.get('source') as AccountBalanceView['source'],
              })),
            );
            publish();
          },
          onError,
        ),
      );
      return () => unsubs.forEach((unsubscribe) => unsubscribe());
    },

    subscribeSpendingLimits(budgetId, onData, onError) {
      return subscribeBudgetCollection<QuerySnapshot>(
        db,
        budgetId,
        'spending_limits',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot) => {
          onData(
            snapshot.docs.map((limit) => ({
              spending_limit_id: limit.id,
              budget_id: budgetId,
              limit_scope: limit.get(
                'limit_scope',
              ) as SpendingLimitView['limit_scope'],
              category_id: (limit.get('category_id') as string | null) ?? null,
              period: limit.get('period') as SpendingLimitView['period'],
              limit_amount: limit.get('limit_amount') as string,
              currency: limit.get('currency') as string,
            })),
          );
        },
        onError,
      );
    },

    subscribeTransferGroups(budgetId, onData, onError) {
      return subscribeBudgetCollection<QuerySnapshot>(
        db,
        budgetId,
        'transfer_groups',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot) => {
          onData(
            snapshot.docs.map((group) => ({
              transfer_group_id: group.id,
              budget_id: budgetId,
              status: group.get('status') as TransferGroupView['status'],
              outgoing_transaction_id:
                (group.get('outgoing_transaction_id') as string | null) ?? null,
              incoming_transaction_id:
                (group.get('incoming_transaction_id') as string | null) ?? null,
              transaction_id:
                (group.get('transaction_id') as string | null) ?? null,
            })),
          );
        },
        onError,
      );
    },

    subscribeCategories(budgetId, onData, onError) {
      return subscribeBudgetCollection<QuerySnapshot>(
        db,
        budgetId,
        'categories',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot) => {
          const categories: CategoryView[] = snapshot.docs
            .map((category) => ({
              category_id: category.id,
              budget_id: category.get('budget_id') as string,
              parent_category_id:
                (category.get('parent_category_id') as string | null) ?? null,
              name: category.get('name') as string,
              kind: category.get('kind') as CategoryView['kind'],
              expense_nature:
                (category.get('expense_nature') as
                  CategoryView['expense_nature'] | undefined) ?? null,
              sort_order:
                (category.get('sort_order') as number | undefined) ?? 0,
              archived_at:
                category.get('archived_at') == null
                  ? null
                  : iso(category.get('archived_at')),
            }))
            .sort(
              (a, b) =>
                a.sort_order - b.sort_order ||
                a.name.localeCompare(b.name, 'pl'),
            );
          onData(categories);
        },
        onError,
      );
    },

    subscribeCategorizationRules(budgetId, onData, onError) {
      return subscribeBudgetCollection<QuerySnapshot>(
        db,
        budgetId,
        'categorization_rules',
        (source) => query(source, where('budget_id', '==', budgetId)),
        (snapshot, activeRevisionId) => {
          void Promise.all(
            snapshot.docs.map(
              async (rule): Promise<CategorizationRuleView | null> => {
                const category = await getDoc(
                  doc(
                    db,
                    budgetDocumentPath(
                      budgetId,
                      activeRevisionId,
                      'categories',
                      rule.get('category_id') as string,
                    ),
                  ),
                );
                if (
                  !category.exists() ||
                  category.get('budget_id') !== budgetId
                ) {
                  return null;
                }
                return {
                  rule_id: rule.id,
                  budget_id: rule.get('budget_id') as string,
                  category_id: rule.get('category_id') as string,
                  category_name: category.get('name') as string,
                  source: rule.get(
                    'source',
                  ) as CategorizationRuleView['source'],
                  match_field: rule.get(
                    'match_field',
                  ) as CategorizationRuleView['match_field'],
                  operator: rule.get(
                    'operator',
                  ) as CategorizationRuleView['operator'],
                  match_value: rule.get('match_value') as string,
                  priority: rule.get('priority') as number,
                  enabled: rule.get('enabled') as boolean,
                };
              },
            ),
          )
            .then((rules) => onData(rules.filter((rule) => rule !== null)))
            .catch((error: unknown) =>
              onError(
                error instanceof Error
                  ? error
                  : new Error('Failed to load categorization rules.'),
              ),
            );
        },
        onError,
      );
    },

    subscribeInvitations(budgetId, onData, onError) {
      return onSnapshot(
        query(
          collection(db, 'invitations'),
          where('budget_id', '==', budgetId),
        ),
        (snapshot) => {
          const invitations: InvitationView[] = snapshot.docs
            .map((invitation) => ({
              invitation_id: invitation.id,
              status: invitation.get('status') as InvitationView['status'],
              invitee_email:
                (invitation.get('invitee_email') as string | null) ?? null,
              created_at: iso(invitation.get('created_at')),
              expires_at: iso(invitation.get('expires_at')),
            }))
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
          onData(invitations);
        },
        onError,
      );
    },

    async getPreferences(uid): Promise<UserPreferencesRecord | null> {
      const snapshot = await getDoc(doc(db, 'user_preferences', uid));
      if (!snapshot.exists()) return null;
      return {
        user_id: uid,
        primary_currency: snapshot.get('primary_currency') as string,
        secondary_currencies: snapshot.get('secondary_currencies') as string[],
      };
    },
  };
}
