import React from 'react';
import { useRef, useState } from 'react';
import type {
  CategoryView,
  SplitItemInput,
  TransactionView,
} from '../../../../shared/contracts';
import {
  isSplitValid,
  remainingSplitAmount,
} from '../../../../shared/domain/transactionFeatures';
import type { BudgetBackend } from '../../../../shared/contracts';
import { describeError } from './errorMessages';

interface DraftItem extends SplitItemInput {
  local_id: number;
}

function initialItems(transaction: TransactionView): DraftItem[] {
  const existing = transaction.split_items ?? [];
  return existing.length
    ? existing.map((item, index) => ({
        local_id: index,
        amount: item.amount,
        category_id: item.category_id ?? '',
        expense_frequency: item.expense_frequency,
        description: item.description,
        note: item.note,
      }))
    : [
        {
          local_id: 0,
          amount: '',
          category_id: '',
          expense_frequency: null,
          description: null,
          note: null,
        },
        {
          local_id: 1,
          amount: '',
          category_id: '',
          expense_frequency: null,
          description: null,
          note: null,
        },
      ];
}

export function TransactionSplitEditor({
  transaction,
  categories,
  backend,
  onComplete,
}: {
  transaction: TransactionView;
  categories: readonly CategoryView[];
  backend: BudgetBackend;
  onComplete: (message: string) => void;
}) {
  const [items, setItems] = useState<DraftItem[]>(() =>
    initialItems(transaction),
  );
  const nextId = useRef(items.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalItems: SplitItemInput[] = items.map((item) => ({
    amount: item.amount,
    category_id: item.category_id,
    expense_frequency: item.expense_frequency,
    description: item.description,
    note: item.note,
  }));
  const remaining = remainingSplitAmount(transaction.amount, totalItems);
  const valid = isSplitValid(transaction.amount, totalItems);
  const matchingCategories = categories.filter(
    (category) =>
      category.kind === transaction.type &&
      (category.archived_at === null ||
        items.some((item) => item.category_id === category.category_id)),
  );

  function updateItem<Key extends keyof SplitItemInput>(
    localId: number,
    key: Key,
    value: SplitItemInput[Key],
  ) {
    setItems((current) =>
      current.map((item) =>
        item.local_id === localId ? { ...item, [key]: value } : item,
      ),
    );
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await backend.saveTransactionSplit({
        budget_id: transaction.budget_id,
        transaction_id: transaction.transaction_id,
        items: totalItems,
      });
      onComplete('Podział transakcji został zapisany.');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function removeSplit() {
    setBusy(true);
    setError(null);
    try {
      await backend.deleteTransactionSplit({
        budget_id: transaction.budget_id,
        transaction_id: transaction.transaction_id,
      });
      onComplete('Podział usunięto; kwota źródłowa pozostała bez zmian.');
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="transaction-form split-editor"
      onSubmit={(event) => void save(event)}
    >
      <h4>Podział transakcji</h4>
      <p>
        Kwota źródłowa: {transaction.amount} {transaction.currency}. Każda
        pozycja dziedziczy tę walutę.
      </p>
      {items.map((item, index) => (
        <fieldset key={item.local_id} className="split-item-editor">
          <legend>Pozycja {index + 1}</legend>
          <label>
            Kwota
            <input
              aria-label={`Kwota pozycji ${index + 1}`}
              inputMode="decimal"
              required
              value={item.amount}
              onChange={(event) =>
                updateItem(item.local_id, 'amount', event.target.value)
              }
            />
          </label>
          <label>
            Kategoria
            <select
              aria-label={`Kategoria pozycji ${index + 1}`}
              required
              value={item.category_id}
              onChange={(event) =>
                updateItem(item.local_id, 'category_id', event.target.value)
              }
            >
              <option value="">Wybierz kategorię</option>
              {matchingCategories.map((category) => (
                <option key={category.category_id} value={category.category_id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Częstotliwość
            <select
              aria-label={`Częstotliwość pozycji ${index + 1}`}
              value={item.expense_frequency ?? ''}
              onChange={(event) =>
                updateItem(
                  item.local_id,
                  'expense_frequency',
                  (event.target.value ||
                    null) as SplitItemInput['expense_frequency'],
                )
              }
            >
              <option value="">Nieokreślona</option>
              <option value="RECURRING">Cykliczna</option>
              <option value="IRREGULAR">Nieregularna</option>
              <option value="ONE_TIME">Jednorazowa</option>
            </select>
          </label>
          <label>
            Opis (opcjonalnie)
            <input
              aria-label={`Opis pozycji ${index + 1}`}
              maxLength={1000}
              value={item.description ?? ''}
              onChange={(event) =>
                updateItem(
                  item.local_id,
                  'description',
                  event.target.value || null,
                )
              }
            />
          </label>
          <label>
            Notatka (opcjonalnie)
            <textarea
              aria-label={`Notatka pozycji ${index + 1}`}
              maxLength={4000}
              value={item.note ?? ''}
              onChange={(event) =>
                updateItem(item.local_id, 'note', event.target.value || null)
              }
            />
          </label>
          {items.length > 2 && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setItems((current) =>
                  current.filter(
                    (candidate) => candidate.local_id !== item.local_id,
                  ),
                )
              }
            >
              Usuń pozycję {index + 1}
            </button>
          )}
        </fieldset>
      ))}
      <p aria-live="polite">
        Pozostało do podziału:{' '}
        {remaining === null ? '—' : `${remaining} ${transaction.currency}`}
      </p>
      {!valid && (
        <p role="alert">
          Dodaj co najmniej dwie pozycje i wyrównaj ich sumę do kwoty źródłowej.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setItems((current) => [
              ...current,
              {
                local_id: nextId.current++,
                amount: '',
                category_id: '',
                expense_frequency: null,
                description: null,
                note: null,
              },
            ])
          }
        >
          Dodaj pozycję
        </button>
        <button type="submit" disabled={busy || !valid}>
          {busy ? 'Zapisywanie…' : 'Zapisz podział'}
        </button>
        {(transaction.split_items?.length ?? 0) > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void removeSplit()}
          >
            Usuń podział
          </button>
        )}
      </div>
    </form>
  );
}
