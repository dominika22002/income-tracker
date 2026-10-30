import React, { useEffect, useState } from 'react';
import type {
  CommitCsvImportRequest,
  MyBudgetView,
  StatementImportRowRequest,
} from '../../../../shared/contracts';
import {
  parseStatementCsv,
  type StatementCsvField,
  type StatementCsvPreview as Preview,
  type StatementCsvRow,
  type StatementCsvSettings,
  type StatementTransactionType,
} from '../../../../shared/domain/statementCsv';
import type { AppServices } from '../../backend/ports';
import { describeError } from '../budgets/errorMessages';

type UiMessage = { type: 'info' | 'error'; text: string };
type DuplicateDecision = 'pending' | 'confirm' | 'exclude';
type ImportServices = {
  backend: Pick<AppServices['backend'], 'createAccount' | 'commitCsvImport'>;
  data: Pick<AppServices['data'], 'subscribeAccounts'>;
};

const PROFILE_FIELDS: Record<
  'history-v1' | 'savings-v1',
  Array<{ field: StatementCsvField; label: string }>
> = {
  'history-v1': [
    { field: 'startedDate', label: 'Data rozpoczęcia' },
    { field: 'completedDate', label: 'Data realizacji' },
    { field: 'description', label: 'Opis' },
    { field: 'amount', label: 'Kwota' },
    { field: 'fee', label: 'Opłata' },
    { field: 'currency', label: 'Waluta' },
    { field: 'status', label: 'Status' },
    { field: 'type', label: 'Rodzaj operacji' },
    { field: 'balance', label: 'Saldo' },
  ],
  'savings-v1': [
    { field: 'date', label: 'Data' },
    { field: 'description', label: 'Opis' },
    { field: 'withdrawal', label: 'Wypłata' },
    { field: 'income', label: 'Wpływ' },
    { field: 'balance', label: 'Saldo' },
  ],
};

function bytesFromBase64(content: string): Uint8Array {
  const binary = atob(content);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function editableRows(preview: Preview): StatementCsvRow[] {
  return preview.rows.map((row) => ({
    ...row,
    rawValues: { ...row.rawValues },
  }));
}

function hasRequiredFields(row: StatementCsvRow): boolean {
  return Boolean(
    row.operationDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.operationDate) &&
    row.description?.trim() &&
    row.amount &&
    /^[+-]?\d+(?:\.\d{1,4})?$/.test(row.amount) &&
    row.currency &&
    /^[A-Z]{3}$/.test(row.currency) &&
    row.transactionType &&
    ['EXPENSE', 'INCOME', 'TRANSFER'].includes(row.transactionType) &&
    !row.issues.some((issue) => issue.startsWith('Wiersz')),
  );
}

function relatedIssue(field: StatementCsvField): (issue: string) => boolean {
  switch (field) {
    case 'startedDate':
    case 'completedDate':
    case 'date':
      return (issue) => issue.startsWith('Nie można rozpoznać daty');
    case 'description':
      return (issue) => issue.startsWith('Brak opisu');
    case 'amount':
    case 'withdrawal':
    case 'income':
      return (issue) =>
        issue.startsWith('Nie można rozpoznać kwoty') ||
        issue.startsWith('Wiersz nie zawiera ani');
    case 'fee':
      return (issue) => issue.startsWith('Nie można rozpoznać opłaty');
    case 'currency':
      return (issue) =>
        issue.startsWith('Nie można rozpoznać waluty') ||
        issue.startsWith('Nie można rozpoznać kwoty lub waluty');
    case 'type':
      return (issue) => issue.startsWith('Kierunek transakcji');
    case 'balance':
      return (issue) =>
        issue.startsWith('Nie można rozpoznać salda') ||
        issue.startsWith('Waluta salda');
    case 'status':
      return () => false;
  }
}

