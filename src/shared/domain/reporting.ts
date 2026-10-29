import type {
  AccountBalanceView,
  CategoryView,
  ExpenseNature,
  SpendingLimitView,
  TransactionView,
} from '../contracts';
import { roundHalfUp, sumDecimals, multiplyDecimals } from './currency';
import { transactionLinesForReporting } from './transactionFeatures';
import { latestBalancePerAccount } from './transfers';

export interface ReportPeriod {
  start: string;
  end: string;
}

export interface CategoryReportRow {
  category_id: string | null;
  category_name: string;
  expense_nature: ExpenseNature | null;
  amount: string;
}

export interface ReportSummary {
  period: ReportPeriod;
  currency: string;
  income: string;
  expenses: string;
  cash_flow: string;
  recurring_expenses: string;
  recurring_by_nature: Record<ExpenseNature | 'UNCLASSIFIED', string>;
  one_time_expenses: string;
  expenses_by_category: CategoryReportRow[];
}

export interface PeriodComparison {
  first: ReportSummary;
  second: ReportSummary;
  income_change: string;
  expenses_change: string;
  cash_flow_change: string;
  category_changes: CategoryReportRow[];
}

export interface LimitUsage {
  limit: SpendingLimitView;
  spent: string;
  remaining: string;
  utilization_percent: number;
}

export interface SavingsEstimate {
  horizon_months: number;
  period: ReportPeriod;
  total_remaining: string;
  average_monthly_remaining: string;
  assumptions: string[];
}

export interface SavingsBalance {
  account_id: string;
  account_label: string;
  balance_amount: string;
  currency: string;
  balance_date: string;
}

interface ReportableLine {
  transaction: TransactionView;
  amount: string;
  category_id: string | null;
  expense_frequency: TransactionView['expense_frequency'];
}

export type ConversionRates = Readonly<Record<string, string>>;

const EMPTY_NATURE_TOTALS: ReportSummary['recurring_by_nature'] = {
  FIXED: '0.0000',
  VARIABLE: '0.0000',
  DISCRETIONARY: '0.0000',
  UNCLASSIFIED: '0.0000',
};

function absoluteAmount(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value.replace(/^\+/, '');
}

function roundedSum(values: readonly string[]): string {
  return roundHalfUp(sumDecimals(values), 4);
}

function convertedAmount(
  amount: string,
  transactionId: string,
  currency: string,
  targetCurrency: string,
  rates: ConversionRates,
): string {
  if (currency === targetCurrency) return amount;
  const rate = rates[transactionId];
  if (!rate) {
    throw new Error(
      `Brak przeliczenia z ${currency} na ${targetCurrency} dla raportu.`,
    );
  }
  return multiplyDecimals(amount, rate);
}

function linesFor(transactions: readonly TransactionView[]): ReportableLine[] {
  const transactionsById = new Map(
    transactions.map((transaction) => [
      transaction.transaction_id,
      transaction,
    ]),
  );
  return transactionLinesForReporting(transactions).flatMap((line) => {
    const transaction = transactionsById.get(line.transaction_id);
    if (!transaction || transaction.type === 'TRANSFER') return [];
    return [
      {
        transaction,
        amount: line.amount,
        category_id: line.category_id,
        expense_frequency:
          line.expense_frequency ?? transaction.expense_frequency ?? null,
      },
    ];
  });
}

function inPeriod(transaction: TransactionView, period: ReportPeriod): boolean {
  return (
    transaction.operation_date >= period.start &&
    transaction.operation_date <= period.end
  );
}

