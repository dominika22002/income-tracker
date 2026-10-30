import React, { useMemo, useState } from 'react';
import type {
  BackupFile,
  BackupPayload,
  MergeConflict,
} from '../../../../shared/domain/backup';
import {
  createBackupFile,
  parseBackupFile,
  planBackupMerge,
  resolveBackupMerge,
  summarizeBackup,
} from '../../../../shared/domain/backup';
import { BACKUP_COLLECTIONS } from '../../../../shared/firestorePaths';
import type {
  BackupStatementFileRecord,
  BeginBudgetRestoreRequest,
  MyBudgetView,
  RestoreDocument,
} from '../../../../shared/contracts';
import type { AppServices } from '../../backend/ports';

type OperationStatus = { kind: 'success' | 'error' | 'info'; message: string };
type RestoreMode = 'replace' | 'merge';
type MergePlan = ReturnType<typeof planBackupMerge>;

const CHUNK_SIZE = 100;

function safeFileName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function withLocalStatementFiles(
  payload: BackupPayload,
  files: BackupStatementFileRecord[],
): BackupPayload {
  const importedBatches = new Set(
    payload.datasets.import_batches.map((record) => record.document_id),
  );
  const includedFiles = files.filter((file) =>
    importedBatches.has(file.import_batch_id),
  );
  return {
    ...payload,
    statement_files: [
      ...payload.statement_files,
      ...includedFiles.filter(
        (file) =>
          !payload.statement_files.some(
            (existing) =>
              existing.import_batch_id === file.import_batch_id &&
              existing.sha256 === file.sha256,
          ),
      ),
    ],
  };
}

function documentCounts(payload: BackupPayload): Record<string, number> {
  return {
    ...Object.fromEntries(
      BACKUP_COLLECTIONS.map((collection) => [
        collection,
        payload.datasets[collection].length,
      ]),
    ),
    membership_history: payload.membership_history.length,
  };
}

function recordKey(conflict: MergeConflict): string {
  return `${conflict.collection}/${conflict.document_id}`;
}

function summarizeTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('pl-PL');
}

