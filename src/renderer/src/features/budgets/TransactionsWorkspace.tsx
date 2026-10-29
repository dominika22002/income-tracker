import React, { useEffect, useMemo, useState } from 'react';
import type {
  AccountView,
  CategorizationRuleView,
  CategoryKind,
  CategoryView,
  MyBudgetView,
  SaveCategorizationRuleRequest,
  StatementTransactionType,
  TransactionView,
} from '../../../../shared/contracts';
import {
  filterAndSortTransactions,
  recordLocalCorrection,
  suggestLearnedCategory,
  type LocalCategoryCorrection,
  type TransactionFilters,
  type TransactionSort,
  type TransactionSortField,
} from '../../../../shared/domain/transactions';
import {
  isTransactionHidden,
  transactionsVisibleToMember,
} from '../../../../shared/domain/transactionFeatures';
import type { AppServices } from '../../backend/ports';
import { describeError } from './errorMessages';
import { HiddenTransactionsNotice } from './HiddenTransactionsNotice';
import { TransactionSplitEditor } from './TransactionSplitEditor';
import { TransactionVisibilityEditor } from './TransactionVisibilityEditor';

const TYPES: StatementTransactionType[] = ['EXPENSE', 'INCOME', 'TRANSFER'];
const TYPE_LABELS: Record<StatementTransactionType, string> = {
  EXPENSE: 'Wydatek',
  INCOME: 'Przychód',
  TRANSFER: 'Przelew wewnętrzny',
};
const LEARNING_KEY_PREFIX = 'income-tracker:category-corrections:';

interface TransactionForm {
  account_id: string;
  operation_date: string;
  description: string;
  amount: string;
  currency: string;
  type: StatementTransactionType;
  category_id: string;
  note: string;
  tags: string;
}

function emptyForm(account?: AccountView): TransactionForm {
  return {
    account_id: account?.account_id ?? '',
    operation_date: new Date().toISOString().slice(0, 10),
    description: '',
    amount: '',
    currency: account?.currency ?? 'CHF',
    type: 'EXPENSE',
    category_id: '',
    note: '',
    tags: '',
  };
}

function readCorrections(budgetId: string): LocalCategoryCorrection[] {
  const raw = window.localStorage.getItem(`${LEARNING_KEY_PREFIX}${budgetId}`);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) =>
        !item ||
        typeof item.description !== 'string' ||
        typeof item.category_id !== 'string' ||
        !Number.isInteger(item.count) ||
        item.count < 1,
    )
  ) {
    throw new Error('Zapis lokalnych sugestii kategorii jest nieprawidłowy.');
  }
  return parsed as LocalCategoryCorrection[];
}

function categoryOrder(categories: readonly CategoryView[]): CategoryView[] {
  return [...categories].sort(
    (left, right) =>
      left.sort_order - right.sort_order ||
      left.name.localeCompare(right.name, 'pl'),
  );
}