function summarize(
  transactions: readonly TransactionView[],
  categories: readonly CategoryView[],
  period: ReportPeriod,
  currency: string,
  rates: ConversionRates,
): ReportSummary {
  const categoriesById = new Map(
    categories.map((category) => [category.category_id, category]),
  );
  const incomeAmounts: string[] = [];
  const expenseAmounts: string[] = [];
  const recurringAmounts: string[] = [];
  const oneTimeAmounts: string[] = [];
  const recurringByNature = { ...EMPTY_NATURE_TOTALS };
  const categoryAmounts = new Map<string, string[]>();

  for (const line of linesFor(transactions)) {
    if (!inPeriod(line.transaction, period)) continue;
    const amount = absoluteAmount(
      convertedAmount(
        line.amount,
        line.transaction.transaction_id,
        line.transaction.currency,
        currency,
        rates,
      ),
    );
    if (line.transaction.type === 'INCOME') {
      incomeAmounts.push(amount);
      continue;
    }

    expenseAmounts.push(amount);
    const categoryId = line.category_id;
    const category = categoryId ? categoriesById.get(categoryId) : undefined;
    const categoryKey = categoryId ?? '';
    const amounts = categoryAmounts.get(categoryKey) ?? [];
    amounts.push(amount);
    categoryAmounts.set(categoryKey, amounts);

    if (line.expense_frequency === 'ONE_TIME') oneTimeAmounts.push(amount);
    if (line.expense_frequency === 'RECURRING') {
      recurringAmounts.push(amount);
      const nature = category?.expense_nature ?? 'UNCLASSIFIED';
      recurringByNature[nature] = roundedSum([
        recurringByNature[nature],
        amount,
      ]);
    }
  }

  const income = roundedSum(incomeAmounts);
  const expenses = roundedSum(expenseAmounts);
  return {
    period,
    currency,
    income,
    expenses,
    cash_flow: roundHalfUp(sumDecimals([income, `-${expenses}`]), 4),
    recurring_expenses: roundedSum(recurringAmounts),
    recurring_by_nature: recurringByNature,
    one_time_expenses: roundedSum(oneTimeAmounts),
    expenses_by_category: [...categoryAmounts.entries()]
      .map(([categoryId, amounts]) => {
        const category = categoryId ? categoriesById.get(categoryId) : null;
        return {
          category_id: categoryId || null,
          category_name: category?.name ?? 'Ukryta lub bez kategorii',
          expense_nature: category?.expense_nature ?? null,
          amount: roundedSum(amounts),
        };
      })
      .sort((left, right) =>
        left.category_name.localeCompare(right.category_name, 'pl'),
      ),
  };
}

export function aggregateReport(
  transactions: readonly TransactionView[],
  categories: readonly CategoryView[],
  period: ReportPeriod,
  currency: string,
  rates: ConversionRates = {},
): ReportSummary {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(period.start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(period.end) ||
    period.start > period.end
  ) {
    throw new Error('Nieprawidłowy zakres dat raportu.');
  }
  if (!currency) throw new Error('Raport wymaga waluty prezentacji.');
  return summarize(transactions, categories, period, currency, rates);
}

export function compareReportPeriods(
  transactions: readonly TransactionView[],
  categories: readonly CategoryView[],
  firstPeriod: ReportPeriod,
  secondPeriod: ReportPeriod,
  currency: string,
  rates: ConversionRates = {},
): PeriodComparison {
  const first = aggregateReport(
    transactions,
    categories,
    firstPeriod,
    currency,
    rates,
  );
  const second = aggregateReport(
    transactions,
    categories,
    secondPeriod,
    currency,
    rates,
  );
  const firstByCategory = new Map(
    first.expenses_by_category.map((row) => [row.category_id, row]),
  );
  const secondByCategory = new Map(
    second.expenses_by_category.map((row) => [row.category_id, row]),
  );
  const categoryIds = new Set([
    ...firstByCategory.keys(),
    ...secondByCategory.keys(),
  ]);
  return {
    first,
    second,
    income_change: roundHalfUp(
      sumDecimals([second.income, `-${first.income}`]),
      4,
    ),
    expenses_change: roundHalfUp(
      sumDecimals([second.expenses, `-${first.expenses}`]),
      4,
    ),
    cash_flow_change: roundHalfUp(
      sumDecimals([second.cash_flow, `-${first.cash_flow}`]),
      4,
    ),
    category_changes: [...categoryIds].map((categoryId) => {
      const before = firstByCategory.get(categoryId);
      const after = secondByCategory.get(categoryId);
      return {
        category_id: categoryId,
        category_name:
          after?.category_name ?? before?.category_name ?? 'Bez kategorii',
        expense_nature: after?.expense_nature ?? before?.expense_nature ?? null,
        amount: roundHalfUp(
          sumDecimals([after?.amount ?? '0', `-${before?.amount ?? '0'}`]),
          4,
        ),
      };
    }),
  };
}