export function BackupWorkspace({
  services,
  budgets,
  selectedBudgetId,
  userId,
}: {
  services: AppServices;
  budgets: MyBudgetView[] | null;
  selectedBudgetId?: string;
  userId: string;
}) {
  const [targetBudgetId, setTargetBudgetId] = useState(selectedBudgetId ?? '');
  const [warningAccepted, setWarningAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<OperationStatus | null>(null);
  const [backup, setBackup] = useState<BackupFile | null>(null);
  const [mode, setMode] = useState<RestoreMode | null>(null);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [mergePlan, setMergePlan] = useState<MergePlan | null>(null);
  const [mergeChoices, setMergeChoices] = useState<
    Record<string, 'current' | 'incoming'>
  >({});
  const [restorePayload, setRestorePayload] = useState<BackupPayload | null>(
    null,
  );

  const preferredBudgetId =
    selectedBudgetId &&
    budgets?.some((budget) => budget.budget_id === selectedBudgetId)
      ? selectedBudgetId
      : targetBudgetId;
  const effectiveTargetBudgetId = budgets?.some(
    (budget) => budget.budget_id === preferredBudgetId,
  )
    ? preferredBudgetId
    : (budgets?.[0]?.budget_id ?? '');
  const targetBudget = budgets?.find(
    (budget) => budget.budget_id === effectiveTargetBudgetId,
  );
  const summary = useMemo(
    () => (backup ? summarizeBackup(backup) : null),
    [backup],
  );
  const conflicts = mergePlan?.conflicts ?? [];
  const unresolvedConflicts = conflicts.filter(
    (conflict) => !mergeChoices[recordKey(conflict)],
  );

  function resetRestore() {
    setBackup(null);
    setMode(null);
    setReplaceConfirmed(false);
    setMergePlan(null);
    setMergeChoices({});
    setRestorePayload(null);
    setProgress(0);
  }

  async function exportWithLocalFiles(
    budgetId: string,
  ): Promise<BackupPayload> {
    const payload = await services.data.exportBudgetSnapshot(budgetId, userId);
    const local = await window.electronApi.listLocalStatementFiles(budgetId);
    if (local.status === 'error') throw new Error(local.error);
    return withLocalStatementFiles(payload, local.files);
  }

  async function createLocalBackup(
    payload: BackupPayload,
    fileName: string,
  ): Promise<'saved' | 'canceled'> {
    const content = await createBackupFile(payload);
    const result = await window.electronApi.saveBackupFile({
      fileName,
      content,
    });
    if (result.status === 'error') throw new Error(result.error);
    if (result.status === 'canceled') return 'canceled';
    return 'saved';
  }

  async function createManualBackup() {
    if (!targetBudget || !warningAccepted) return;
    setBusy(true);
    setStatus({ kind: 'info', message: 'Pobieranie danych budżetu…' });
    setProgress(10);
    try {
      const payload = await exportWithLocalFiles(targetBudget.budget_id);
      setProgress(70);
      const result = await createLocalBackup(
        payload,
        `income-tracker-backup-${safeFileName(targetBudget.name)}-${new Date().toISOString().slice(0, 10)}.json`,
      );
      setProgress(result === 'saved' ? 100 : 0);
      setStatus(
        result === 'saved'
          ? {
              kind: 'success',
              message:
                'Kopia została zapisana. Plik nie jest szyfrowany — przechowuj go w bezpiecznym miejscu.',
            }
          : {
              kind: 'info',
              message: 'Anulowano zapis; plik kopii nie został utworzony.',
            },
      );
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error
            ? `Nie udało się utworzyć kopii: ${error.message}`
            : 'Nie udało się utworzyć kopii z nieznanego powodu.',
      });
      setProgress(0);
    } finally {
      setBusy(false);
    }
  }

  async function selectBackupFile() {
    setBusy(true);
    setStatus({ kind: 'info', message: 'Wybierz lokalny plik kopii…' });
    resetRestore();
    try {
      const result = await window.electronApi.selectBackupFile();
      if (result.status === 'canceled') {
        setStatus({ kind: 'info', message: 'Wybór pliku anulowano.' });
        return;
      }
      if (result.status === 'error') throw new Error(result.error);
      const parsed = await parseBackupFile(result.content);
      setBackup(parsed);
      setStatus({
        kind: 'success',
        message: `Sprawdzono integralność pliku ${result.fileName}.`,
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error
            ? `Kopia została odrzucona: ${error.message}`
            : 'Kopia została odrzucona z powodu nieznanego błędu.',
      });
    } finally {
      setBusy(false);
    }
  }

  function chooseMode(nextMode: RestoreMode) {
    setMode(nextMode);
    setMergePlan(null);
    setMergeChoices({});
    setRestorePayload(nextMode === 'replace' ? backup : null);
    setReplaceConfirmed(false);
  }

  async function prepareMerge() {
    if (!backup || !targetBudget) return;
    setBusy(true);
    setStatus({ kind: 'info', message: 'Porównywanie rekordów budżetu…' });
    try {
      const current = await exportWithLocalFiles(targetBudget.budget_id);
      const plan = planBackupMerge(current, backup);
      setMergePlan(plan);
      setMergeChoices({});
      setRestorePayload(
        plan.conflicts.length === 0 ? plan.merged : null,
      );
      setStatus({
        kind: 'info',
        message:
          plan.conflicts.length === 0
            ? 'Scalenie nie zawiera konfliktów.'
            : `Wykryto ${plan.conflicts.length} konfliktów. Rozstrzygnij każdy osobno.`,
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error
            ? `Nie udało się przygotować scalenia: ${error.message}`
            : 'Nie udało się przygotować scalenia.',
      });
    } finally {
      setBusy(false);
    }
  }

  function chooseConflict(conflict: MergeConflict, choice: 'current' | 'incoming') {
    if (!mergePlan) return;
    const nextChoices = { ...mergeChoices, [recordKey(conflict)]: choice };
    setMergeChoices(nextChoices);
    if (mergePlan.conflicts.every((item) => nextChoices[recordKey(item)])) {
      try {
        setRestorePayload(resolveBackupMerge(mergePlan, nextChoices));
        setStatus({ kind: 'success', message: 'Wszystkie konflikty rozstrzygnięto.' });
      } catch (error) {
        setRestorePayload(null);
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Błędne rozstrzygnięcie konfliktu.',
        });
      }
    } else {
      setRestorePayload(null);
    }
  }

  async function startRestore() {
    if (
      !backup ||
      !restorePayload ||
      !targetBudget ||
      !mode ||
      !warningAccepted ||
      (mode === 'replace' && !replaceConfirmed) ||
      (mode === 'merge' && unresolvedConflicts.length > 0)
    ) {
      return;
    }
    setBusy(true);
    setProgress(2);
    let restoredLocalFiles = 0;
    setStatus({
      kind: 'info',
      message: 'Tworzenie lokalnej kopii bieżącego budżetu…',
    });
    try {
      const current = await exportWithLocalFiles(targetBudget.budget_id);
      const savedCurrent = await createLocalBackup(
        current,
        `income-tracker-before-restore-${safeFileName(targetBudget.name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      );
      if (savedCurrent === 'canceled') {
        setStatus({
          kind: 'info',
          message:
            'Odtwarzanie anulowano. Bieżące dane budżetu nie zostały zmienione.',
        });
        setProgress(0);
        return;
      }

      setProgress(10);
      setStatus({ kind: 'info', message: 'Przygotowywanie bezpiecznej rewizji…' });
      const beginRequest: BeginBudgetRestoreRequest = {
        budget_id: targetBudget.budget_id,
        expected_revision_id: targetBudget.active_revision_id ?? null,
        document_counts: documentCounts(restorePayload),
        source_memberships: restorePayload.membership_history,
        currency_settings: restorePayload.currency_settings,
        apply_currency_settings: mode === 'replace',
      };
      const session = await services.backend.beginBudgetRestore(beginRequest);
      const totalDocuments = BACKUP_COLLECTIONS.reduce(
        (total, collection) =>
          total + restorePayload.datasets[collection].length,
        0,
      );
      let completed = 0;
      for (const collection of BACKUP_COLLECTIONS) {
        const documents: RestoreDocument[] = restorePayload.datasets[
          collection
        ].map((record) => ({
          collection,
          document_id: record.document_id,
          data: record.data,
        }));
        for (let offset = 0; offset < documents.length; offset += CHUNK_SIZE) {
          const chunk = documents.slice(offset, offset + CHUNK_SIZE);
          await services.backend.writeBudgetRestoreChunk({
            restore_id: session.restore_id,
            chunk_id: `${crypto.randomUUID()}`,
            documents: chunk,
          });
          completed += chunk.length;
          setProgress(
            10 +
              (totalDocuments === 0
                ? 75
                : Math.round((completed / totalDocuments) * 75)),
          );
          setStatus({
            kind: 'info',
            message: `Wysyłanie danych do bezpiecznej rewizji (${completed}/${totalDocuments})…`,
          });
        }
      }
      const importedBatchIds = new Set(
        restorePayload.datasets.import_batches.map(
          (record) => record.document_id,
        ),
      );
      const localFiles = restorePayload.statement_files.filter((file) =>
        importedBatchIds.has(file.import_batch_id),
      );
      if (localFiles.length > 0) {
        setProgress(88);
        setStatus({
          kind: 'info',
          message: 'Przywracanie oryginalnych plików wyłącznie na tym urządzeniu…',
        });
        const localResult = await window.electronApi.restoreLocalStatementFiles({
          budgetId: targetBudget.budget_id,
          files: localFiles,
        });
        if (localResult.status === 'error') {
          throw new Error(
            `Nie udało się odtworzyć lokalnych plików wyciągów: ${localResult.error}`,
          );
        }
        restoredLocalFiles = localResult.count;
      }
      setProgress(90);
      setStatus({ kind: 'info', message: 'Zatwierdzanie atomowej zmiany budżetu…' });
      await services.backend.commitBudgetRestore({
        restore_id: session.restore_id,
      });
      setProgress(100);
      setStatus({
        kind: 'success',
        message:
          restoredLocalFiles > 0
            ? `Odtwarzanie danych budżetu zakończone. Odtworzono lokalnie ${restoredLocalFiles} plików wyciągów; nie są one synchronizowane.`
            : 'Odtwarzanie danych budżetu zakończone.',
      });
      setBackup(null);
      setMode(null);
      setMergePlan(null);
      setMergeChoices({});
      setRestorePayload(null);
    } catch (error) {
      setStatus({
        kind: 'error',
        message:
          error instanceof Error
            ? `Odtwarzanie nie powiodło się. Bieżący budżet pozostał bez zmian.${restoredLocalFiles > 0 ? ` Skopiowane lokalnie pliki wyciągów pozostały na tym urządzeniu. ${restoredLocalFiles} plików.` : ''} ${error.message}`
            : `Odtwarzanie nie powiodło się. Bieżący budżet pozostał bez zmian.${restoredLocalFiles > 0 ? ` Skopiowane lokalnie pliki wyciągów pozostały na tym urządzeniu: ${restoredLocalFiles}.` : ''}`,
      });
      setProgress(0);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-grid">
      <section className="dashboard-card">
        <p className="eyebrow">KOPIE LOKALNE</p>
        <h2>Kopie zapasowe i odzyskiwanie</h2>
        <p>
          Kopia obejmuje dane finansowe i historię członkostw budżetu. Oryginały
          wyciągów są dołączane tylko wtedy, gdy nadal są dostępne lokalnie.
        </p>
        <p role="alert">
          Uwaga: plik kopii nie jest szyfrowany i zawiera wrażliwe dane
          finansowe. Zapisuj go wyłącznie w zaufanej lokalizacji.
        </p>
        <button
          type="button"
          aria-pressed={warningAccepted}
          onClick={() => setWarningAccepted((accepted) => !accepted)}
        >
          {warningAccepted
            ? 'Potwierdzono ostrzeżenie o nieszyfrowanej kopii'
            : 'Rozumiem, że kopia jest nieszyfrowana i zawiera wrażliwe dane'}
        </button>
        <label className="form-field">
          <span>Budżet do utworzenia kopii</span>
          <select
            aria-label="Budżet do utworzenia kopii"
            value={effectiveTargetBudgetId}
            disabled={busy || !budgets?.length}
            onChange={(event) => setTargetBudgetId(event.target.value)}
          >
            {(budgets ?? []).map((budget) => (
              <option key={budget.budget_id} value={budget.budget_id}>
                {budget.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !targetBudget || !warningAccepted}
          onClick={() => void createManualBackup()}
        >
          Utwórz kopię lokalną
        </button>
      </section>

      <section className="dashboard-card">
        <p className="eyebrow">ODTWARZANIE</p>
        <h2>Odtwórz kopię</h2>
        <p>
          Wybierz istniejący budżet docelowy. Kopia nie przywraca członkostw ani
          uprawnień.
        </p>
        <button type="button" disabled={busy} onClick={() => void selectBackupFile()}>
          Wybierz plik kopii
        </button>
        {summary && backup && (
          <section aria-label="Podsumowanie kopii">
            <h3>Podsumowanie wybranej kopii</h3>
            <dl>
              <dt>Data kopii</dt>
              <dd>{summarizeTimestamp(summary.created_at)}</dd>
              <dt>Budżet źródłowy</dt>
              <dd>{summary.budget_name}</dd>
              <dt>Zakres danych</dt>
              <dd>
                {Object.entries(summary.record_counts)
                  .filter(([, count]) => count > 0)
                  .map(([name, count]) => `${name}: ${count}`)
                  .join('; ') || 'Puste zbiory'}
                {`; pliki wyciągów: ${summary.statement_file_count}`}
              </dd>
            </dl>
          </section>
        )}
        {budgets && budgets.length > 0 && (
          <>
            <label className="form-field">
              <span>Istniejący budżet docelowy</span>
              <select
                aria-label="Istniejący budżet docelowy"
                value={effectiveTargetBudgetId}
                disabled={busy}
                onChange={(event) => {
                  setTargetBudgetId(event.target.value);
                  setMergePlan(null);
                  setRestorePayload(null);
                }}
              >
                {budgets.map((budget) => (
                  <option key={budget.budget_id} value={budget.budget_id}>
                    {budget.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Tryb odtwarzania</legend>
              <label>
                <input
                  type="radio"
                  name="restore-mode"
                  checked={mode === 'replace'}
                  disabled={busy || !backup}
                  onChange={() => chooseMode('replace')}
                />{' '}
                Zastąpienie — zastąp wszystkie dane budżetu
              </label>
              <label>
                <input
                  type="radio"
                  name="restore-mode"
                  checked={mode === 'merge'}
                  disabled={busy || !backup}
                  onChange={() => chooseMode('merge')}
                />{' '}
                Scalenie — zachowaj dane bieżące i dodaj dane kopii
              </label>
            </fieldset>
            {mode === 'replace' && (
              <button
                type="button"
                aria-pressed={replaceConfirmed}
                disabled={busy}
                onClick={() =>
                  setReplaceConfirmed((confirmed) => !confirmed)
                }
              >
                {replaceConfirmed
                  ? 'Zastąpienie danych potwierdzone'
                  : 'Potwierdzam zastąpienie danych wybranego budżetu'}
              </button>
            )}
            {mode === 'merge' && (
              <>
                <button
                  type="button"
                  disabled={busy || !backup || !targetBudget}
                  onClick={() => void prepareMerge()}
                >
                  Porównaj i przygotuj scalenie
                </button>
                {mergePlan && conflicts.length > 0 && (
                  <section aria-label="Konflikty scalenia">
                    <h3>Rozstrzygnij każdy konflikt</h3>
                    {conflicts.map((conflict) => {
                      const key = recordKey(conflict);
                      return (
                        <article key={key} className="dashboard-card">
                          <h4>
                            {conflict.collection} / {conflict.document_id}
                          </h4>
                          <p>Bieżący rekord</p>
                          <pre>{JSON.stringify(conflict.current.data, null, 2)}</pre>
                          <p>Rekord z kopii</p>
                          <pre>{JSON.stringify(conflict.incoming.data, null, 2)}</pre>
                          <label>
                            Rozstrzygnięcie dla {key}
                            <select
                              aria-label={`Rozstrzygnięcie dla ${key}`}
                              value={mergeChoices[key] ?? ''}
                              disabled={busy}
                              onChange={(event) => {
                                if (
                                  event.target.value === 'current' ||
                                  event.target.value === 'incoming'
                                ) {
                                  chooseConflict(
                                    conflict,
                                    event.target.value,
                                  );
                                }
                              }}
                            >
                              <option value="">Wybierz…</option>
                              <option value="current">Zachowaj bieżący</option>
                              <option value="incoming">Użyj kopii</option>
                            </select>
                          </label>
                        </article>
                      );
                    })}
                  </section>
                )}
              </>
            )}
            {mode === 'merge' && (
              <p>
                Nierozstrzygnięte konflikty: {unresolvedConflicts.length}
              </p>
            )}
            <button
              type="button"
              disabled={
                busy ||
                !backup ||
                !restorePayload ||
                !warningAccepted ||
                !mode ||
                (mode === 'replace' && !replaceConfirmed) ||
                (mode === 'merge' && unresolvedConflicts.length > 0)
              }
              onClick={() => void startRestore()}
            >
              Rozpocznij odtwarzanie
            </button>
          </>
        )}
        {(busy || progress > 0) && (
          <div>
            <progress aria-label="Postęp kopii lub odtwarzania" max={100} value={progress} />
            <span>{progress}%</span>
          </div>
        )}
        {status && (
          <p
            role={status.kind === 'error' ? 'alert' : 'status'}
            className={`status status-${status.kind}`}
          >
            {status.message}
          </p>
        )}
      </section>
    </div>
  );
}