export function TransactionsWorkspace({
  services,
  budgets,
  selectedBudgetId,
  onSelectBudget,
}: {
  services: AppServices;
  budgets: MyBudgetView[] | null;
  selectedBudgetId?: string;
  onSelectBudget: (budgetId: string) => void;
}) {
  const budgetId =
    (selectedBudgetId &&
    budgets?.some((budget) => budget.budget_id === selectedBudgetId)
      ? selectedBudgetId
      : undefined) ??
    budgets?.[0]?.budget_id ??
    '';
  const viewerMembershipId =
    budgets?.find((budget) => budget.budget_id === budgetId)?.membership_id ??
    '';
  const [activeTab, setActiveTab] = useState<
    'transactions' | 'categories' | 'rules'
  >('transactions');
  const [transactionsSnapshot, setTransactionsSnapshot] = useState<{
    budgetId: string;
    values: TransactionView[];
  } | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [rules, setRules] = useState<CategorizationRuleView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<TransactionFilters>({});
  const [sort, setSort] = useState<TransactionSort>({
    field: 'operation_date',
    direction: 'desc',
  });
  const [editing, setEditing] = useState<TransactionView | null>(null);
  const [form, setForm] = useState<TransactionForm>(() => emptyForm());
  const [formOpen, setFormOpen] = useState(false);
  const [createRule, setCreateRule] = useState(false);
  const [selectedDetails, setSelectedDetails] = useState<string | null>(null);
  const [splitEditorId, setSplitEditorId] = useState<string | null>(null);
  const [visibilityEditorId, setVisibilityEditorId] = useState<string | null>(
    null,
  );
  const [correctionSnapshot, setCorrectionSnapshot] = useState(() => {
    try {
      return {
        budgetId,
        values: budgetId ? readCorrections(budgetId) : [],
        error: null as string | null,
      };
    } catch (failure) {
      return {
        budgetId,
        values: [] as LocalCategoryCorrection[],
        error: describeError(failure),
      };
    }
  });
  const corrections =
    correctionSnapshot.budgetId === budgetId ? correctionSnapshot.values : [];
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryKind, setCategoryKind] = useState<CategoryKind>('EXPENSE');
  const [ruleField, setRuleField] =
    useState<SaveCategorizationRuleRequest['match_field']>('DESCRIPTION');
  const [ruleOperator, setRuleOperator] =
    useState<SaveCategorizationRuleRequest['operator']>('CONTAINS');
  const [ruleValue, setRuleValue] = useState('');
  const [ruleCategoryId, setRuleCategoryId] = useState('');
  const [rulePriority, setRulePriority] = useState('0');

  useEffect(() => {
    if (!budgetId) return undefined;
    return services.data.subscribeTransactions(
      budgetId,
      viewerMembershipId,
      (values) => setTransactionsSnapshot({ budgetId, values }),
      (failure) => setError(describeError(failure)),
    );
  }, [budgetId, viewerMembershipId, services.data]);

  useEffect(() => {
    if (!budgetId) return undefined;
    const unsubscribeAccounts = services.data.subscribeBudgetAccounts(
      budgetId,
      setAccounts,
      (failure) => setError(describeError(failure)),
    );
    const unsubscribeCategories = services.data.subscribeCategories(
      budgetId,
      setCategories,
      (failure) => setError(describeError(failure)),
    );
    const unsubscribeRules = services.data.subscribeCategorizationRules(
      budgetId,
      setRules,
      (failure) => setError(describeError(failure)),
    );
    return () => {
      unsubscribeAccounts();
      unsubscribeCategories();
      unsubscribeRules();
    };
  }, [budgetId, services.data]);

  function selectBudget(nextBudgetId: string) {
    onSelectBudget(nextBudgetId);
    try {
      setCorrectionSnapshot({
        budgetId: nextBudgetId,
        values: readCorrections(nextBudgetId),
        error: null,
      });
    } catch (failure) {
      setCorrectionSnapshot({
        budgetId: nextBudgetId,
        values: [],
        error: describeError(failure),
      });
    }
  }

  const transactions =
    transactionsSnapshot?.budgetId === budgetId
      ? transactionsSnapshot.values
      : null;
  const visibleTransactions = transactions
    ? transactionsVisibleToMember(transactions, viewerMembershipId, new Date())
    : null;
  const orderedCategories = useMemo(
    () => categoryOrder(categories),
    [categories],
  );
  const filteredTransactions = useMemo(
    () =>
      visibleTransactions
        ? filterAndSortTransactions(visibleTransactions, filters, sort)
        : [],
    [visibleTransactions, filters, sort],
  );
  const correctionSuggestion = suggestLearnedCategory(
    corrections,
    form.description,
    form.category_id,
  );
  const activeTypeCategories = orderedCategories.filter(
    (category) =>
      category.kind === form.type &&
      (category.archived_at === null ||
        category.category_id === form.category_id),
  );
  const currentBudget = budgets?.find(
    (budget) => budget.budget_id === budgetId,
  );

  function startCreate() {
    setEditing(null);
    setForm(emptyForm(accounts[0]));
    setCreateRule(false);
    setSuggestionDismissed(false);
    setFormOpen(true);
    setNotice(null);
  }

  function startEdit(transaction: TransactionView) {
    setEditing(transaction);
    setForm({
      account_id: transaction.account_id,
      operation_date: transaction.operation_date,
      description: transaction.description,
      amount: transaction.amount,
      currency: transaction.currency,
      type: transaction.type,
      category_id: transaction.category_id ?? '',
      note: transaction.note ?? '',
      tags: transaction.tags.join(', '),
    });
    setCreateRule(false);
    setSuggestionDismissed(false);
    setFormOpen(true);
    setNotice(null);
  }

  async function saveTransaction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budgetId || !form.account_id) {
      setError('Wybierz budżet i konto przed zapisaniem transakcji.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    let localSuggestionFailed = false;
    const selectedCategory = form.category_id || null;
    const categoryWasChanged =
      selectedCategory !== (editing?.category_id ?? null);
    const request = {
      budget_id: budgetId,
      account_id: form.account_id,
      operation_date: form.operation_date,
      description: form.description,
      amount: form.amount,
      currency: form.currency,
      type: form.type,
      category_id: editing ? selectedCategory : selectedCategory || undefined,
      note: form.note || null,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      ...(editing ? { transaction_id: editing.transaction_id } : {}),
      ...(createRule && selectedCategory
        ? {
            create_rule: {
              match_field: 'DESCRIPTION' as const,
              operator: 'CONTAINS' as const,
              match_value: form.description,
              priority: 0,
            },
          }
        : {}),
    };
    try {
      await services.backend.saveTransaction(request);
      if (categoryWasChanged && selectedCategory) {
        const nextCorrections = recordLocalCorrection(
          corrections,
          form.description,
          selectedCategory,
        );
        try {
          window.localStorage.setItem(
            `${LEARNING_KEY_PREFIX}${budgetId}`,
            JSON.stringify(nextCorrections),
          );
          setCorrectionSnapshot({
            budgetId,
            values: nextCorrections,
            error: null,
          });
        } catch (failure) {
          localSuggestionFailed = true;
          setError(
            `Transakcja została zapisana, ale nie udało się zachować lokalnej sugestii: ${describeError(failure)}`,
          );
        }
      }
      setFormOpen(false);
      setEditing(null);
      if (!localSuggestionFailed) {
        setNotice(
          createRule
            ? 'Transakcja zapisana, reguła aktywna dla kolejnych transakcji.'
            : 'Transakcja zapisana.',
        );
      }
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  async function saveCategory(
    category: CategoryView,
    changes: { name?: string; sort_order?: number },
  ) {
    setSaving(true);
    setError(null);
    try {
      await services.backend.saveCategory({
        budget_id: budgetId,
        category_id: category.category_id,
        name: changes.name ?? category.name,
        kind: category.kind,
        sort_order: changes.sort_order ?? category.sort_order,
      });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  async function createCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budgetId) return;
    setSaving(true);
    setError(null);
    try {
      await services.backend.saveCategory({
        budget_id: budgetId,
        name: categoryName,
        kind: categoryKind,
        sort_order:
          Math.max(
            -1,
            ...categories
              .filter((category) => category.kind === categoryKind)
              .map((category) => category.sort_order),
          ) + 1,
      });
      setCategoryName('');
      setNotice('Kategoria została dodana.');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  async function archiveCategory(category: CategoryView) {
    setSaving(true);
    setError(null);
    try {
      await services.backend.archiveCategory({
        budget_id: budgetId,
        category_id: category.category_id,
      });
      setNotice(
        'Kategoria została zarchiwizowana. Historia pozostała bez zmian.',
      );
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  async function moveCategory(category: CategoryView, direction: -1 | 1) {
    const siblings = orderedCategories.filter(
      (candidate) =>
        candidate.archived_at === null && candidate.kind === category.kind,
    );
    const index = siblings.findIndex(
      (candidate) => candidate.category_id === category.category_id,
    );
    const other = siblings[index + direction];
    if (!other) return;
    setSaving(true);
    setError(null);
    try {
      await Promise.all([
        saveCategoryWithoutState(category, other.sort_order),
        saveCategoryWithoutState(other, category.sort_order),
      ]);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  async function saveCategoryWithoutState(
    category: CategoryView,
    sortOrder: number,
  ) {
    await services.backend.saveCategory({
      budget_id: budgetId,
      category_id: category.category_id,
      name: category.name,
      kind: category.kind,
      sort_order: sortOrder,
    });
  }

  async function saveNewRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budgetId || !ruleCategoryId) return;
    setSaving(true);
    setError(null);
    try {
      await services.backend.saveCategorizationRule({
        budget_id: budgetId,
        category_id: ruleCategoryId,
        match_field: ruleField,
        operator: ruleOperator,
        match_value: ruleValue,
        priority: Number(rulePriority),
      });
      setRuleValue('');
      setNotice('Reguła została zapisana.');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: CategorizationRuleView) {
    setSaving(true);
    setError(null);
    try {
      await services.backend.saveCategorizationRule({
        budget_id: budgetId,
        category_id: rule.category_id,
        rule_id: rule.rule_id,
        match_field: rule.match_field,
        operator: rule.operator,
        match_value: rule.match_value,
        priority: rule.priority,
        enabled: !rule.enabled,
      });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  }

  function updateFilter<Key extends keyof TransactionFilters>(
    key: Key,
    value: TransactionFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  }

  return (
    <section
      className="dashboard-card transaction-workspace"
      aria-label="Transakcje budżetu"
    >
      <div className="card-heading">
        <div>
          <p className="eyebrow">TRANSAKCJE I KATEGORYZACJA</p>
          <h2>{currentBudget?.name ?? 'Transakcje'}</h2>
        </div>
        {budgets && budgets.length > 0 && (
          <label>
            Budżet
            <select
              aria-label="Budżet transakcji"
              value={budgetId}
              onChange={(event) => selectBudget(event.target.value)}
            >
              {budgets.map((budget) => (
                <option key={budget.budget_id} value={budget.budget_id}>
                  {budget.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {(error || correctionSnapshot.error) && (
        <p role="alert">{error ?? correctionSnapshot.error}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      <HiddenTransactionsNotice transactions={transactions ?? []} />
      {!budgetId ? (
        <p>Utwórz budżet, aby dodawać i przeglądać transakcje.</p>
      ) : (
        <>
          <nav aria-label="Sekcje transakcji" className="workspace-tabs">
            <button
              type="button"
              aria-pressed={activeTab === 'transactions'}
              onClick={() => setActiveTab('transactions')}
            >
              Transakcje
            </button>
            <button
              type="button"
              aria-pressed={activeTab === 'categories'}
              onClick={() => setActiveTab('categories')}
            >
              Kategorie
            </button>
            <button
              type="button"
              aria-pressed={activeTab === 'rules'}
              onClick={() => setActiveTab('rules')}
            >
              Reguły
            </button>
          </nav>

          {activeTab === 'transactions' && (
            <section aria-label="Lista transakcji">
              <div className="workspace-toolbar">
                <h3>Lista transakcji</h3>
                <button
                  type="button"
                  disabled={saving || accounts.length === 0}
                  onClick={startCreate}
                >
                  Dodaj transakcję
                </button>
              </div>
              <div className="transaction-filters">
                <label>
                  Szukaj opisu
                  <input
                    aria-label="Szukaj opisu"
                    value={filters.search ?? ''}
                    onChange={(event) =>
                      updateFilter('search', event.target.value)
                    }
                  />
                </label>
                <label>
                  Od daty
                  <input
                    aria-label="Filtr daty od"
                    type="date"
                    value={filters.dateFrom ?? ''}
                    onChange={(event) =>
                      updateFilter('dateFrom', event.target.value)
                    }
                  />
                </label>
                <label>
                  Do daty
                  <input
                    aria-label="Filtr daty do"
                    type="date"
                    value={filters.dateTo ?? ''}
                    onChange={(event) =>
                      updateFilter('dateTo', event.target.value)
                    }
                  />
                </label>
                <label>
                  Kwota od
                  <input
                    aria-label="Kwota od"
                    inputMode="decimal"
                    value={filters.minAmount ?? ''}
                    onChange={(event) =>
                      updateFilter('minAmount', event.target.value)
                    }
                  />
                </label>
                <label>
                  Kwota do
                  <input
                    aria-label="Kwota do"
                    inputMode="decimal"
                    value={filters.maxAmount ?? ''}
                    onChange={(event) =>
                      updateFilter('maxAmount', event.target.value)
                    }
                  />
                </label>
                <label>
                  Kategoria
                  <select
                    aria-label="Filtr kategorii"
                    value={filters.categoryId ?? ''}
                    onChange={(event) =>
                      updateFilter('categoryId', event.target.value)
                    }
                  >
                    <option value="">Wszystkie</option>
                    {orderedCategories.map((category) => (
                      <option
                        key={category.category_id}
                        value={category.category_id}
                      >
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Typ
                  <select
                    aria-label="Filtr typu"
                    value={filters.type ?? ''}
                    onChange={(event) =>
                      updateFilter(
                        'type',
                        event.target.value as StatementTransactionType | '',
                      )
                    }
                  >
                    <option value="">Wszystkie</option>
                    {TYPES.map((type) => (
                      <option key={type} value={type}>
                        {TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Sortuj według
                  <select
                    aria-label="Sortowanie"
                    value={sort.field}
                    onChange={(event) =>
                      setSort((current) => ({
                        ...current,
                        field: event.target.value as TransactionSortField,
                      }))
                    }
                  >
                    <option value="operation_date">Daty</option>
                    <option value="amount">Kwoty</option>
                    <option value="category">Kategorii</option>
                    <option value="description">Opisu</option>
                    <option value="type">Typu</option>
                  </select>
                </label>
                <label>
                  Kierunek
                  <select
                    aria-label="Kierunek sortowania"
                    value={sort.direction}
                    onChange={(event) =>
                      setSort((current) => ({
                        ...current,
                        direction: event.target
                          .value as TransactionSort['direction'],
                      }))
                    }
                  >
                    <option value="desc">Malejąco</option>
                    <option value="asc">Rosnąco</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setFilters({})}
                >
                  Wyczyść filtry
                </button>
              </div>
              {transactions === null ? (
                <p role="status">Ładowanie transakcji…</p>
              ) : transactions.length === 0 ? (
                <p>Brak transakcji w tym budżecie.</p>
              ) : filteredTransactions.length === 0 ? (
                <p>Brak transakcji spełniających filtry.</p>
              ) : (
                <div className="transaction-table-scroll">
                  <table className="transaction-table">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Opis</th>
                        <th>Konto</th>
                        <th>Kategoria</th>
                        <th>Typ</th>
                        <th>Kwota</th>
                        <th>Szczegóły</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTransactions.map((transaction) => (
                        <tr key={transaction.transaction_id}>
                          <td>{transaction.operation_date}</td>
                          <td>
                            {transaction.description}
                            {transaction.hidden_for_viewer && (
                              <small>
                                {transaction.hidden_until
                                  ? ` Widoczny od ${new Date(transaction.hidden_until).toLocaleString('pl-PL')}.`
                                  : ' Ukryty bezterminowo.'}
                              </small>
                            )}
                          </td>
                          <td>
                            {transaction.account_label ?? 'Konto niedostępne'}
                          </td>
                          <td>{transaction.category_name ?? '—'}</td>
                          <td>{TYPE_LABELS[transaction.type]}</td>
                          <td>
                            {transaction.amount} {transaction.currency}
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedDetails((current) =>
                                  current === transaction.transaction_id
                                    ? null
                                    : transaction.transaction_id,
                                )
                              }
                            >
                              Szczegóły
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {filteredTransactions.map(
                (transaction) =>
                  selectedDetails === transaction.transaction_id && (
                    <section
                      key={transaction.transaction_id}
                      aria-label="Szczegóły transakcji"
                    >
                      <h4>{transaction.description}</h4>
                      <p>Notatka: {transaction.note || 'Brak'}</p>
                      <p>Etykiety: {transaction.tags.join(', ') || 'Brak'}</p>
                      <p>
                        Właściciel konta:{' '}
                        {transaction.account_owner_membership_id ??
                          'Brak danych'}
                      </p>
                      <p>
                        Import:{' '}
                        {transaction.import_batch_id ?? 'Ręcznie dodana'}
                      </p>
                      <p>
                        Importujący:{' '}
                        {transaction.imported_by_membership_id ?? '—'}
                      </p>
                      <p>
                        Identyfikator bankowy:{' '}
                        {transaction.bank_transaction_id ?? '—'}
                      </p>
                      {(transaction.split_items?.length ?? 0) > 0 && (
                        <section aria-label="Pozycje podziału">
                          <h5>Pozycje podziału</h5>
                          <ul>
                            {transaction.split_items?.map((item) => (
                              <li key={item.split_item_id}>
                                {item.amount} {transaction.currency} ·{' '}
                                {categories.find(
                                  (category) =>
                                    category.category_id === item.category_id,
                                )?.name ?? 'Kategoria niedostępna'}
                                {item.description
                                  ? ` · ${item.description}`
                                  : ''}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {!transaction.hidden_for_viewer && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setSplitEditorId((current) =>
                                current === transaction.transaction_id
                                  ? null
                                  : transaction.transaction_id,
                              )
                            }
                          >
                            {(transaction.split_items?.length ?? 0) > 0
                              ? 'Edytuj podział'
                              : 'Podziel transakcję'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setVisibilityEditorId((current) =>
                                current === transaction.transaction_id
                                  ? null
                                  : transaction.transaction_id,
                              )
                            }
                          >
                            {isTransactionHidden(
                              transaction.hidden_mode,
                              transaction.hidden_until,
                              new Date(),
                            )
                              ? 'Zmień termin ukrycia'
                              : 'Ukryj'}
                          </button>
                          <button
                            type="button"
                            onClick={() => startEdit(transaction)}
                          >
                            Edytuj transakcję
                          </button>
                        </>
                      )}
                      {splitEditorId === transaction.transaction_id && (
                        <TransactionSplitEditor
                          transaction={transaction}
                          categories={orderedCategories}
                          backend={services.backend}
                          onComplete={(message) => {
                            setSplitEditorId(null);
                            setNotice(message);
                          }}
                        />
                      )}
                      {visibilityEditorId === transaction.transaction_id && (
                        <TransactionVisibilityEditor
                          transaction={transaction}
                          backend={services.backend}
                          onComplete={(message) => {
                            setVisibilityEditorId(null);
                            setNotice(message);
                          }}
                        />
                      )}
                    </section>
                  ),
              )}
              {formOpen && (
                <form
                  className="transaction-form"
                  onSubmit={(event) => void saveTransaction(event)}
                >
                  <h3>{editing ? 'Edytuj transakcję' : 'Nowa transakcja'}</h3>
                  <label>
                    Konto
                    <select
                      aria-label="Konto transakcji"
                      required
                      disabled={Boolean(editing?.import_batch_id)}
                      value={form.account_id}
                      onChange={(event) => {
                        const account = accounts.find(
                          (candidate) =>
                            candidate.account_id === event.target.value,
                        );
                        setForm((current) => ({
                          ...current,
                          account_id: event.target.value,
                          currency: account?.currency ?? current.currency,
                        }));
                      }}
                    >
                      {!accounts.some(
                        (account) => account.account_id === form.account_id,
                      ) &&
                        editing && (
                          <option value={editing.account_id}>
                            {editing.account_label ?? 'Konto historyczne'}
                          </option>
                        )}
                      {accounts.map((account) => (
                        <option
                          key={account.account_id}
                          value={account.account_id}
                        >
                          {account.label} · {account.owner_membership_id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Data
                    <input
                      aria-label="Data transakcji"
                      required
                      type="date"
                      value={form.operation_date}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          operation_date: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Opis
                    <input
                      aria-label="Opis transakcji"
                      required
                      maxLength={1000}
                      value={form.description}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          description: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Kwota
                    <input
                      aria-label="Kwota transakcji"
                      required
                      disabled={(editing?.split_items?.length ?? 0) > 0}
                      inputMode="decimal"
                      pattern="[+-]?[0-9]{1,15}(\\.[0-9]{1,4})?"
                      value={form.amount}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          amount: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {(editing?.split_items?.length ?? 0) > 0 && (
                    <p>
                      Usuń podział przed zmianą kwoty źródłowej; waluta i kwota
                      pozycji muszą pozostać zgodne ze źródłem.
                    </p>
                  )}
                  <label>
                    Waluta źródłowa
                    <input
                      aria-label="Waluta transakcji"
                      required
                      disabled={(editing?.split_items?.length ?? 0) > 0}
                      minLength={3}
                      maxLength={3}
                      value={form.currency}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          currency: event.target.value.toUpperCase(),
                        }))
                      }
                    />
                  </label>
                  <label>
                    Typ
                    <select
                      aria-label="Typ transakcji"
                      value={form.type}
                      onChange={(event) => {
                        const type = event.target
                          .value as StatementTransactionType;
                        setForm((current) => ({
                          ...current,
                          type,
                          category_id: '',
                        }));
                      }}
                    >
                      {TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Kategoria
                    <select
                      aria-label="Kategoria transakcji"
                      value={form.category_id}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          category_id: event.target.value,
                        }))
                      }
                    >
                      <option value="">Bez kategorii</option>
                      {activeTypeCategories.map((category) => (
                        <option
                          key={category.category_id}
                          value={category.category_id}
                        >
                          {category.name}
                          {category.archived_at ? ' (archiwalna)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {correctionSuggestion && !suggestionDismissed && (
                    <div className="category-suggestion" role="note">
                      <p>
                        Lokalna sugestia:{' '}
                        {categories.find(
                          (category) =>
                            category.category_id === correctionSuggestion,
                        )?.name ?? 'kategoria'}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            category_id: correctionSuggestion,
                          }))
                        }
                      >
                        Potwierdź sugestię
                      </button>
                      <button
                        type="button"
                        onClick={() => setSuggestionDismissed(true)}
                      >
                        Odrzuć
                      </button>
                    </div>
                  )}
                  <label>
                    Notatka
                    <textarea
                      aria-label="Notatka transakcji"
                      maxLength={4000}
                      value={form.note}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          note: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Etykiety (oddziel przecinkami)
                    <input
                      aria-label="Etykiety transakcji"
                      value={form.tags}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          tags: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {form.category_id && (
                    <label className="inline-control">
                      <input
                        type="checkbox"
                        checked={createRule}
                        onChange={(event) =>
                          setCreateRule(event.target.checked)
                        }
                      />
                      Utwórz regułę „opis zawiera” dla przyszłych transakcji
                    </label>
                  )}
                  <div className="actions">
                    <button type="submit" disabled={saving}>
                      {saving ? 'Zapisywanie…' : 'Zapisz transakcję'}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setFormOpen(false)}
                    >
                      Anuluj
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          {activeTab === 'categories' && (
            <section aria-label="Zarządzanie kategoriami">
              <h3>Kategorie budżetu</h3>
              <form
                className="workspace-toolbar"
                onSubmit={(event) => void createCategory(event)}
              >
                <label>
                  Nazwa kategorii
                  <input
                    aria-label="Nazwa nowej kategorii"
                    required
                    maxLength={80}
                    value={categoryName}
                    onChange={(event) => setCategoryName(event.target.value)}
                  />
                </label>
                <label>
                  Typ kategorii
                  <select
                    aria-label="Typ nowej kategorii"
                    value={categoryKind}
                    onChange={(event) =>
                      setCategoryKind(event.target.value as CategoryKind)
                    }
                  >
                    {TYPES.map((type) => (
                      <option key={type} value={type}>
                        {TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" disabled={saving}>
                  Dodaj kategorię
                </button>
              </form>
              <ul className="category-list">
                {orderedCategories.map((category) => (
                  <CategoryRow
                    key={category.category_id}
                    category={category}
                    categories={orderedCategories}
                    saving={saving}
                    onSave={saveCategory}
                    onArchive={archiveCategory}
                    onMove={moveCategory}
                  />
                ))}
              </ul>
            </section>
          )}

          {activeTab === 'rules' && (
            <section aria-label="Reguły kategoryzacji">
              <h3>Reguły kategoryzacji użytkownika</h3>
              <form
                className="transaction-form"
                onSubmit={(event) => void saveNewRule(event)}
              >
                <label>
                  Kryterium
                  <select
                    aria-label="Kryterium reguły"
                    value={ruleField}
                    onChange={(event) => {
                      const field = event.target.value as typeof ruleField;
                      setRuleField(field);
                      setRuleOperator(
                        field === 'DESCRIPTION' ? 'CONTAINS' : 'EQUALS',
                      );
                      setRuleValue('');
                    }}
                  >
                    <option value="DESCRIPTION">Opis</option>
                    <option value="ACCOUNT">Konto</option>
                    <option value="AMOUNT">Kwota</option>
                  </select>
                </label>
                {ruleField === 'DESCRIPTION' ? (
                  <>
                    <label>
                      Dopasowanie
                      <select
                        aria-label="Operator reguły"
                        value={ruleOperator}
                        onChange={(event) =>
                          setRuleOperator(
                            event.target
                              .value as SaveCategorizationRuleRequest['operator'],
                          )
                        }
                      >
                        <option value="CONTAINS">Zawiera</option>
                        <option value="EQUALS">Równa się</option>
                        <option value="STARTS_WITH">Zaczyna się od</option>
                      </select>
                    </label>
                    <label>
                      Fragment opisu
                      <input
                        aria-label="Wartość reguły"
                        required
                        maxLength={200}
                        value={ruleValue}
                        onChange={(event) => setRuleValue(event.target.value)}
                      />
                    </label>
                  </>
                ) : ruleField === 'ACCOUNT' ? (
                  <label>
                    Konto
                    <select
                      aria-label="Wartość reguły"
                      required
                      value={ruleValue}
                      onChange={(event) => setRuleValue(event.target.value)}
                    >
                      <option value="">Wybierz konto</option>
                      {accounts.map((account) => (
                        <option
                          key={account.account_id}
                          value={account.account_id}
                        >
                          {account.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Kwota dokładna
                    <input
                      aria-label="Wartość reguły"
                      required
                      inputMode="decimal"
                      value={ruleValue}
                      onChange={(event) => setRuleValue(event.target.value)}
                    />
                  </label>
                )}
                <label>
                  Kategoria
                  <select
                    aria-label="Kategoria reguły"
                    required
                    value={ruleCategoryId}
                    onChange={(event) => setRuleCategoryId(event.target.value)}
                  >
                    <option value="">Wybierz kategorię</option>
                    {orderedCategories
                      .filter((category) => category.archived_at === null)
                      .map((category) => (
                        <option
                          key={category.category_id}
                          value={category.category_id}
                        >
                          {category.name} · {TYPE_LABELS[category.kind]}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Priorytet
                  <input
                    aria-label="Priorytet reguły"
                    type="number"
                    min="0"
                    max="10000"
                    value={rulePriority}
                    onChange={(event) => setRulePriority(event.target.value)}
                  />
                </label>
                <p>
                  Automatycznie stosowane są wyłącznie aktywne reguły
                  użytkownika. Sugestie lokalne wymagają potwierdzenia.
                </p>
                <button type="submit" disabled={saving}>
                  Zapisz regułę
                </button>
              </form>
              <ul>
                {rules.map((rule) => (
                  <li key={rule.rule_id}>
                    {rule.source === 'LEARNED' ? 'Sugestia' : 'Reguła'}:{' '}
                    {rule.match_field} {rule.operator} „{rule.match_value}” →{' '}
                    {rule.category_name} (priorytet {rule.priority},{' '}
                    {rule.enabled ? 'aktywna' : 'nieaktywna'})
                    {rule.source === 'USER' && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void toggleRule(rule)}
                      >
                        {rule.enabled ? 'Wyłącz' : 'Włącz'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}

function CategoryRow({
  category,
  categories,
  saving,
  onSave,
  onArchive,
  onMove,
}: {
  category: CategoryView;
  categories: CategoryView[];
  saving: boolean;
  onSave: (
    category: CategoryView,
    changes: { name?: string; sort_order?: number },
  ) => Promise<void>;
  onArchive: (category: CategoryView) => Promise<void>;
  onMove: (category: CategoryView, direction: -1 | 1) => Promise<void>;
}) {
  const [name, setName] = useState(category.name);
  const [editing, setEditing] = useState(false);
  const activeSiblings = categories.filter(
    (candidate) =>
      candidate.archived_at === null && candidate.kind === category.kind,
  );
  const siblingIndex = activeSiblings.findIndex(
    (candidate) => candidate.category_id === category.category_id,
  );
  return (
    <li>
      {editing ? (
        <>
          <input
            aria-label={`Nazwa kategorii ${category.name}`}
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              void onSave(category, { name }).then(() => setEditing(false))
            }
          >
            Zapisz nazwę
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Anuluj
          </button>
        </>
      ) : (
        <>
          <span>
            {category.name} · {TYPE_LABELS[category.kind]} · kolejność{' '}
            {category.sort_order}
            {category.archived_at ? ' · archiwalna' : ''}
          </span>
          {category.archived_at === null && (
            <>
              <button
                type="button"
                disabled={saving || siblingIndex === 0}
                aria-label={`Przesuń ${category.name} wyżej`}
                onClick={() => void onMove(category, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={saving || siblingIndex === activeSiblings.length - 1}
                aria-label={`Przesuń ${category.name} niżej`}
                onClick={() => void onMove(category, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditing(true)}
              >
                Zmień nazwę
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void onArchive(category)}
              >
                Archiwizuj
              </button>
            </>
          )}
        </>
      )}
    </li>
  );
}
