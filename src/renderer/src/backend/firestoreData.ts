import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import type {
  AccountView,
  AccountBalanceView,
  CategorizationRuleView,
  CategoryView,
  InvitationView,
  MemberView,
  MyBudgetView,
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

export function createFirestoreDataSource(db: Firestore): BudgetDataSource {
  return {
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
      return onSnapshot(
        query(collection(db, 'accounts'), where('budget_id', '==', budgetId)),
        (snapshot) => {
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
      const unsubscribe = onSnapshot(
        query(
          collection(db, 'transactions'),
          where('budget_id', '==', budgetId),
        ),
        (snapshot) => {
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
                const account = await getDoc(doc(db, 'accounts', accountId));
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
                collection(db, 'categories'),
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
                const batch = await getDoc(doc(db, 'import_batches', importId));
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
                    collection(db, 'transaction_tags'),
                    where('transaction_id', '==', transaction.id),
                  ),
                );
                const tagIds = links.docs.map(
                  (link) => link.get('tag_id') as string,
                );
                const tags = await Promise.all(
                  tagIds.map((tagId) => getDoc(doc(db, 'tags', tagId))),
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
                collection(db, 'split_items'),
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
      return onSnapshot(
        query(collection(db, 'accounts'), where('budget_id', '==', budgetId)),
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

    subscribeAccountBalances(accountIds, onData, onError) {
      if (accountIds.length === 0) {
        onData([]);
        return () => undefined;
      }
      const byAccount = new Map<string, AccountBalanceView[]>();
      const publish = () => onData([...byAccount.values()].flat());
      const unsubs = accountIds.map((accountId) =>
        onSnapshot(
          query(
            collection(db, 'account_balance_snapshots'),
            where('account_id', '==', accountId),
          ),
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

    subscribeTransferGroups(budgetId, onData, onError) {
      return onSnapshot(
        query(
          collection(db, 'transfer_groups'),
          where('budget_id', '==', budgetId),
        ),
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
      return onSnapshot(
        query(collection(db, 'categories'), where('budget_id', '==', budgetId)),
        (snapshot) => {
          const categories: CategoryView[] = snapshot.docs
            .map((category) => ({
              category_id: category.id,
              budget_id: category.get('budget_id') as string,
              parent_category_id:
                (category.get('parent_category_id') as string | null) ?? null,
              name: category.get('name') as string,
              kind: category.get('kind') as CategoryView['kind'],
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
      return onSnapshot(
        query(
          collection(db, 'categorization_rules'),
          where('budget_id', '==', budgetId),
        ),
        (snapshot) => {
          void Promise.all(
            snapshot.docs.map(
              async (rule): Promise<CategorizationRuleView | null> => {
                const category = await getDoc(
                  doc(db, 'categories', rule.get('category_id') as string),
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
