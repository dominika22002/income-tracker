import ExcelJS from 'exceljs';
import type {
  AccountView,
  CategorizationRuleView,
  CategoryView,
  TransactionView,
  UserPreferencesRecord,
} from '../contracts';
import {
  isHiddenFromViewer,
  transactionLinesForExport,
  transactionsVisibleToMember,
  type TransactionExportLine,
} from './transactionFeatures';
import {
  filterAndSortTransactions,
  type TransactionFilters,
  type TransactionSort,
} from './transactions';

export interface TransactionExportRow {
  date: string;
  description: string;
  type: string;
  amount: string;
  currency: string;
  category: string;
  visibility: string;
}

export interface TransactionExportScope {
  filters: TransactionFilters;
  sort: TransactionSort;
}

export interface ConfigurationExport {
  schema_version: 1;
  application_settings: {
    primary_currency: string;
    secondary_currencies: string[];
  };
  currencies: string[];
  budget: {
    name: string;
    categories: Array<{
      category_id: string;
      parent_category_id: string | null;
      name: string;
      kind: CategoryView['kind'];
      expense_nature: CategoryView['expense_nature'];
      sort_order: number;
      archived: boolean;
    }>;
    categorization_rules: Array<{
      rule_id: string;
      category_id: string;
      category_name: string;
      source: CategorizationRuleView['source'];
      match_field: CategorizationRuleView['match_field'];
      operator: CategorizationRuleView['operator'];
      match_value: string;
      priority: number;
      enabled: boolean;
    }>;
  };
}

const EMPTY_SORT: TransactionSort = {
  field: 'operation_date',
  direction: 'desc',
};

function isDateOnlyFilter(filters: TransactionFilters): boolean {
  return (
    !filters.search?.trim() &&
    !filters.minAmount &&
    !filters.maxAmount &&
    !filters.categoryId &&
    !filters.type
  );
}

function selectedTransactions(
  transactions: readonly TransactionView[],
  viewerMembershipId: string,
  now: Date,
  filters: TransactionFilters,
  sort: TransactionSort,
): TransactionView[] {
  const visible = transactionsVisibleToMember(
    transactions,
    viewerMembershipId,
    now,
  );
  const selected = filterAndSortTransactions(visible, filters, sort);
  if (!isDateOnlyFilter(filters)) return selected;

  const visibleIds = new Set(
    visible.map((transaction) => transaction.transaction_id),
  );
  const hidden = transactions.filter(
    (transaction) =>
      !visibleIds.has(transaction.transaction_id) &&
      transaction.hidden_mode === 'TRANSACTION' &&
      isHiddenFromViewer(transaction, viewerMembershipId, now) &&
      (!filters.dateFrom || transaction.operation_date >= filters.dateFrom) &&
      (!filters.dateTo || transaction.operation_date <= filters.dateTo),
  );
  return [...selected, ...hidden];
}

function toExportRow(line: TransactionExportLine): TransactionExportRow {
  return {
    date: line.operation_date,
    description: line.description,
    type: line.type ?? '',
    amount: line.amount,
    currency: line.currency,
    category: line.category_name ?? '',
    visibility: line.hidden ? 'Ukryta' : 'Widoczna',
  };
}

export function transactionExportRows(
  transactions: readonly TransactionView[],
  categories: readonly CategoryView[],
  viewerMembershipId: string,
  now: Date,
  scope: TransactionExportScope = { filters: {}, sort: EMPTY_SORT },
): TransactionExportRow[] {
  const selected = selectedTransactions(
    transactions,
    viewerMembershipId,
    now,
    scope.filters,
    scope.sort,
  );
  return transactionLinesForExport(
    selected,
    viewerMembershipId,
    now,
    categories,
  ).map(toExportRow);
}

function protectSpreadsheetText(value: string): string {
  return /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
}

function csvCell(value: string, text = false): string {
  const safeValue = text ? protectSpreadsheetText(value) : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function transactionRowsToCsv(
  rows: readonly TransactionExportRow[],
): string {
  const header = [
    'Data',
    'Opis',
    'Typ',
    'Kwota',
    'Waluta źródłowa',
    'Kategoria',
    'Widoczność',
  ];
  const body = rows.map((row) =>
    [
      csvCell(row.date),
      csvCell(row.description, true),
      csvCell(row.type),
      csvCell(row.amount),
      csvCell(row.currency),
      csvCell(row.category, true),
      csvCell(row.visibility),
    ].join(','),
  );
  return `\uFEFF${[header.map((cell) => csvCell(cell, true)).join(','), ...body].join('\r\n')}\r\n`;
}

export async function transactionRowsToXlsx(
  rows: readonly TransactionExportRow[],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Income Tracker';
  workbook.subject = 'Eksport transakcji';
  const worksheet = workbook.addWorksheet('Transakcje');
  worksheet.columns = [
    { header: 'Data', key: 'date', width: 14 },
    { header: 'Opis', key: 'description', width: 36 },
    { header: 'Typ', key: 'type', width: 16 },
    { header: 'Kwota', key: 'amount', width: 18 },
    { header: 'Waluta źródłowa', key: 'currency', width: 18 },
    { header: 'Kategoria', key: 'category', width: 28 },
    { header: 'Widoczność', key: 'visibility', width: 16 },
  ];
  worksheet.addRows(
    rows.map((row) => ({
      ...row,
      description: protectSpreadsheetText(row.description),
      category: protectSpreadsheetText(row.category),
    })),
  );
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  const content = await workbook.xlsx.writeBuffer();
  return new Uint8Array(content);
}

export function configurationToJson(
  preferences: UserPreferencesRecord,
  budgetName: string,
  accounts: readonly AccountView[],
  categories: readonly CategoryView[],
  rules: readonly CategorizationRuleView[],
): string {
  const categoryIds = new Set(
    categories.map((category) => category.category_id),
  );
  const output: ConfigurationExport = {
    schema_version: 1,
    application_settings: {
      primary_currency: preferences.primary_currency,
      secondary_currencies: [...preferences.secondary_currencies],
    },
    currencies: [
      ...new Set([
        preferences.primary_currency,
        ...preferences.secondary_currencies,
        ...accounts.map((account) => account.currency),
      ]),
    ].sort(),
    budget: {
      name: budgetName,
      categories: categories
        .map((category) => ({
          category_id: category.category_id,
          parent_category_id: category.parent_category_id,
          name: category.name,
          kind: category.kind,
          expense_nature: category.expense_nature,
          sort_order: category.sort_order,
          archived: category.archived_at !== null,
        }))
        .sort(
          (left, right) =>
            left.sort_order - right.sort_order ||
            left.name.localeCompare(right.name, 'pl'),
        ),
      categorization_rules: rules
        .filter((rule) => categoryIds.has(rule.category_id))
        .map((rule) => ({
          rule_id: rule.rule_id,
          category_id: rule.category_id,
          category_name: rule.category_name,
          source: rule.source,
          match_field: rule.match_field,
          operator: rule.operator,
          match_value: rule.match_value,
          priority: rule.priority,
          enabled: rule.enabled,
        }))
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.rule_id.localeCompare(right.rule_id),
        ),
    },
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}
