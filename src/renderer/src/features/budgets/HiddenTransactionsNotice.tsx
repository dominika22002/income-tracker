import React from 'react';
import type { TransactionView } from '../../../../shared/contracts';
import { isTransactionHidden } from '../../../../shared/domain/transactionFeatures';

export function HiddenTransactionsNotice({
  transactions,
}: {
  transactions: readonly TransactionView[];
}) {
  const hidden = transactions.filter(
    (transaction) =>
      transaction.hidden_for_viewer === true &&
      isTransactionHidden(
        transaction.hidden_mode,
        transaction.hidden_until,
        new Date(),
      ),
  );
  if (hidden.length === 0) return null;
  return (
    <aside aria-label="Informacje o ukrytych transakcjach">
      <p>
        {hidden.length === 1
          ? 'Jedna pozycja jest ukryta dla Ciebie.'
          : `${hidden.length} pozycji jest ukrytych dla Ciebie.`}
      </p>
      <ul>
        {hidden.map((transaction) => (
          <li key={transaction.transaction_id}>
            {transaction.hidden_until
              ? `Widoczna od ${new Date(transaction.hidden_until).toLocaleString('pl-PL')}.`
              : 'Pozostanie ukryta bezterminowo.'}
          </li>
        ))}
      </ul>
    </aside>
  );
}
