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
  CategorizationRuleView,
  CategoryView,
  InvitationView,
  MemberView,
  MyBudgetView,
  TransactionView,
  UserPreferencesRecord,
} from '../../../shared/contracts';
import { compareMembersForSuccession } from '../../../shared/domain/membership';
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

    subscribeTransactions(budgetId, onData, onError) {
      let active = true;
      let revision = 0;
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
              snapshot.docs
                .map(
                  (transaction) =>
                    transaction.get('category_id') as string | null,
                )
                .filter((categoryId): categoryId is string =>
                  Boolean(categoryId),
                ),
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
            Promise.all(
              categoryIds.map(async (categoryId) => {
                const category = await getDoc(
                  doc(db, 'categories', categoryId),
                );
                return [
                  categoryId,
                  category.exists() && category.get('budget_id') === budgetId
                    ? (category.get('name') as string)
                    : null,
                ] as const;
              }),
            ),
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
          ])
            .then(
              ([
                accountEntries,
                categoryEntries,
                importEntries,
                tagEntries,
              ]) => {
                if (!active || currentRevision !== revision) return;
                const accounts = new Map(accountEntries);
                const categories = new Map(categoryEntries);
                const importers = new Map(importEntries);
                const tagsByTransaction = new Map(tagEntries);
                const transactions: TransactionView[] = snapshot.docs
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
                      type: transaction.get('type') as TransactionView['type'],
                      category_id: categoryId,
                      category_name: categoryId
                        ? (categories.get(categoryId) ?? null)
                        : null,
                      note: (transaction.get('note') as string | null) ?? null,
                      tags: tagsByTransaction.get(transaction.id) ?? [],
                    };
                  })
                  .sort((a, b) =>
                    b.operation_date.localeCompare(a.operation_date),
                  );
                onData(transactions);
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
