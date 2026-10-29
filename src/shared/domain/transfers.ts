import type { TransactionView } from '../contracts';
import {
  compareDecimalAmounts,
  normalizeTransactionText,
} from './transactions';

export interface TransferCandidate {
  outgoing_transaction_id: string;
  incoming_transaction_id: string;
  days_apart: number;
  cross_currency: boolean;
}

function dayDistance(left: string, right: string): number {
  const leftTime = Date.parse(`${left}T00:00:00.000Z`);
  const rightTime = Date.parse(`${right}T00:00:00.000Z`);
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function canMatch(
  outgoing: TransactionView,
  incoming: TransactionView,
): boolean {
  return (
    outgoing.budget_id === incoming.budget_id &&
    outgoing.account_id !== incoming.account_id &&
    outgoing.type === 'EXPENSE' &&
    incoming.type === 'INCOME' &&
    !outgoing.hidden_for_viewer &&
    !incoming.hidden_for_viewer &&
    !outgoing.transfer_group_id &&
    !incoming.transfer_group_id &&
    dayDistance(outgoing.operation_date, incoming.operation_date) <= 3 &&
    normalizeTransactionText(outgoing.description) ===
      normalizeTransactionText(incoming.description) &&
    (outgoing.currency !== incoming.currency ||
      compareDecimalAmounts(outgoing.amount, incoming.amount) === 0)
  );
}

export function suggestTransferPairs(
  transactions: readonly TransactionView[],
): TransferCandidate[] {
  const outgoing = transactions.filter(
    (transaction) => transaction.type === 'EXPENSE',
  );
  const incoming = transactions.filter(
    (transaction) => transaction.type === 'INCOME',
  );
  const candidates = outgoing.flatMap((source) =>
    incoming
      .filter((destination) => canMatch(source, destination))
      .map((destination) => ({
        outgoing_transaction_id: source.transaction_id,
        incoming_transaction_id: destination.transaction_id,
        days_apart: dayDistance(
          source.operation_date,
          destination.operation_date,
        ),
        cross_currency: source.currency !== destination.currency,
      })),
  );
  candidates.sort(
    (left, right) =>
      left.days_apart - right.days_apart ||
      left.outgoing_transaction_id.localeCompare(
        right.outgoing_transaction_id,
      ) ||
      left.incoming_transaction_id.localeCompare(right.incoming_transaction_id),
  );

  const used = new Set<string>();
  return candidates.filter((candidate) => {
    if (
      used.has(candidate.outgoing_transaction_id) ||
      used.has(candidate.incoming_transaction_id)
    ) {
      return false;
    }
    used.add(candidate.outgoing_transaction_id);
    used.add(candidate.incoming_transaction_id);
    return true;
  });
}

export function latestBalancePerAccount<
  T extends { account_id: string; balance_date: string; snapshot_id: string },
>(snapshots: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.account_id);
    if (
      !current ||
      snapshot.balance_date > current.balance_date ||
      (snapshot.balance_date === current.balance_date &&
        snapshot.snapshot_id.localeCompare(current.snapshot_id) > 0)
    ) {
      latest.set(snapshot.account_id, snapshot);
    }
  }
  return latest;
}
