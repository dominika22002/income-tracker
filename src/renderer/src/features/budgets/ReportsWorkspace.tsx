import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AccountBalanceView,
  AccountView,
  CategoryView,
  MyBudgetView,
  SpendingLimitView,
  TransactionConversionView,
  TransactionView,
  UserPreferencesRecord,
} from '../../../../shared/contracts';
import {
  aggregateReport,
  compareReportPeriods,
  estimateMonthlySavings,
  monthlyLimitUsage,
  savingsBalances,
  type ConversionRates,
  type ReportPeriod,
} from '../../../../shared/domain/reporting';
import {
  isHiddenFromViewer,
  maskTransactionsForMember,
} from '../../../../shared/domain/transactionFeatures';
import type { AppServices } from '../../backend/ports';
import { describeError } from './errorMessages';

type Snapshot<T> = { budgetId: string; values: T[] };
type SavedRate = { fingerprint: string; rate: string };
const EMPTY_TRANSACTIONS: TransactionView[] = [];
const EMPTY_CATEGORIES: CategoryView[] = [];
const EMPTY_ACCOUNTS: AccountView[] = [];
const EMPTY_LIMITS: SpendingLimitView[] = [];

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthPeriod(month: string): ReportPeriod {
  const [year, value] = month.split('-').map(Number);
  return {
    start: `${month}-01`,
    end: new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10),
  };
}

function isValidMonth(month: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
}

function previousMonth(month: string): string {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value - 2, 1)).toISOString().slice(0, 7);
}

function displayAmount(amount: string, currency: string): string {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 4,
  }).format(Number(amount));
}

function transactionFingerprint(transaction: TransactionView): string {
  return [
    transaction.amount,
    transaction.currency,
    transaction.operation_date,
  ].join('|');
}

function periodFromInputs(start: string, end: string): ReportPeriod {
  return { start, end };
}

function selectTargetRates(
  target: string,
  transactions: readonly TransactionView[],
  saved: Readonly<Record<string, Readonly<Record<string, SavedRate>>>>,
): ConversionRates {
  return Object.fromEntries(
    transactions.flatMap((transaction) => {
      if (transaction.currency === target) return [];
      const entry = saved[target]?.[transaction.transaction_id];
      return entry?.fingerprint === transactionFingerprint(transaction)
        ? [[transaction.transaction_id, entry.rate]]
        : [];
    }),
  );
}

function isValidPeriod(period: ReportPeriod): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(period.start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(period.end) &&
    period.start <= period.end
  );
}

