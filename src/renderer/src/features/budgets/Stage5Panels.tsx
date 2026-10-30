import React, { useEffect, useMemo, useState } from 'react';
import type {
  AccountBalanceView,
  AccountView,
  MyBudgetView,
  TransactionView,
  TransferGroupView,
} from '../../../../shared/contracts';
import {
  latestBalancePerAccount,
  suggestTransferPairs,
} from '../../../../shared/domain/transfers';
import type { AppServices } from '../../backend/ports';

export function AccountBalancesPanel({
  accounts,
  services,
}: {
  accounts: AccountView[];
  services: AppServices;
}) {
  const [balances, setBalances] = useState<AccountBalanceView[]>([]);
  const [accountId, setAccountId] = useState('');
  const [balanceDate, setBalanceDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedAccountId = accounts.some(
    (account) => account.account_id === accountId,
  )
    ? accountId
    : (accounts[0]?.account_id ?? '');

  useEffect(() => {
    if (!accounts.length) return undefined;
    return services.data.subscribeAccountBalances(
      accounts[0]!.budget_id,
      accounts.map((account) => account.account_id),
      setBalances,
      (failure) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [accounts, services.data]);

  const latest = useMemo(
    () =>
      latestBalancePerAccount(
        balances.filter((balance) =>
          accounts.some((account) => account.account_id === balance.account_id),
        ),
      ),
    [accounts, balances],
  );

  async function saveBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const account = accounts.find(
      (item) => item.account_id === selectedAccountId,
    );
    if (!account) {
      setError('Wybierz konto przed zapisaniem salda.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await services.backend.saveAccountBalance({
        budget_id: account.budget_id,
        account_id: account.account_id,
        balance_date: balanceDate,
        balance_amount: amount,
        currency: account.currency,
      });
      setNotice('Saldo zapisane.');
      setAmount('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Salda kont">
      <h3>Salda kont</h3>
      <p>
        Najnowsze zapisane saldo i data są pokazane osobno dla każdego konta.
      </p>
      <ul aria-label="Najnowsze salda">
        {accounts.map((account) => {
          const balance = latest.get(account.account_id);
          return (
            <li key={account.account_id}>
              {account.label} ({account.account_type}):{' '}
              {balance
                ? `${balance.balance_amount} ${balance.currency} · ${balance.balance_date} · ${
                    balance.source === 'MANUAL' ? 'ręczne' : 'wyciąg'
                  }`
                : 'Brak zapisanego salda'}
            </li>
          );
        })}
      </ul>
      {accounts.length === 0 ? (
        <p>Dodaj konto, aby zapisywać jego saldo.</p>
      ) : (
        <form onSubmit={(event) => void saveBalance(event)}>
          <h4>Zapisz saldo</h4>
          <label>
            Konto
            <select
              aria-label="Konto salda"
              value={selectedAccountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.account_id} value={account.account_id}>
                  {account.label} · {account.currency}
                </option>
              ))}
            </select>
          </label>
          <label>
            Data salda
            <input
              aria-label="Data salda"
              type="date"
              required
              value={balanceDate}
              onChange={(event) => setBalanceDate(event.target.value)}
            />
          </label>
          <label>
            Kwota salda
            <input
              aria-label="Kwota salda"
              inputMode="decimal"
              required
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !amount}>
            Zapisz saldo
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function TransferSuggestionsPanel({
  budget,
  transactions,
  groups,
  services,
}: {
  budget: MyBudgetView | undefined;
  transactions: TransactionView[];
  groups: TransferGroupView[];
  services: AppServices;
}) {
  const [correctedIncoming, setCorrectedIncoming] = useState<
    Record<string, string>
  >({});
  const [singleId, setSingleId] = useState('');
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const eligibleTransactions = transactions.filter(
    (transaction) =>
      !transaction.hidden_for_viewer &&
      !transaction.transfer_group_id &&
      (transaction.type === 'EXPENSE' || transaction.type === 'INCOME'),
  );
  const pairSuggestions = suggestTransferPairs(eligibleTransactions).filter(
    (candidate) =>
      !groups.some(
        (group) =>
          group.status === 'REJECTED' &&
          group.outgoing_transaction_id === candidate.outgoing_transaction_id &&
          group.incoming_transaction_id === candidate.incoming_transaction_id,
      ),
  );
  const eligibleSingles = eligibleTransactions.filter(
    (transaction) =>
      transaction.transaction_id === singleId ||
      !groups.some(
        (group) =>
          group.status === 'REJECTED' &&
          group.transaction_id === transaction.transaction_id,
      ),
  );

  async function review(request: {
    decision: 'CONFIRM_PAIR' | 'REJECT' | 'CONFIRM_UNPAIRED';
    outgoing_transaction_id?: string;
    incoming_transaction_id?: string;
    transaction_id?: string;
  }) {
    if (!budget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await services.backend.reviewTransfer({
        budget_id: budget.budget_id,
        ...request,
      });
      setConfirmSingle(false);
      setNotice(
        result.status === 'REJECTED'
          ? 'Sugestia transferu odrzucona.'
          : result.status === 'CONFIRMED_UNPAIRED'
            ? 'Potwierdzono transfer jednostronny.'
            : 'Transfer potwierdzony.',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Sugestie transferów">
      <h3>Sugestie transferów</h3>
      <p>
        Sugestia nie zmienia klasyfikacji. Transfer wpływa na raporty dopiero po
        potwierdzeniu.
      </p>
      {pairSuggestions.length === 0 ? (
        <p>Brak dopasowanych par do sprawdzenia.</p>
      ) : (
        <ul aria-label="Dopasowane transfery">
          {pairSuggestions.map((candidate) => {
            const outgoing = eligibleTransactions.find(
              (transaction) =>
                transaction.transaction_id ===
                candidate.outgoing_transaction_id,
            );
            const incomingOptions = eligibleTransactions.filter(
              (transaction) =>
                transaction.type === 'INCOME' &&
                transaction.account_id !== outgoing?.account_id,
            );
            const incomingId =
              correctedIncoming[candidate.outgoing_transaction_id] ??
              candidate.incoming_transaction_id;
            const incoming = incomingOptions.find(
              (transaction) => transaction.transaction_id === incomingId,
            );
            if (!outgoing || !incoming) return null;
            return (
              <li key={candidate.outgoing_transaction_id}>
                {outgoing.operation_date} · {outgoing.description} ·{' '}
                {outgoing.amount} {outgoing.currency} → {incoming.description} ·{' '}
                {incoming.amount} {incoming.currency}
                {candidate.cross_currency && (
                  <small> · różne waluty; różnica wymaga kursu</small>
                )}
                <label>
                  Skoryguj przychodzącą transakcję
                  <select
                    aria-label={`Przychodząca transakcja dla ${outgoing.description}`}
                    value={incomingId}
                    onChange={(event) =>
                      setCorrectedIncoming((current) => ({
                        ...current,
                        [candidate.outgoing_transaction_id]: event.target.value,
                      }))
                    }
                  >
                    {incomingOptions.map((option) => (
                      <option
                        key={option.transaction_id}
                        value={option.transaction_id}
                      >
                        {option.operation_date} · {option.description} ·{' '}
                        {option.amount} {option.currency}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void review({
                      decision: 'CONFIRM_PAIR',
                      outgoing_transaction_id: outgoing.transaction_id,
                      incoming_transaction_id: incoming.transaction_id,
                    })
                  }
                >
                  Potwierdź parę
                </button>{' '}
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() =>
                    void review({
                      decision: 'REJECT',
                      outgoing_transaction_id: outgoing.transaction_id,
                      incoming_transaction_id:
                        candidate.incoming_transaction_id,
                    })
                  }
                >
                  Odrzuć sugestię
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {eligibleSingles.length > 0 && (
        <div>
          <h4>Transfer bez drugiej transakcji</h4>
          <label>
            Transakcja
            <select
              aria-label="Transakcja jednostronna"
              value={singleId}
              onChange={(event) => {
                setSingleId(event.target.value);
                setConfirmSingle(false);
              }}
            >
              <option value="">Wybierz transakcję</option>
              {eligibleSingles.map((transaction) => (
                <option
                  key={transaction.transaction_id}
                  value={transaction.transaction_id}
                >
                  {transaction.operation_date} · {transaction.description} ·{' '}
                  {transaction.amount} {transaction.currency}
                </option>
              ))}
            </select>
          </label>
          {!confirmSingle ? (
            <button
              type="button"
              disabled={!singleId}
              onClick={() => setConfirmSingle(true)}
            >
              Rozpocznij potwierdzanie jednostronne
            </button>
          ) : (
            <div role="alert">
              <p>
                Brak drugiej strony transferu. Potwierdzenie zmieni klasyfikację
                tej transakcji; upewnij się, że to transfer.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void review({
                    decision: 'CONFIRM_UNPAIRED',
                    transaction_id: singleId,
                  })
                }
              >
                Potwierdzam transfer jednostronny
              </button>{' '}
              <button
                type="button"
                className="button-secondary"
                onClick={() => setConfirmSingle(false)}
              >
                Anuluj
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
