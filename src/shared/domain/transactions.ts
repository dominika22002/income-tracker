import type {
  CategorizationMatchField,
  CategorizationMatchOperator,
  StatementTransactionType,
  TransactionView,
} from '../contracts';

export type TransactionSortField =
  'operation_date' | 'amount' | 'category' | 'description' | 'type';

export interface TransactionFilters {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: string;
  maxAmount?: string;
  categoryId?: string;
  type?: StatementTransactionType | '';
}

export interface TransactionSort {
  field: TransactionSortField;
  direction: 'asc' | 'desc';
}

export interface CategorizationCandidate {
  rule_id: string;
  category_id: string;
  match_field: CategorizationMatchField;
  operator: CategorizationMatchOperator;
  match_value: string;
  priority: number;
  enabled: boolean;
}

export interface TransactionMatchInput {
  description: string;
  amount: string;
  account_id: string;
}

export interface LocalCategoryCorrection {
  description: string;
  category_id: string;
  count: number;
}

export function normalizeTransactionText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function decimalUnits(value: string): bigint | null {
  if (!/^[+-]?\d{1,15}(?:\.\d{1,4})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  return negative ? -units : units;
}

export function compareDecimalAmounts(left: string, right: string): number {
  const leftUnits = decimalUnits(left);
  const rightUnits = decimalUnits(right);
  if (leftUnits === null || rightUnits === null) {
    return left.localeCompare(right, undefined, { numeric: true });
  }
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

export function filterAndSortTransactions(
  transactions: readonly TransactionView[],
  filters: TransactionFilters,
  sort: TransactionSort,
): TransactionView[] {
  const search = normalizeTransactionText(filters.search ?? '');
  const filtered = transactions.filter((transaction) => {
    if (
      search &&
      !normalizeTransactionText(transaction.description).includes(search)
    ) {
      return false;
    }
    if (filters.dateFrom && transaction.operation_date < filters.dateFrom) {
      return false;
    }
    if (filters.dateTo && transaction.operation_date > filters.dateTo) {
      return false;
    }
    if (
      filters.minAmount &&
      compareDecimalAmounts(transaction.amount, filters.minAmount) < 0
    ) {
      return false;
    }
    if (
      filters.maxAmount &&
      compareDecimalAmounts(transaction.amount, filters.maxAmount) > 0
    ) {
      return false;
    }
    if (filters.categoryId && transaction.category_id !== filters.categoryId) {
      return false;
    }
    if (filters.type && transaction.type !== filters.type) return false;
    return true;
  });

  const multiplier = sort.direction === 'asc' ? 1 : -1;
  return filtered.sort((left, right) => {
    let comparison = 0;
    switch (sort.field) {
      case 'operation_date':
        comparison = left.operation_date.localeCompare(right.operation_date);
        break;
      case 'amount':
        comparison = compareDecimalAmounts(left.amount, right.amount);
        break;
      case 'category':
        comparison = (left.category_name ?? '').localeCompare(
          right.category_name ?? '',
          'pl',
        );
        break;
      case 'description':
        comparison = left.description.localeCompare(right.description, 'pl');
        break;
      case 'type':
        comparison = left.type.localeCompare(right.type);
        break;
    }
    return comparison === 0
      ? left.transaction_id.localeCompare(right.transaction_id)
      : comparison * multiplier;
  });
}

function matches(
  actualValue: string,
  operator: CategorizationMatchOperator,
  expectedValue: string,
): boolean {
  const actual = normalizeTransactionText(actualValue);
  const expected = normalizeTransactionText(expectedValue);
  if (!actual || !expected) return false;
  if (operator === 'EQUALS') return actual === expected;
  if (operator === 'STARTS_WITH') return actual.startsWith(expected);
  return actual.includes(expected);
}

function ruleMatches(
  rule: CategorizationCandidate,
  transaction: TransactionMatchInput,
): boolean {
  if (!rule.enabled) return false;
  switch (rule.match_field) {
    case 'DESCRIPTION':
      return matches(transaction.description, rule.operator, rule.match_value);
    case 'ACCOUNT':
      return (
        rule.operator === 'EQUALS' &&
        matches(transaction.account_id, rule.operator, rule.match_value)
      );
    case 'AMOUNT':
      return (
        rule.operator === 'EQUALS' &&
        compareDecimalAmounts(transaction.amount, rule.match_value) === 0
      );
  }
}

function ruleSpecificity(rule: CategorizationCandidate): number {
  if (rule.match_field !== 'DESCRIPTION') return 3;
  if (rule.operator === 'EQUALS') return 3;
  if (rule.operator === 'STARTS_WITH') return 2;
  return 1;
}

export function findMatchingUserRule(
  transaction: TransactionMatchInput,
  rules: readonly CategorizationCandidate[],
): CategorizationCandidate | null {
  return (
    [...rules]
      .filter((rule) => ruleMatches(rule, transaction))
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          ruleSpecificity(right) - ruleSpecificity(left) ||
          left.rule_id.localeCompare(right.rule_id),
      )[0] ?? null
  );
}

export function suggestAutomaticCategory(
  transaction: TransactionMatchInput & { category_id?: string | null },
  rules: readonly CategorizationCandidate[],
): string | null {
  if (transaction.category_id) return null;
  return findMatchingUserRule(transaction, rules)?.category_id ?? null;
}

export function recordLocalCorrection(
  corrections: readonly LocalCategoryCorrection[],
  description: string,
  categoryId: string,
): LocalCategoryCorrection[] {
  const key = normalizeTransactionText(description);
  if (!key || !categoryId) return [...corrections];
  const existing = corrections.find(
    (correction) =>
      normalizeTransactionText(correction.description) === key &&
      correction.category_id === categoryId,
  );
  if (existing) {
    return corrections.map((correction) =>
      correction === existing
        ? { ...correction, count: correction.count + 1 }
        : correction,
    );
  }
  return [
    ...corrections,
    { description: key, category_id: categoryId, count: 1 },
  ];
}

export function suggestLearnedCategory(
  corrections: readonly LocalCategoryCorrection[],
  description: string,
  currentCategoryId?: string | null,
): string | null {
  if (currentCategoryId) return null;
  const key = normalizeTransactionText(description);
  const candidates = corrections
    .filter((correction) => correction.description === key)
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.category_id.localeCompare(right.category_id),
    );
  return candidates[0]?.category_id ?? null;
}

export function isTransactionType(
  value: unknown,
): value is StatementTransactionType {
  return value === 'EXPENSE' || value === 'INCOME' || value === 'TRANSFER';
}
