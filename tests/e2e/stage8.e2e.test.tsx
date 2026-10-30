import React from 'react';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { setLogLevel } from 'firebase/firestore';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  IpcApi,
  SaveBackupFileRequest,
} from '../../src/shared/contracts';
import { createBackupFile } from '../../src/shared/domain/backup';
import { BudgetApp } from '../../src/renderer/src/features/budgets/BudgetApp';
import { adminDb, clearFirestore, TestClock } from '../integration/helpers';
import { createRulesEnv, servicesFor, type TestUser } from './harness';

const OWNER: TestUser = {
  uid: 'stage8-owner',
  email: 'stage8-owner@example.test',
  displayName: 'Stage 8 Owner',
};

describe('Stage 8 backup and restore flow (E-FR-68–E-FR-85)', () => {
  let env: RulesTestEnvironment;
  const clock = new TestClock();

  beforeAll(async () => {
    setLogLevel('silent');
    configure({ asyncUtilTimeout: 8000 });
    env = await createRulesEnv();
  });
  beforeEach(clearFirestore);
  afterEach(cleanup);
  afterAll(async () => env.cleanup());

  it('warns before saving, selects and summarizes a backup, then reports replacement progress', async () => {
    const owner = servicesFor(env, OWNER, clock);
    await owner.services.backend.ensureUserProfile();
    const budget = await owner.services.backend.createBudget({
      name: 'Stage 8 budget',
    });
    const account = await owner.services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic account',
      currency: 'PLN',
      account_type: 'CHECKING',
    });
    await owner.services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Synthetic stage 8 purchase',
      amount: '12.0000',
      currency: 'PLN',
      type: 'EXPENSE',
    });
    const payload = await owner.services.backend.exportBudgetBackup({
      budget_id: budget.budget_id,
    });
    const selectedContent = await createBackupFile(payload);
    const exportSnapshot = vi.spyOn(
      owner.services.data,
      'exportBudgetSnapshot',
    );
    let savedContent = '';
    const api: IpcApi = {
      ping: async () => ({ ok: true, message: 'test' }),
      saveExportFile: async () => ({ status: 'canceled' }),
      saveReportPdf: async () => ({ status: 'canceled' }),
      selectLocalFile: async () => ({ canceled: true }),
      readLocalStatement: async () => ({ success: false }),
      saveBackupFile: vi.fn(async (request: SaveBackupFileRequest) => {
        savedContent = request.content;
        return {
          status: 'saved' as const,
          filePath: 'C:\\backups\\stage8.json',
        };
      }),
      selectBackupFile: async () => ({
        status: 'selected',
        content: selectedContent,
        fileName: 'stage8.json',
      }),
      archiveImportedStatement: async () => ({
        status: 'saved',
        filePath: 'C:\\local\\statement.csv',
      }),
      listLocalStatementFiles: async () => ({ status: 'loaded', files: [] }),
      restoreLocalStatementFiles: async () => ({ status: 'saved', count: 0 }),
      writeTestFile: async () => ({ success: false }),
      startGoogleOAuth: async () => ({ launched: false }),
      onOAuthCallback: () => () => undefined,
    };
    Object.defineProperty(window, 'electronApi', {
      configurable: true,
      value: api,
    });
    await owner.auth.signIn();
    render(
      <BudgetApp services={owner.services} activeView="settings" />,
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Kopie zapasowe i odzyskiwanie',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/plik kopii nie jest szyfrowany/i),
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByRole('option', { name: 'Stage 8 budget' })).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: 'Utwórz kopię lokalną' }),
    ).toBeDisabled();
    const warning = screen.getByRole('button', {
      name: /rozumiem, że kopia jest nieszyfrowana/i,
    });
    fireEvent.click(warning);
    await waitFor(() =>
      expect(warning).toHaveAttribute('aria-pressed', 'true'),
    );
    const createBackup = screen.getByRole('button', {
      name: 'Utwórz kopię lokalną',
    });
    expect(createBackup).toBeEnabled();
    fireEvent.click(createBackup);
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(api.saveBackupFile).toHaveBeenCalled(),
    );
    expect(savedContent).toContain('income-tracker-backup');

    fireEvent.click(screen.getByRole('button', { name: 'Wybierz plik kopii' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Podsumowanie wybranej kopii',
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Stage 8 budget').length).toBeGreaterThan(0);
    expect(screen.getByText(/transactions: 1/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('radio', {
        name: /zastąpienie — zastąp wszystkie dane budżetu/i,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: /potwierdzam zastąpienie danych wybranego budżetu/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rozpocznij odtwarzanie' }));

    expect(
      await screen.findByText('Odtwarzanie danych budżetu zakończone.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', {
        name: 'Postęp kopii lub odtwarzania',
      }),
    ).toHaveAttribute('value', '100');
    expect(
      await adminDb().doc(`budgets/${budget.budget_id}`).get(),
    ).toBeDefined();
    expect(
      (await adminDb().doc(`budgets/${budget.budget_id}`).get()).get(
        'active_revision_id',
      ),
    ).toBeTruthy();
  });
});