export function monthlyLimitUsage(
  transactions: readonly TransactionView[],
  limits: readonly SpendingLimitView[],
  month: string,
  currency: string,
  rates: ConversionRates = {},
): LimitUsage[] {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Limit miesięczny wymaga prawidłowego miesiąca.');
  }
  const start = `${month}-01`;
  const end = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
  const eligible = linesFor(transactions).filter(
    ({ transaction }) =>
      transaction.type === 'EXPENSE' && inPeriod(transaction, { start, end }),
  );
  return limits.map((limit) => {
    if (limit.period !== 'MONTH') {
      throw new Error('Nieobsługiwany okres limitu.');
    }
    if (limit.limit_scope === 'CATEGORY' && !limit.category_id) {
      throw new Error('Limit kategorii wymaga kategorii.');
    }
    if (limit.limit_scope !== 'CATEGORY' && limit.category_id) {
      throw new Error('Limit ogólny nie może wskazywać kategorii.');
    }
    if (limit.currency !== currency) {
      throw new Error(
        `Waluta limitu ${limit.currency} różni się od waluty raportu ${currency}.`,
      );
    }
    const spent = roundedSum(
      eligible
        .filter(({ category_id, expense_frequency }) => {
          if (limit.limit_scope === 'CATEGORY') {
            return category_id === limit.category_id;
          }
          if (limit.limit_scope === 'ONE_TIME_EXPENSES') {
            return expense_frequency === 'ONE_TIME';
          }
          return true;
        })
        .map(({ transaction, amount }) =>
          absoluteAmount(
            convertedAmount(
              amount,
              transaction.transaction_id,
              transaction.currency,
              currency,
              rates,
            ),
          ),
        ),
    );
    const remaining = roundHalfUp(
      sumDecimals([limit.limit_amount, `-${spent}`]),
      4,
    );
    const limitAmount = Number(limit.limit_amount);
    return {
      limit,
      spent,
      remaining,
      utilization_percent:
        limitAmount === 0 ? 0 : (Number(spent) / limitAmount) * 100,
    };
  });
}

export function estimateMonthlySavings(
  transactions: readonly TransactionView[],
  categories: readonly CategoryView[],
  anchorMonth: string,
  horizonMonths: number,
  currency: string,
  rates: ConversionRates = {},
): SavingsEstimate {
  if (
    !/^\d{4}-\d{2}$/.test(anchorMonth) ||
    ![3, 6, 12].includes(horizonMonths)
  ) {
    throw new Error('Nieprawidłowy miesiąc lub horyzont szacunku.');
  }
  const [year, month] = anchorMonth.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1 - horizonMonths, 1));
  const lastDay = new Date(Date.UTC(year, month - 1, 0));
  const period = {
    start: firstDay.toISOString().slice(0, 10),
    end: lastDay.toISOString().slice(0, 10),
  };
  const summary = aggregateReport(
    transactions,
    categories,
    period,
    currency,
    rates,
  );
  const average = roundHalfUp(
    divideDecimalByInteger(summary.cash_flow, horizonMonths),
    4,
  );
  return {
    horizon_months: horizonMonths,
    period,
    total_remaining: summary.cash_flow,
    average_monthly_remaining: average,
    assumptions: [
      `Średnia obejmuje ${horizonMonths} pełnych miesięcy: ${period.start}–${period.end}.`,
      'Dochody pomniejszono o wszystkie wydatki, także nieregularne i jednorazowe.',
      'Szacunek opisuje potencjalnie pozostałe środki; nie jest zapisanym saldem oszczędności.',
    ],
  };
}

function divideDecimalByInteger(value: string, divisor: number): string {
  const sign = value.startsWith('-') ? -1n : 1n;
  const unsigned = value.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  const magnitude = units < 0n ? -units : units;
  const quotient = magnitude / BigInt(divisor);
  const remainder = magnitude % BigInt(divisor);
  const rounded = remainder * 2n >= BigInt(divisor) ? quotient + 1n : quotient;
  const result = sign * rounded;
  return `${result < 0n ? '-' : ''}${(result < 0n ? -result : result) / 10_000n}.${((result < 0n ? -result : result) % 10_000n).toString().padStart(4, '0')}`;
}

export function savingsBalances(
  accounts: readonly {
    account_id: string;
    label: string;
    account_type: string;
  }[],
  balances: readonly AccountBalanceView[],
): SavingsBalance[] {
  const latest = latestBalancePerAccount(balances);
  return accounts
    .filter((account) => account.account_type === 'SAVINGS')
    .flatMap((account) => {
      const balance = latest.get(account.account_id);
      return balance
        ? [
            {
              account_id: account.account_id,
              account_label: account.label,
              balance_amount: balance.balance_amount,
              currency: balance.currency,
              balance_date: balance.balance_date,
            },
          ]
        : [];
    });
}
