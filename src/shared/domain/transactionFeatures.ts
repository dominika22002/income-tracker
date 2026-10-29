import type {
  CategoryView,
  ExpenseFrequency,
  SplitItemInput,
  SplitItemView,
  TransactionView,
} from '../contracts';

const AMOUNT_PATTERN = /^[+-]?\d{1,15}(?:\.\d{1,4})?$/;
const SCALE = 10_000n;

function amountUnits(value: string): bigint | null {
  if (!AMOUNT_PATTERN.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
  return negative ? -units : units;
}

function formatUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(4, '0');
  return `${sign}${whole}.${fraction}`;
}

export function splitAmountTotal(
  items: readonly Pick<SplitItemInput, 'amount'>[],
): string | null {
  let total = 0n;
  for (const item of items) {
    const units = amountUnits(item.amount);
    if (units === null) return null;
    total += units;
  }
  return formatUnits(total);
}

export function remainingSplitAmount(
  sourceAmount: string,
  items: readonly Pick<SplitItemInput, 'amount'>[],
): string | null {
  const source = amountUnits(sourceAmount);
  const total = splitAmountTotal(items);
  const totalUnits = total === null ? null : amountUnits(total);
  if (source === null || totalUnits === null) return null;
  return formatUnits(source - totalUnits);
}

export function isSplitValid(
  sourceAmount: string,
  items: readonly SplitItemInput[],
): boolean {
  const total = splitAmountTotal(items);
  return (
    items.length >= 2 &&
    total !== null &&
    amountUnits(total) === amountUnits(sourceAmount)
  );
}

export type HiddenDuration = 'DAY' | 'WEEK' | 'MONTH';

export function hiddenUntilForPreset(
  now: Date,
  duration: HiddenDuration,
): Date {
  const until = new Date(now.getTime());
  if (duration === 'DAY') {
    until.setUTCDate(until.getUTCDate() + 1);
    return until;
  }
  if (duration === 'WEEK') {
    until.setUTCDate(until.getUTCDate() + 7);
    return until;
  }
  const targetMonth = until.getUTCMonth() + 1;
  const day = until.getUTCDate();
  until.setUTCDate(1);
  until.setUTCMonth(targetMonth);
  const lastDay = new Date(
    Date.UTC(until.getUTCFullYear(), until.getUTCMonth() + 1, 0),
  ).getUTCDate();
  until.setUTCDate(Math.min(day, lastDay));
  return until;
}

export function splitItemsInSourceCurrency(
  items: readonly SplitItemView[],
  sourceCurrency: string,
): Array<SplitItemView & { currency: string }> {
  return items.map((item) => ({ ...item, currency: sourceCurrency }));
}

export function isTransactionHidden(
  mode: TransactionView['hidden_mode'] | null | undefined,
  hiddenUntil: string | null | undefined,
  now: Date,
): boolean {
  if (!mode) return false;
  if (hiddenUntil == null) return true;
  const expiry = Date.parse(hiddenUntil);
  return Number.isFinite(expiry) && now.getTime() < expiry;
}

export function isHiddenFromViewer(
  transaction: Pick<
    TransactionView,
    'hidden_mode' | 'hidden_until' | 'hidden_by_membership_id'
  > &
    Pick<TransactionView, 'hidden_for_viewer'>,
  viewerMembershipId: string,
  now: Date,
): boolean {
  if (
    !isTransactionHidden(transaction.hidden_mode, transaction.hidden_until, now)
  ) {
    return false;
  }
  if (transaction.hidden_for_viewer !== undefined) {
    return transaction.hidden_for_viewer;
  }
  return transaction.hidden_by_membership_id !== viewerMembershipId;
}

export function maskTransactionsForMember(
  transactions: readonly TransactionView[],
  viewerMembershipId: string,
  now: Date,
): TransactionView[] {
  return transactions.map((transaction) => {
    const hiddenForViewer = isHiddenFromViewer(
      { ...transaction, hidden_for_viewer: undefined },
      viewerMembershipId,
      now,
    );
    if (!hiddenForViewer) {
      return {
        ...transaction,
        hidden_by_membership_id:
          transaction.hidden_by_membership_id === viewerMembershipId
            ? transaction.hidden_by_membership_id
            : null,
        hidden_for_viewer: false,
      };
    }
    return {
      ...transaction,
      description:
        transaction.hidden_mode === 'DESCRIPTION' ? 'Opis ukryty' : '',
      note: null,
      tags: [],
      category_id:
        transaction.hidden_mode === 'TRANSACTION'
          ? null
          : transaction.category_id,
      category_name:
        transaction.hidden_mode === 'TRANSACTION'
          ? null
          : transaction.category_name,
      expense_frequency:
        transaction.hidden_mode === 'TRANSACTION'
          ? null
          : transaction.expense_frequency,
      hidden_by_membership_id: null,
      hidden_for_viewer: true,
      split_items: transaction.split_items?.map((item) => ({
        ...item,
        category_id:
          transaction.hidden_mode === 'TRANSACTION' ? null : item.category_id,
        expense_frequency:
          transaction.hidden_mode === 'TRANSACTION'
            ? null
            : item.expense_frequency,
        description: null,
        note: null,
      })),
    };
  });
}