export function ReportsWorkspace({
  services,
  budgets,
  selectedBudgetId,
  onSelectBudget,
  preferences,
}: {
  services: AppServices;
  budgets: MyBudgetView[] | null;
  selectedBudgetId?: string;
  onSelectBudget: (budgetId: string) => void;
  preferences: UserPreferencesRecord | null;
}) {
  const [localBudgetId, setLocalBudgetId] = useState('');
  const budgetId =
    (selectedBudgetId &&
    budgets?.some((budget) => budget.budget_id === selectedBudgetId)
      ? selectedBudgetId
      : undefined) ??
    (localBudgetId &&
    budgets?.some((budget) => budget.budget_id === localBudgetId)
      ? localBudgetId
      : undefined) ??
    budgets?.[0]?.budget_id ??
    '';
  const budget = budgets?.find((item) => item.budget_id === budgetId);
  const primaryCurrency = preferences?.primary_currency ?? '';
  const [transactionsSnapshot, setTransactionsSnapshot] =
    useState<Snapshot<TransactionView> | null>(null);
  const [categoriesSnapshot, setCategoriesSnapshot] =
    useState<Snapshot<CategoryView> | null>(null);
  const [accountsSnapshot, setAccountsSnapshot] =
    useState<Snapshot<AccountView> | null>(null);
  const [limitsSnapshot, setLimitsSnapshot] =
    useState<Snapshot<SpendingLimitView> | null>(null);
  const [balances, setBalances] = useState<AccountBalanceView[]>([]);
  const [conversionRates, setConversionRates] = useState<
    Record<string, Record<string, SavedRate>>
  >({});
  const requestedConversions = useRef(new Set<string>());
  const [dataError, setDataError] = useState<string | null>(null);
  const [month, setMonth] = useState(currentMonth);
  const [periodStart, setPeriodStart] = useState(
    () => monthPeriod(currentMonth()).start,
  );
  const [periodEnd, setPeriodEnd] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [pdfStartMonth, setPdfStartMonth] = useState(currentMonth);
  const [pdfEndMonth, setPdfEndMonth] = useState(currentMonth);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [pdfExportError, setPdfExportError] = useState<string | null>(null);
  const [pdfExportNotice, setPdfExportNotice] = useState<string | null>(null);
  const [comparisonMonth, setComparisonMonth] = useState(() =>
    previousMonth(currentMonth()),
  );
  const [horizon, setHorizon] = useState(6);
  const [limitMonth, setLimitMonth] = useState(currentMonth);
  const [limitScope, setLimitScope] =
    useState<SpendingLimitView['limit_scope']>('ALL_EXPENSES');
  const [limitCategoryId, setLimitCategoryId] = useState('');
  const [limitAmount, setLimitAmount] = useState('');
  const [savingLimit, setSavingLimit] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [limitNotice, setLimitNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!budgetId || !budget?.membership_id) return undefined;
    return services.data.subscribeTransactions(
      budgetId,
      budget.membership_id,
      (values) => setTransactionsSnapshot({ budgetId, values }),
      (failure) => setDataError(describeError(failure)),
    );
  }, [budgetId, budget?.membership_id, services.data]);

  useEffect(() => {
    if (!budgetId) return undefined;
    return services.data.subscribeCategories(
      budgetId,
      (values) => setCategoriesSnapshot({ budgetId, values }),
      (failure) => setDataError(describeError(failure)),
    );
  }, [budgetId, services.data]);

  useEffect(() => {
    if (!budgetId) return undefined;
    return services.data.subscribeBudgetAccounts(
      budgetId,
      (values) => setAccountsSnapshot({ budgetId, values }),
      (failure) => setDataError(describeError(failure)),
    );
  }, [budgetId, services.data]);

  useEffect(() => {
    if (!budgetId) return undefined;
    return services.data.subscribeSpendingLimits(
      budgetId,
      (values) => setLimitsSnapshot({ budgetId, values }),
      (failure) => setDataError(describeError(failure)),
    );
  }, [budgetId, services.data]);

  const accounts =
    accountsSnapshot?.budgetId === budgetId
      ? accountsSnapshot.values
      : EMPTY_ACCOUNTS;
  const accountIds = useMemo(
    () => accounts.map((account) => account.account_id).sort(),
    [accounts],
  );
  useEffect(
    () =>
      services.data.subscribeAccountBalances(
        accountIds,
        setBalances,
        (failure) => setDataError(describeError(failure)),
      ),
    [accountIds, services.data],
  );

  const transactions =
    transactionsSnapshot?.budgetId === budgetId
      ? transactionsSnapshot.values
      : EMPTY_TRANSACTIONS;
  const categories =
    categoriesSnapshot?.budgetId === budgetId
      ? categoriesSnapshot.values
      : EMPTY_CATEGORIES;
  const limits =
    limitsSnapshot?.budgetId === budgetId
      ? limitsSnapshot.values
      : EMPTY_LIMITS;
  const targetCurrencies = useMemo(
    () =>
      [...new Set([primaryCurrency, ...limits.map((limit) => limit.currency)])]
        .filter(Boolean)
        .sort(),
    [limits, primaryCurrency],
  );
  const comparisonPeriod = useMemo(
    () => monthPeriod(comparisonMonth),
    [comparisonMonth],
  );
  const estimatePeriod = (() => {
    if (!/^\d{4}-\d{2}$/.test(month) || ![3, 6, 12].includes(horizon)) {
      return null;
    }
    const [year, value] = month.split('-').map(Number);
    return {
      start: new Date(Date.UTC(year, value - 1 - horizon, 1))
        .toISOString()
        .slice(0, 10),
      end: new Date(Date.UTC(year, value - 1, 0)).toISOString().slice(0, 10),
    };
  })();
  const limitPeriod = /^\d{4}-\d{2}$/.test(limitMonth)
    ? monthPeriod(limitMonth)
    : null;
  const pdfPeriod = useMemo(
    () =>
      isValidMonth(pdfStartMonth) &&
      isValidMonth(pdfEndMonth) &&
      pdfStartMonth <= pdfEndMonth
        ? {
            start: monthPeriod(pdfStartMonth).start,
            end: monthPeriod(pdfEndMonth).end,
          }
        : null,
    [pdfEndMonth, pdfStartMonth],
  );
  const period = useMemo(
    () => periodFromInputs(periodStart, periodEnd),
    [periodEnd, periodStart],
  );
  const relevantPeriods = [
    period,
    comparisonPeriod,
    ...(pdfPeriod ? [pdfPeriod] : []),
    ...(estimatePeriod ? [estimatePeriod] : []),
    ...(limitPeriod ? [limitPeriod] : []),
  ];
  const relevantStart = relevantPeriods.every(isValidPeriod)
    ? relevantPeriods.reduce(
        (earliest, range) => (range.start < earliest ? range.start : earliest),
        relevantPeriods[0].start,
      )
    : '';
  const relevantEnd = relevantPeriods.every(isValidPeriod)
    ? relevantPeriods.reduce(
        (latest, range) => (range.end > latest ? range.end : latest),
        relevantPeriods[0].end,
      )
    : '';
  const relevantTransactions = useMemo(
    () =>
      transactions.filter(
        (transaction) =>
          transaction.operation_date >= relevantStart &&
          transaction.operation_date <= relevantEnd,
      ),
    [relevantEnd, relevantStart, transactions],
  );

  useEffect(() => {
    if (!budgetId || targetCurrencies.length === 0) return undefined;
    if (!relevantStart || !relevantEnd) return undefined;
    const pending = relevantTransactions.flatMap((transaction) =>
      transaction.type === 'TRANSFER'
        ? []
        : targetCurrencies.flatMap((target) => {
            if (transaction.currency === target) return [];
            const fingerprint = transactionFingerprint(transaction);
            if (
              conversionRates[target]?.[transaction.transaction_id]
                ?.fingerprint === fingerprint
            ) {
              return [];
            }
            const requestKey = `${target}|${transaction.transaction_id}|${fingerprint}`;
            if (requestedConversions.current.has(requestKey)) return [];
            requestedConversions.current.add(requestKey);
            return [{ transaction, target, fingerprint }];
          }),
    );
    if (!pending.length) return undefined;
    void Promise.all(
      pending.map(async ({ transaction, target, fingerprint }) => {
        try {
          const result = await services.backend.getTransactionConversions({
            budget_id: budgetId,
            transaction_id: transaction.transaction_id,
            target_currency: target,
          });
          const conversion = result.conversions.find(
            (item: TransactionConversionView) =>
              item.target_currency === target,
          );
          if (!conversion) {
            const message = result.unavailable_currencies.includes(target)
              ? `Brak kursu ${transaction.currency}/${target} dla ${transaction.operation_date}.`
              : `Nie otrzymano przeliczenia ${transaction.currency}/${target} dla ${transaction.operation_date}.`;
            setDataError(message);
            return;
          }
          setConversionRates((current) => ({
            ...current,
            [target]: {
              ...current[target],
              [transaction.transaction_id]: {
                fingerprint,
                rate: conversion.rate_used,
              },
            },
          }));
        } catch (failure) {
          setDataError(describeError(failure));
        }
      }),
    );
  }, [
    budgetId,
    conversionRates,
    services.backend,
    targetCurrencies,
    relevantEnd,
    relevantStart,
    relevantTransactions,
  ]);

  const reportRates = useMemo(
    () =>
      targetCurrencies.map((target) => [
        target,
        selectTargetRates(target, relevantTransactions, conversionRates),
      ]) as Array<[string, ConversionRates]>,
    [conversionRates, relevantTransactions, targetCurrencies],
  );
  const ratesByTarget = useMemo(
    () => Object.fromEntries(reportRates),
    [reportRates],
  );
  const missingConversion = relevantTransactions.some(
    (transaction) =>
      transaction.type !== 'TRANSFER' &&
      targetCurrencies.some(
        (target) =>
          transaction.currency !== target &&
          conversionRates[target]?.[transaction.transaction_id]?.fingerprint !==
            transactionFingerprint(transaction),
      ),
  );

  const currentReport = useMemo(() => {
    if (!primaryCurrency || missingConversion || !isValidPeriod(period)) {
      return null;
    }
    return aggregateReport(
      transactions,
      categories,
      period,
      primaryCurrency,
      ratesByTarget[primaryCurrency] ?? {},
    );
  }, [
    categories,
    missingConversion,
    period,
    primaryCurrency,
    ratesByTarget,
    transactions,
  ]);
  const reportNow = new Date();
  const viewerMembershipId = budget?.membership_id ?? '';
  const pdfReport =
    !primaryCurrency || missingConversion || !pdfPeriod
      ? null
      : {
          ...aggregateReport(
            maskTransactionsForMember(
              transactions,
              viewerMembershipId,
              reportNow,
            ),
            categories,
            pdfPeriod,
            primaryCurrency,
            ratesByTarget[primaryCurrency] ?? {},
          ),
          hidden_transactions_included: transactions.some(
            (transaction) =>
              transaction.operation_date >= pdfPeriod.start &&
              transaction.operation_date <= pdfPeriod.end &&
              isHiddenFromViewer(transaction, viewerMembershipId, reportNow),
          ),
        };
  const comparison = useMemo(() => {
    if (
      !primaryCurrency ||
      missingConversion ||
      !isValidPeriod(period) ||
      !isValidPeriod(comparisonPeriod)
    ) {
      return null;
    }
    return compareReportPeriods(
      transactions,
      categories,
      period,
      comparisonPeriod,
      primaryCurrency,
      ratesByTarget[primaryCurrency] ?? {},
    );
  }, [
    categories,
    comparisonPeriod,
    missingConversion,
    period,
    primaryCurrency,
    ratesByTarget,
    transactions,
  ]);
  const estimate = useMemo(() => {
    if (
      !primaryCurrency ||
      missingConversion ||
      !/^\d{4}-\d{2}$/.test(month) ||
      ![3, 6, 12].includes(horizon)
    ) {
      return null;
    }
    return estimateMonthlySavings(
      transactions,
      categories,
      month,
      horizon,
      primaryCurrency,
      ratesByTarget[primaryCurrency] ?? {},
    );
  }, [
    categories,
    horizon,
    missingConversion,
    month,
    primaryCurrency,
    ratesByTarget,
    transactions,
  ]);
  const limitUsages = useMemo(() => {
    if (missingConversion || !/^\d{4}-\d{2}$/.test(limitMonth)) return [];
    return limits.map(
      (limit) =>
        monthlyLimitUsage(
          transactions,
          [limit],
          limitMonth,
          limit.currency,
          ratesByTarget[limit.currency] ?? {},
        )[0],
    );
  }, [limitMonth, limits, missingConversion, ratesByTarget, transactions]);
  const officialSavings = savingsBalances(accounts, balances);
  const expenseCategories = categories.filter(
    (category) => category.kind === 'EXPENSE' && category.archived_at === null,
  );

  async function saveLimit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budgetId || !primaryCurrency) return;
    setSavingLimit(true);
    setLimitError(null);
    setLimitNotice(null);
    try {
      await services.backend.saveSpendingLimit({
        budget_id: budgetId,
        limit_scope: limitScope,
        category_id: limitScope === 'CATEGORY' ? limitCategoryId || null : null,
        period: 'MONTH',
        limit_amount: limitAmount,
        currency: primaryCurrency,
      });
      setLimitAmount('');
      setLimitNotice('Limit miesięczny został zapisany.');
    } catch (failure) {
      setLimitError(describeError(failure));
    } finally {
      setSavingLimit(false);
    }
  }

  async function exportPdfReport() {
    if (!pdfReport) {
      setPdfExportError('Wybierz prawidłowy zakres pełnych miesięcy raportu.');
      return;
    }
    setExportingPdf(true);
    setPdfExportError(null);
    setPdfExportNotice(null);
    try {
      const result = await window.electronApi.saveReportPdf({
        fileName: `raport-${pdfStartMonth}-${pdfEndMonth}`,
        report: pdfReport,
      });
      if (result.status === 'saved') {
        setPdfExportNotice(`Raport zapisano: ${result.filePath}`);
      } else if (result.status === 'canceled') {
        setPdfExportNotice(
          'Anulowano wybór lokalizacji; plik nie został utworzony.',
        );
      } else {
        setPdfExportError(result.error);
      }
    } catch (failure) {
      setPdfExportError(describeError(failure));
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <section
      className="dashboard-card reporting-workspace"
      aria-label="Raporty i oszczędności"
    >
      <div className="card-heading">
        <div>
          <p className="eyebrow">BUDŻETOWANIE</p>
          <h2>Raporty i oszczędności</h2>
        </div>
      </div>
      {budgets === null ? (
        <p role="status">Ładowanie budżetów…</p>
      ) : budgets.length === 0 ? (
        <p>Utwórz budżet, aby zobaczyć raporty.</p>
      ) : (
        <>
          <label>
            Budżet
            <select
              aria-label="Budżet raportu"
              value={budgetId}
              onChange={(event) => {
                setLocalBudgetId(event.target.value);
                onSelectBudget(event.target.value);
              }}
            >
              {budgets.map((item) => (
                <option key={item.budget_id} value={item.budget_id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!primaryCurrency && (
            <p role="alert">Nie udało się odczytać waluty prezentacji.</p>
          )}
          {dataError && <p role="alert">{dataError}</p>}
          {transactionsSnapshot?.budgetId !== budgetId ||
          categoriesSnapshot?.budgetId !== budgetId ||
          accountsSnapshot?.budgetId !== budgetId ||
          limitsSnapshot?.budgetId !== budgetId ? (
            <p role="status">Ładowanie danych raportowych…</p>
          ) : missingConversion ? (
            <p role="status">Przeliczanie walut dla raportu…</p>
          ) : (
            <>
              <section aria-label="Zakres raportu">
                <h3>Podsumowanie okresu</h3>
                <div className="transaction-form">
                  <label>
                    Od
                    <input
                      aria-label="Początek okresu raportu"
                      type="date"
                      value={periodStart}
                      onChange={(event) => setPeriodStart(event.target.value)}
                    />
                  </label>
                  <label>
                    Do
                    <input
                      aria-label="Koniec okresu raportu"
                      type="date"
                      value={periodEnd}
                      onChange={(event) => setPeriodEnd(event.target.value)}
                    />
                  </label>
                </div>
                <section aria-label="Eksport raportu PDF">
                  <h3>Eksport raportu do PDF</h3>
                  <div className="transaction-form">
                    <label>
                      Miesiąc początkowy PDF
                      <input
                        aria-label="Miesiąc początkowy PDF"
                        type="month"
                        value={pdfStartMonth}
                        onChange={(event) =>
                          setPdfStartMonth(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Miesiąc końcowy PDF
                      <input
                        aria-label="Miesiąc końcowy PDF"
                        type="month"
                        value={pdfEndMonth}
                        onChange={(event) => setPdfEndMonth(event.target.value)}
                      />
                    </label>
                  </div>
                  <p>
                    Zakres: {pdfPeriod?.start ?? '—'} – {pdfPeriod?.end ?? '—'}
                    {primaryCurrency ? ` · ${primaryCurrency}` : ''}
                  </p>
                  {pdfExportError && <p role="alert">{pdfExportError}</p>}
                  {pdfExportNotice && <p role="status">{pdfExportNotice}</p>}
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!pdfReport || exportingPdf}
                    onClick={() => void exportPdfReport()}
                  >
                    {exportingPdf ? 'Tworzenie PDF…' : 'Eksportuj raport PDF'}
                  </button>
                </section>
                {currentReport && (
                  <>
                    <p>
                      Dochody:{' '}
                      <strong>
                        {displayAmount(currentReport.income, primaryCurrency)}
                      </strong>
                    </p>
                    <p>
                      Wydatki:{' '}
                      <strong>
                        {displayAmount(currentReport.expenses, primaryCurrency)}
                      </strong>
                    </p>
                    <p>
                      Przepływ netto (dochody − wszystkie wydatki):{' '}
                      <strong>
                        {displayAmount(
                          currentReport.cash_flow,
                          primaryCurrency,
                        )}
                      </strong>
                    </p>
                    <p>
                      Koszty cykliczne:{' '}
                      {displayAmount(
                        currentReport.recurring_expenses,
                        primaryCurrency,
                      )}{' '}
                      · jednorazowe:{' '}
                      {displayAmount(
                        currentReport.one_time_expenses,
                        primaryCurrency,
                      )}
                    </p>
                    <h4>Wydatki według kategorii</h4>
                    {currentReport.expenses_by_category.length === 0 ? (
                      <p>Brak wydatków w wybranym okresie.</p>
                    ) : (
                      <ul aria-label="Wydatki według kategorii">
                        {currentReport.expenses_by_category.map((row) => (
                          <li key={row.category_id ?? 'unclassified'}>
                            {row.category_name}:{' '}
                            {displayAmount(row.amount, primaryCurrency)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {currentReport && (
                  <>
                    <h4>Koszty cykliczne według typu kategorii</h4>
                    <ul aria-label="Koszty cykliczne według typu kategorii">
                      <li>
                        Stałe:{' '}
                        {displayAmount(
                          currentReport.recurring_by_nature.FIXED,
                          primaryCurrency,
                        )}
                      </li>
                      <li>
                        Zmienne:{' '}
                        {displayAmount(
                          currentReport.recurring_by_nature.VARIABLE,
                          primaryCurrency,
                        )}
                      </li>
                      <li>
                        Uznaniowe:{' '}
                        {displayAmount(
                          currentReport.recurring_by_nature.DISCRETIONARY,
                          primaryCurrency,
                        )}
                      </li>
                      <li>
                        Bez klasyfikacji:{' '}
                        {displayAmount(
                          currentReport.recurring_by_nature.UNCLASSIFIED,
                          primaryCurrency,
                        )}
                      </li>
                    </ul>
                  </>
                )}
              </section>

              {comparison && (
                <section aria-label="Porównanie okresów">
                  <h3>Porównanie okresów</h3>
                  <label>
                    Miesiąc porównawczy
                    <input
                      aria-label="Miesiąc porównawczy"
                      type="month"
                      value={comparisonMonth}
                      onChange={(event) =>
                        setComparisonMonth(event.target.value)
                      }
                    />
                  </label>
                  <p>
                    Okres raportu {comparison.first.period.start}–
                    {comparison.first.period.end}: przychody{' '}
                    {displayAmount(comparison.first.income, primaryCurrency)},
                    wydatki{' '}
                    {displayAmount(comparison.first.expenses, primaryCurrency)}.
                  </p>
                  <p>
                    Okres porównawczy {comparison.second.period.start}–
                    {comparison.second.period.end}: przychody{' '}
                    {displayAmount(comparison.second.income, primaryCurrency)},
                    wydatki{' '}
                    {displayAmount(comparison.second.expenses, primaryCurrency)}
                    .
                  </p>
                  <p>
                    Różnica wydatków:{' '}
                    {displayAmount(comparison.expenses_change, primaryCurrency)}
                  </p>
                  <ul aria-label="Zmiana wydatków według kategorii">
                    {comparison.category_changes.map((row) => (
                      <li key={row.category_id ?? 'unclassified'}>
                        {row.category_name}:{' '}
                        {displayAmount(row.amount, primaryCurrency)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {currentReport && (
                <section aria-label="Limity miesięczne">
                  <h3>Limity miesięczne</h3>
                  <label>
                    Miesiąc wykorzystania
                    <input
                      aria-label="Miesiąc limitu"
                      type="month"
                      value={limitMonth}
                      onChange={(event) => setLimitMonth(event.target.value)}
                    />
                  </label>
                  {limitUsages.length === 0 ? (
                    <p>Brak zapisanych limitów dla budżetu.</p>
                  ) : (
                    <ul aria-label="Wykorzystanie limitów">
                      {limitUsages.map((usage) => (
                        <li key={usage.limit.spending_limit_id}>
                          {usage.limit.limit_scope === 'CATEGORY'
                            ? (categories.find(
                                (category) =>
                                  category.category_id ===
                                  usage.limit.category_id,
                              )?.name ?? 'Kategoria')
                            : usage.limit.limit_scope === 'ONE_TIME_EXPENSES'
                              ? 'Wydatki jednorazowe'
                              : 'Wszystkie wydatki'}
                          : {displayAmount(usage.spent, usage.limit.currency)} /{' '}
                          {displayAmount(
                            usage.limit.limit_amount,
                            usage.limit.currency,
                          )}{' '}
                          (
                          {usage.utilization_percent.toLocaleString('pl-PL', {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })}
                          %; pozostało{' '}
                          {displayAmount(usage.remaining, usage.limit.currency)}
                          )
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    className="transaction-form"
                    onSubmit={(event) => void saveLimit(event)}
                  >
                    <h4>Ustaw limit</h4>
                    <label>
                      Zakres limitu
                      <select
                        aria-label="Zakres nowego limitu"
                        value={limitScope}
                        onChange={(event) => {
                          const scope = event.target
                            .value as SpendingLimitView['limit_scope'];
                          setLimitScope(scope);
                          if (scope !== 'CATEGORY') setLimitCategoryId('');
                        }}
                      >
                        <option value="CATEGORY">Kategoria</option>
                        <option value="ALL_EXPENSES">Wszystkie wydatki</option>
                        <option value="ONE_TIME_EXPENSES">
                          Wydatki jednorazowe
                        </option>
                      </select>
                    </label>
                    {limitScope === 'CATEGORY' && (
                      <label>
                        Kategoria limitu
                        <select
                          aria-label="Kategoria limitu"
                          required
                          value={limitCategoryId}
                          onChange={(event) =>
                            setLimitCategoryId(event.target.value)
                          }
                        >
                          <option value="">Wybierz kategorię</option>
                          {expenseCategories.map((category) => (
                            <option
                              key={category.category_id}
                              value={category.category_id}
                            >
                              {category.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label>
                      Kwota limitu ({primaryCurrency})
                      <input
                        aria-label="Kwota limitu"
                        inputMode="decimal"
                        pattern="[+]?[0-9]{1,15}(\.[0-9]{1,4})?"
                        required
                        value={limitAmount}
                        onChange={(event) => setLimitAmount(event.target.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={savingLimit || !limitAmount}
                    >
                      {savingLimit ? 'Zapisywanie…' : 'Zapisz limit'}
                    </button>
                    {limitError && <p role="alert">{limitError}</p>}
                    {limitNotice && <p role="status">{limitNotice}</p>}
                  </form>
                </section>
              )}

              {currentReport && (
                <section aria-label="Szacunek oszczędności">
                  <h3>Szacunek potencjalnych oszczędności</h3>
                  <label>
                    Miesiąc odniesienia
                    <input
                      aria-label="Miesiąc odniesienia oszczędności"
                      type="month"
                      value={month}
                      onChange={(event) => setMonth(event.target.value)}
                    />
                  </label>
                  <label>
                    Horyzont historyczny
                    <select
                      aria-label="Horyzont historyczny"
                      value={horizon}
                      onChange={(event) =>
                        setHorizon(Number(event.target.value))
                      }
                    >
                      {[3, 6, 12].map((value) => (
                        <option key={value} value={value}>
                          {value} miesięcy
                        </option>
                      ))}
                    </select>
                  </label>
                  {estimate && (
                    <>
                      <p>
                        Średni potencjalny przepływ miesięczny:{' '}
                        <strong>
                          {displayAmount(
                            estimate.average_monthly_remaining,
                            primaryCurrency,
                          )}
                        </strong>
                      </p>
                      <p>
                        Horyzont: {estimate.horizon_months} miesięcy (
                        {estimate.period.start}–{estimate.period.end}). To
                        szacunek, nie kwota już odłożona.
                      </p>
                      <ul>
                        {estimate.assumptions.map((assumption) => (
                          <li key={assumption}>{assumption}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <h4>Rzeczywiste salda kont oszczędnościowych</h4>
                  {officialSavings.length === 0 ? (
                    <p>Brak zapisanych sald kont oszczędnościowych.</p>
                  ) : (
                    <ul aria-label="Rzeczywiste oszczędności">
                      {officialSavings.map((balance) => (
                        <li key={balance.account_id}>
                          {balance.account_label}:{' '}
                          {displayAmount(
                            balance.balance_amount,
                            balance.currency,
                          )}{' '}
                          · saldo z {balance.balance_date}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