function RowEditor({
  row,
  onChange,
  onDecision,
  possibleDuplicateDecision,
  onDuplicateDecision,
}: {
  row: StatementCsvRow;
  onChange: (field: keyof StatementCsvRow, value: string | null) => void;
  onDecision: (decision: 'include' | 'exclude') => void;
  possibleDuplicateDecision?: DuplicateDecision;
  onDuplicateDecision: (
    decision: Exclude<DuplicateDecision, 'pending'>,
  ) => void;
}) {
  const editableText = (
    field: 'operationDate' | 'description' | 'amount' | 'fee' | 'currency',
    label: string,
    value: string | null,
  ) => (
    <label>
      {label}{' '}
      <input
        aria-label={`${label} — wiersz ${row.rowNumber}`}
        value={value ?? ''}
        onChange={(event) => onChange(field, event.target.value || null)}
      />
    </label>
  );
  const canInclude =
    hasRequiredFields(row) &&
    !row.issues.some(
      (issue) =>
        issue.startsWith('Nie można') ||
        issue.startsWith('Brak') ||
        issue.startsWith('Wiersz'),
    );

  return (
    <li className={`import-row import-row-${row.status}`}>
      <h5>
        Wiersz {row.rowNumber} — {row.status}
      </h5>
      {editableText('operationDate', 'Data', row.operationDate)}
      {editableText('description', 'Opis', row.description)}
      {editableText('amount', 'Kwota', row.amount)}
      {editableText('currency', 'Waluta', row.currency)}
      {editableText('fee', 'Opłata', row.fee)}
      <label>
        Typ{' '}
        <select
          aria-label={`Typ — wiersz ${row.rowNumber}`}
          value={row.transactionType ?? ''}
          onChange={(event) =>
            onChange(
              'transactionType',
              (event.target.value || null) as StatementTransactionType | null,
            )
          }
        >
          <option value="">Wybierz typ</option>
          <option value="EXPENSE">Wydatek</option>
          <option value="INCOME">Przychód</option>
          <option value="TRANSFER">Transfer</option>
        </select>
      </label>
      {row.sourceStatus && <p>Status źródłowy: {row.sourceStatus}</p>}
      {row.issues.length > 0 && (
        <ul aria-label={`Uwagi wiersza ${row.rowNumber}`}>
          {row.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <p>Decyzja: {row.decision}</p>
      {possibleDuplicateDecision && (
        <div>
          <p role="alert">
            Wiersz może być duplikatem wcześniej zaimportowanej transakcji.
          </p>
          <p>Decyzja o podobieństwie: {possibleDuplicateDecision}</p>
          <button type="button" onClick={() => onDuplicateDecision('confirm')}>
            To nie duplikat — importuj
          </button>{' '}
          <button type="button" onClick={() => onDuplicateDecision('exclude')}>
            Pomiń jako duplikat
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={!canInclude}
        onClick={() => onDecision('include')}
      >
        Uwzględnij wiersz
      </button>{' '}
      <button type="button" onClick={() => onDecision('exclude')}>
        Jawnie wyklucz wiersz
      </button>
    </li>
  );
}

export function StatementCsvPreview({
  services,
  budgets,
  onImportSuccess,
}: {
  services: ImportServices;
  budgets: MyBudgetView[];
  onImportSuccess?: (budgetId: string) => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileSha256, setFileSha256] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<StatementCsvRow[]>([]);
  const [settings, setSettings] = useState<StatementCsvSettings>({});
  const [message, setMessage] = useState<UiMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [budgetId, setBudgetId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<
    Array<{ account_id: string; label: string; currency: string }>
  >([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountLabel, setAccountLabel] = useState('');
  const [accountCurrency, setAccountCurrency] = useState('CHF');
  const [accountType, setAccountType] = useState<
    'CHECKING' | 'SAVINGS' | 'CASH' | 'OTHER'
  >('CHECKING');
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [duplicateDecisions, setDuplicateDecisions] = useState<
    Record<number, DuplicateDecision>
  >({});

  const profileFields = preview?.profileId
    ? PROFILE_FIELDS[preview.profileId]
    : [];
  const selectedBudget = budgets.find(
    (budget) => budget.budget_id === budgetId,
  );
  const importBlockers: string[] = [];
  if (!fileSha256) importBlockers.push('Wybierz i wczytaj plik CSV.');
  if (!selectedBudget) {
    importBlockers.push('Wybierz budżet.');
  } else if (!accountsLoaded) {
    importBlockers.push('Poczekaj na załadowanie kont.');
  } else if (!accountId) {
    importBlockers.push(
      accounts.length === 0
        ? 'Utwórz konto dla wybranego budżetu.'
        : 'Wybierz konto źródłowe.',
    );
  }
  if (preview && (!preview.profileId || !preview.parserVersion)) {
    importBlockers.push(
      'Wybierz profil parsera, aby poprawnie rozpoznać dane.',
    );
  }
  if (rows.some((row) => row.decision === 'pending')) {
    importBlockers.push(
      'Dla każdego wiersza wybierz „Uwzględnij” albo „Jawnie wyklucz”.',
    );
  }
  if (
    rows.some((row) => row.decision === 'include' && !hasRequiredFields(row))
  ) {
    importBlockers.push(
      'Popraw wymagane pola we wszystkich uwzględnionych wierszach.',
    );
  }
  if (
    rows.some(
      (row) =>
        row.decision === 'include' &&
        duplicateDecisions[row.rowNumber] === 'pending',
    )
  ) {
    importBlockers.push(
      'Rozstrzygnij, czy każdy możliwy duplikat importować, czy pominąć.',
    );
  }
  if (rows.length === 0 && preview) {
    importBlockers.push('Podgląd nie zawiera wierszy transakcji do importu.');
  } else if (!rows.some((row) => row.decision === 'include')) {
    importBlockers.push('Uwzględnij co najmniej jeden prawidłowy wiersz.');
  }

  useEffect(() => {
    if (!selectedBudget) return undefined;
    return services.data.subscribeAccounts(
      selectedBudget.budget_id,
      selectedBudget.membership_id,
      (nextAccounts) => {
        setAccounts(nextAccounts);
        setAccountsLoaded(true);
      },
      (error) => setMessage({ type: 'error', text: describeError(error) }),
    );
  }, [services.data, selectedBudget]);

  function parse(bytesToParse: Uint8Array, options: StatementCsvSettings) {
    const result = parseStatementCsv(bytesToParse, options);
    setPreview(result);
    setRows(editableRows(result));
  }

  async function selectCsv() {
    setBusy(true);
    setMessage(null);
    try {
      const selected = await window.electronApi.selectLocalFile();
      if (selected.canceled) {
        setMessage({ type: 'info', text: 'Wybór pliku anulowano.' });
        return;
      }
      if (!selected.filePath) {
        throw new Error(selected.error ?? 'Nie wybrano pliku.');
      }
      setBytes(null);
      setFilePath(null);
      setPreview(null);
      setRows([]);
      setFileSha256(null);
      setDuplicateDecisions({});
      const readResult = await window.electronApi.readLocalStatement({
        filePath: selected.filePath,
      });
      if (!readResult.success || !readResult.contentBase64) {
        throw new Error(readResult.error ?? 'Nie udało się odczytać pliku.');
      }
      setFileName(
        readResult.fileName ?? selected.filePath.split(/[\\/]/).pop() ?? 'plik',
      );
      setFilePath(selected.filePath);
      if (readResult.extension?.toLowerCase() !== 'csv') {
        setBytes(null);
        setPreview(null);
        setRows([]);
        setMessage({
          type: 'error',
          text: 'Podgląd PDF nie jest jeszcze dostępny. Plik pozostał lokalny i nie został wysłany.',
        });
        return;
      }
      const fileHash = readResult.fileSha256;
      if (!fileHash || !/^[a-f0-9]{64}$/.test(fileHash)) {
        throw new Error('Nie udało się obliczyć skrótu SHA-256 pliku.');
      }
      setFileSha256(fileHash);
      const content = bytesFromBase64(readResult.contentBase64);
      setBytes(content);
      const nextSettings: StatementCsvSettings = {};
      setSettings(nextSettings);
      parse(content, nextSettings);
      setMessage({
        type: 'info',
        text: 'Podgląd lokalny. Plik ani jego zawartość nie zostały wysłane.',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error instanceof Error
            ? error.message
            : 'Nie udało się odczytać lokalnego pliku.',
      });
    } finally {
      setBusy(false);
    }
  }

  function updateSetting(next: StatementCsvSettings) {
    const updated = { ...settings, ...next };
    setSettings(updated);
    if (bytes) parse(bytes, updated);
  }

  function updateRow(
    rowNumber: number,
    field: keyof StatementCsvRow,
    value: string | null,
  ) {
    setRows((current) =>
      current.map((row) => {
        if (row.rowNumber !== rowNumber) return row;
        const issues = row.issues.filter(
          (issue) =>
            !relatedIssue(
              field === 'operationDate'
                ? preview?.profileId === 'savings-v1'
                  ? 'date'
                  : 'completedDate'
                : field === 'transactionType'
                  ? 'type'
                  : (field as StatementCsvField),
            )(issue),
        );
        const changed = { ...row, [field]: value, issues };
        const hasError =
          issues.some(
            (issue) =>
              issue.startsWith('Nie można') ||
              issue.startsWith('Brak') ||
              issue.startsWith('Wiersz'),
          ) || !hasRequiredFields(changed);
        return {
          ...changed,
          status: hasError ? 'error' : issues.length ? 'needs_review' : 'ready',
          decision: 'pending',
        };
      }),
    );
    setDuplicateDecisions((current) => {
      const next = { ...current };
      delete next[rowNumber];
      return next;
    });
  }

  function updateDecision(rowNumber: number, decision: 'include' | 'exclude') {
    setRows((current) =>
      current.map((row) =>
        row.rowNumber === rowNumber ? { ...row, decision } : row,
      ),
    );
    setDuplicateDecisions((current) => {
      const next = { ...current };
      delete next[rowNumber];
      return next;
    });
  }

  function decideDuplicate(rowNumber: number, decision: DuplicateDecision) {
    setDuplicateDecisions((current) => ({ ...current, [rowNumber]: decision }));
  }

  async function createAccount() {
    if (!selectedBudget || !accountLabel.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await services.backend.createAccount({
        budget_id: selectedBudget.budget_id,
        label: accountLabel.trim(),
        currency: accountCurrency,
        account_type: accountType,
      });
      setAccountId(result.account_id);
      setAccountLabel('');
      setShowCreateAccount(false);
      setMessage({ type: 'info', text: 'Konto utworzono.' });
    } catch (error) {
      setMessage({ type: 'error', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function commitImport() {
    if (
      !selectedBudget ||
      !accountId ||
      !preview?.profileId ||
      !preview.parserVersion ||
      !fileSha256
    ) {
      setMessage({
        type: 'error',
        text: 'Wybierz budżet i własne konto oraz popraw dane przed zatwierdzeniem.',
      });
      return;
    }
    const requestRows: StatementImportRowRequest[] = [];
    for (const row of rows) {
      if (row.decision === 'exclude') {
        requestRows.push({ row_number: row.rowNumber, decision: 'exclude' });
        continue;
      }
      if (
        row.decision !== 'include' ||
        !hasRequiredFields(row) ||
        !row.operationDate ||
        !row.description ||
        !row.amount ||
        !row.currency ||
        !row.transactionType
      ) {
        setMessage({
          type: 'error',
          text: `Wiersz ${row.rowNumber} wymaga poprawy lub jawnego wykluczenia.`,
        });
        return;
      }
      requestRows.push({
        row_number: row.rowNumber,
        decision: 'include',
        operation_date: row.operationDate,
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        transaction_type: row.transactionType,
        fee: row.fee,
        source_status: row.sourceStatus,
        balance: row.balance,
        balance_currency: row.balanceCurrency,
        possible_duplicate_decision:
          duplicateDecisions[row.rowNumber] ?? 'pending',
      });
    }
    if (!requestRows.some((row) => row.decision === 'include')) {
      setMessage({
        type: 'error',
        text: 'Zatwierdzenie wymaga co najmniej jednego uwzględnionego wiersza.',
      });
      return;
    }
    const request: CommitCsvImportRequest = {
      budget_id: selectedBudget.budget_id,
      account_id: accountId,
      file_sha256: fileSha256,
      parser_id: preview.profileId,
      parser_version: preview.parserVersion,
      rows: requestRows,
    };
    setBusy(true);
    setMessage(null);
    try {
      const result = await services.backend.commitCsvImport(request);
      let fileSaved = false;
      if (filePath && fileSha256) {
        const archive = await window.electronApi.archiveImportedStatement({
          filePath,
          fileSha256,
          budgetId: selectedBudget.budget_id,
          importBatchId: result.import_batch_id,
        });
        if (archive.status === 'error') {
          setMessage({
            type: 'error',
            text: `Import został zapisany, ale oryginalnego wyciągu nie udało się zachować lokalnie: ${archive.error}`,
          });
          onImportSuccess?.(selectedBudget.budget_id);
          return;
        }
        fileSaved = true;
        setFilePath(null);
      }
      onImportSuccess?.(selectedBudget.budget_id);
      setMessage({
        type: 'info',
        text: result.already_imported
          ? fileSaved
            ? 'Ten plik został już zaimportowany; jego oryginał zachowano lokalnie.'
            : 'Ten plik został już wcześniej zaimportowany dla wybranego konta.'
          : `Import zatwierdzono: ${result.imported_row_count} transakcji; pominięte wiersze: ${result.skipped_duplicate_row_numbers.join(', ') || 'brak'}.${fileSaved ? ' Oryginalny wyciąg zachowano lokalnie na tym urządzeniu.' : ''}`,
      });
      setDuplicateDecisions({});
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const rowMatch =
        error instanceof Error ? /Row (\d+)/i.exec(error.message) : null;
      if (code === 'DUPLICATE_REVIEW_REQUIRED' && rowMatch) {
        const rowNumber = Number(rowMatch[1]);
        setDuplicateDecisions((current) => ({
          ...current,
          [rowNumber]: 'pending',
        }));
        setMessage({
          type: 'error',
          text: `Wiersz ${rowNumber} może być duplikatem. Wybierz decyzję przy tym wierszu i ponów zatwierdzanie.`,
        });
      } else {
        setMessage({ type: 'error', text: describeError(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="card feature-panel import-panel"
      aria-label="Import podglądu CSV"
      id="csv-import"
    >
      <h2>Lokalny podgląd wyciągu CSV</h2>
      <p>
        Parsowanie odbywa się na urządzeniu. Do serwera trafiają wyłącznie
        zatwierdzone pola transakcji i skrót pliku.
      </p>
      <button type="button" disabled={busy} onClick={() => void selectCsv()}>
        Wybierz lokalny CSV
      </button>
      <div>
        <label>
          Budżet importu{' '}
          <select
            aria-label="Budżet importu"
            value={budgetId}
            onChange={(event) => {
              setBudgetId(event.target.value);
              setAccountId('');
              setAccounts([]);
              setAccountsLoaded(false);
              setShowCreateAccount(false);
            }}
          >
            <option value="">Wybierz budżet</option>
            {budgets.map((budget) => (
              <option key={budget.budget_id} value={budget.budget_id}>
                {budget.name}
              </option>
            ))}
          </select>
        </label>
        {selectedBudget &&
          (accountsLoaded ? (
            <>
              {accounts.length > 0 && (
                <label>
                  Konto źródłowe{' '}
                  <select
                    aria-label="Konto źródłowe"
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    <option value="">Wybierz własne konto</option>
                    {accounts.map((account) => (
                      <option
                        key={account.account_id}
                        value={account.account_id}
                      >
                        {account.label} ({account.currency})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {accounts.length === 0 && !showCreateAccount && (
                <p>Nie masz jeszcze aktywnego konta w tym budżecie.</p>
              )}
              {!showCreateAccount && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowCreateAccount(true)}
                >
                  Utwórz konto
                </button>
              )}
            </>
          ) : (
            <p>Ładowanie kont…</p>
          ))}
        {selectedBudget && accountsLoaded && showCreateAccount && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createAccount();
            }}
          >
            <label>
              Nazwa konta{' '}
              <input
                value={accountLabel}
                onChange={(event) => setAccountLabel(event.target.value)}
              />
            </label>{' '}
            <label>
              Waluta konta{' '}
              <input
                aria-label="Waluta konta"
                maxLength={3}
                value={accountCurrency}
                onChange={(event) =>
                  setAccountCurrency(event.target.value.toUpperCase())
                }
              />
            </label>{' '}
            <label>
              Rodzaj konta{' '}
              <select
                aria-label="Rodzaj konta"
                value={accountType}
                onChange={(event) =>
                  setAccountType(event.target.value as typeof accountType)
                }
              >
                <option value="CHECKING">Bieżące</option>
                <option value="SAVINGS">Oszczędnościowe</option>
                <option value="CASH">Gotówka</option>
                <option value="OTHER">Inne</option>
              </select>
            </label>{' '}
            <button type="submit" disabled={busy || !accountLabel.trim()}>
              Zapisz konto
            </button>{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowCreateAccount(false)}
            >
              Anuluj
            </button>
          </form>
        )}
      </div>
      {fileName && <p>Plik: {fileName}</p>}
      {message && (
        <p role={message.type === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      {preview && (
        <>
          <p>
            Profil: {preview.profileId ?? 'nierozpoznany'}; parser:{' '}
            {preview.parserVersion ?? '—'}; kodowanie: {preview.encoding ?? '—'}
          </p>
          {preview.errors.map((error) => (
            <p key={error} role="alert">
              {error}
            </p>
          ))}
          <label>
            Separator{' '}
            <select
              aria-label="Separator"
              value={settings.delimiter ?? ''}
              onChange={(event) =>
                updateSetting({ delimiter: event.target.value || undefined })
              }
            >
              <option value="">Automatycznie</option>
              <option value=",">Przecinek</option>
              <option value=";">Średnik</option>
              <option value={'\t'}>Tabulator</option>
              <option value="|">Pionowa kreska</option>
            </select>
          </label>{' '}
          <label>
            Kodowanie{' '}
            <select
              aria-label="Kodowanie"
              value={settings.encoding ?? ''}
              onChange={(event) =>
                updateSetting({ encoding: event.target.value || undefined })
              }
            >
              <option value="">Automatyczne/BOM</option>
              <option value="utf-8">UTF-8</option>
              <option value="windows-1250">Windows-1250</option>
              <option value="utf-16le">UTF-16 LE</option>
              <option value="utf-16be">UTF-16 BE</option>
            </select>
          </label>
          <label>
            Profil parsera{' '}
            <select
              aria-label="Profil parsera"
              value={settings.profileId ?? ''}
              onChange={(event) =>
                updateSetting({
                  profileId:
                    (event.target.value as StatementCsvSettings['profileId']) ||
                    undefined,
                })
              }
            >
              <option value="">Automatyczne rozpoznanie</option>
              <option value="history-v1">Historia transakcji</option>
              <option value="savings-v1">Konto oszczędnościowe</option>
            </select>
          </label>
          {preview.profileId && (
            <fieldset>
              <legend>Mapowanie kolumn</legend>
              {profileFields.map(({ field, label }) => (
                <label key={field}>
                  {label}{' '}
                  <select
                    aria-label={`Kolumna: ${label}`}
                    value={settings.mapping?.[field] ?? ''}
                    onChange={(event) =>
                      updateSetting({
                        mapping: {
                          ...settings.mapping,
                          [field]: event.target.value,
                        },
                      })
                    }
                  >
                    <option value="">Domyślna kolumna</option>
                    {preview.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
          <ul aria-label="Wiersze podglądu">
            {rows.map((row) => (
              <RowEditor
                key={row.rowNumber}
                row={row}
                onChange={(field, value) =>
                  updateRow(row.rowNumber, field, value)
                }
                onDecision={(decision) =>
                  updateDecision(row.rowNumber, decision)
                }
                possibleDuplicateDecision={duplicateDecisions[row.rowNumber]}
                onDuplicateDecision={(decision) =>
                  decideDuplicate(row.rowNumber, decision)
                }
              />
            ))}
          </ul>
          {rows.length > 0 && (
            <p>
              Uwzględnione:{' '}
              {rows.filter((row) => row.decision === 'include').length}; do
              decyzji: {rows.filter((row) => row.decision === 'pending').length}
              ; wykluczone:{' '}
              {rows.filter((row) => row.decision === 'exclude').length}
            </p>
          )}
          {!busy && importBlockers.length > 0 && (
            <p id="import-readiness" role="status">
              Nie można zatwierdzić importu: {importBlockers.join(' ')}
            </p>
          )}
          <button
            type="button"
            aria-describedby={
              !busy && importBlockers.length > 0
                ? 'import-readiness'
                : undefined
            }
            disabled={busy || importBlockers.length > 0}
            onClick={() => void commitImport()}
          >
            {busy ? 'Importowanie…' : 'Zatwierdź import'}
          </button>
        </>
      )}
    </section>
  );
}