export function transactionsVisibleToMember(
  transactions: readonly TransactionView[],
  viewerMembershipId: string,
  now: Date,
): TransactionView[] {
  return transactions.flatMap((transaction) => {
    if (!isHiddenFromViewer(transaction, viewerMembershipId, now)) {
      return [transaction];
    }
    if (transaction.hidden_mode === 'TRANSACTION') return [];
    return [
      {
        ...transaction,
        description: 'Opis ukryty',
        note: null,
        tags: [],
        split_items: transaction.split_items?.map((item) => ({
          ...item,
          description: null,
          note: null,
        })),
      },
    ];
  });
}

export function nextHiddenExpiry(
  transactions: readonly TransactionView[],
  viewerMembershipId: string,
  now: Date,
): number | null {
  const expiries = transactions
    .filter((transaction) =>
      isHiddenFromViewer(transaction, viewerMembershipId, now),
    )
    .map((transaction) =>
      transaction.hidden_until ? Date.parse(transaction.hidden_until) : NaN,
    )
    .filter((expiry) => Number.isFinite(expiry) && expiry > now.getTime());
  return expiries.length ? Math.min(...expiries) : null;
}

export interface ReportTransactionLine {
  transaction_id: string;
  split_item_id: string | null;
  amount: string;
  currency: string;
  category_id: string | null;
  expense_frequency: ExpenseFrequency | null;
}

export interface TransactionExportLine extends ReportTransactionLine {
  operation_date: string;
  type: TransactionView['type'] | null;
  description: string;
  note: string | null;
  category_name: string | null;
  hidden: boolean;
}

export function transactionLinesForReporting(
  transactions: readonly TransactionView[],
): ReportTransactionLine[] {
  return transactions.flatMap<ReportTransactionLine>((transaction) => {
    const items = transaction.split_items ?? [];
    if (items.length === 0) {
      return [
        {
          transaction_id: transaction.transaction_id,
          split_item_id: null,
          amount: transaction.amount,
          currency: transaction.currency,
          category_id: transaction.category_id,
          expense_frequency: transaction.expense_frequency ?? null,
        },
      ];
    }
    return items.map((item) => ({
      transaction_id: transaction.transaction_id,
      split_item_id: item.split_item_id,
      amount: item.amount,
      currency: transaction.currency,
      category_id: item.category_id,
      expense_frequency: item.expense_frequency,
    }));
  });
}

export function transactionLinesForExport(
  transactions: readonly TransactionView[],
  viewerMembershipId: string,
  now: Date,
  categories: readonly CategoryView[] = [],
): TransactionExportLine[] {
  const categoriesById = new Map(
    categories.map((category) => [category.category_id, category.name]),
  );
  return transactions.flatMap<TransactionExportLine>((transaction) => {
    const hidden = isHiddenFromViewer(transaction, viewerMembershipId, now);
    if (hidden && transaction.hidden_mode === 'TRANSACTION') {
      return [
        {
          transaction_id: transaction.transaction_id,
          split_item_id: null,
          operation_date: '',
          type: null,
          amount: '',
          currency: '',
          category_id: null,
          category_name: null,
          expense_frequency: null,
          description: 'Transakcja ukryta',
          note: null,
          hidden: true,
        },
      ];
    }

    const items = transaction.split_items ?? [];
    if (items.length === 0) {
      return [
        {
          transaction_id: transaction.transaction_id,
          split_item_id: null,
          operation_date: transaction.operation_date,
          type: transaction.type,
          amount: transaction.amount,
          currency: transaction.currency,
          category_id: transaction.category_id,
          category_name: transaction.category_id
            ? (categoriesById.get(transaction.category_id) ??
              transaction.category_name)
            : null,
          expense_frequency: transaction.expense_frequency ?? null,
          description: hidden ? 'Opis ukryty' : transaction.description,
          note: hidden ? null : transaction.note,
          hidden,
        },
      ];
    }
    return items.map((item) => ({
      transaction_id: transaction.transaction_id,
      split_item_id: item.split_item_id,
      operation_date: transaction.operation_date,
      type: transaction.type,
      amount: item.amount,
      currency: transaction.currency,
      category_id: item.category_id,
      category_name: item.category_id
        ? (categoriesById.get(item.category_id) ??
          (item.category_id === transaction.category_id
            ? transaction.category_name
            : null))
        : null,
      expense_frequency: item.expense_frequency,
      description: hidden
        ? 'Opis ukryty'
        : (item.description ?? transaction.description),
      note: hidden ? null : item.note,
      hidden,
    }));
  });
}
