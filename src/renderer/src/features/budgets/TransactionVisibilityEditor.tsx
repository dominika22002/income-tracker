import React from 'react';
import { useState } from 'react';
import type {
  BudgetBackend,
  TransactionView,
} from '../../../../shared/contracts';
import {
  hiddenUntilForPreset,
  isTransactionHidden,
} from '../../../../shared/domain/transactionFeatures';
import { describeError } from './errorMessages';

type DurationOption = 'DAY' | 'WEEK' | 'MONTH' | 'CUSTOM' | 'FOREVER';

function localDateTimeValue(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function TransactionVisibilityEditor({
  transaction,
  backend,
  onComplete,
}: {
  transaction: TransactionView;
  backend: BudgetBackend;
  onComplete: (message: string) => void;
}) {
  const currentlyHidden = isTransactionHidden(
    transaction.hidden_mode,
    transaction.hidden_until,
    new Date(),
  );
  const [mode, setMode] = useState<'DESCRIPTION' | 'TRANSACTION'>(
    currentlyHidden
      ? (transaction.hidden_mode ?? 'DESCRIPTION')
      : 'DESCRIPTION',
  );
  const [duration, setDuration] = useState<DurationOption>(
    currentlyHidden ? (transaction.hidden_until ? 'CUSTOM' : 'FOREVER') : 'DAY',
  );
  const [customUntil, setCustomUntil] = useState(() =>
    localDateTimeValue(transaction.hidden_until),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let hiddenUntil: Date | null;
    if (duration === 'FOREVER') {
      hiddenUntil = null;
    } else if (duration === 'CUSTOM') {
      hiddenUntil = customUntil ? new Date(customUntil) : null;
      if (!hiddenUntil || !Number.isFinite(hiddenUntil.getTime())) {
        setError('Wybierz poprawny termin wygaśnięcia ukrycia.');
        return;
      }
    } else {
      hiddenUntil = hiddenUntilForPreset(new Date(), duration);
    }
    if (hiddenUntil && hiddenUntil.getTime() <= Date.now()) {
      setError('Termin wygaśnięcia musi być w przyszłości.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await backend.setTransactionHidden({
        budget_id: transaction.budget_id,
        transaction_id: transaction.transaction_id,
        hidden_mode: mode,
        hidden_until: hiddenUntil?.toISOString() ?? null,
      });
      onComplete('Ustawienia ukrycia zostały zapisane.');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="transaction-form visibility-editor"
      onSubmit={(event) => void save(event)}
    >
      <h4>{currentlyHidden ? 'Zmień termin ukrycia' : 'Ukryj transakcję'}</h4>
      <label>
        Zakres ukrycia
        <select
          aria-label="Zakres ukrycia"
          disabled={currentlyHidden}
          value={mode}
          onChange={(event) =>
            setMode(event.target.value as 'DESCRIPTION' | 'TRANSACTION')
          }
        >
          <option value="DESCRIPTION">Ukryj opis</option>
          <option value="TRANSACTION">Ukryj całą transakcję</option>
        </select>
      </label>
      <label>
        Okres
        <select
          aria-label="Okres ukrycia"
          value={duration}
          onChange={(event) =>
            setDuration(event.target.value as DurationOption)
          }
        >
          <option value="DAY">1 dzień</option>
          <option value="WEEK">1 tydzień</option>
          <option value="MONTH">1 miesiąc</option>
          <option value="CUSTOM">Do wybranego terminu</option>
          <option value="FOREVER">Bezterminowo</option>
        </select>
      </label>
      {duration === 'CUSTOM' && (
        <label>
          Termin wygaśnięcia
          <input
            aria-label="Termin wygaśnięcia"
            required
            type="datetime-local"
            value={customUntil}
            onChange={(event) => setCustomUntil(event.target.value)}
          />
        </label>
      )}
      <p>
        Ukryte dane staną się widoczne automatycznie po upływie terminu; nie
        można ich ujawnić ręcznie.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Zapisywanie…' : 'Zapisz ukrycie'}
        </button>
      </div>
    </form>
  );
}
