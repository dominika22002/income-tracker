import React from 'react';
import ExcelJS from 'exceljs';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
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
  ExportFileResult,
  IpcApi,
  SaveExportFileRequest,
  SaveReportPdfRequest,
} from '../../src/shared/contracts';
import { BudgetApp } from '../../src/renderer/src/features/budgets/BudgetApp';
import { createReportPdf } from '../../src/main/exportPdf';
import { adminDb, clearFirestore, TestClock } from '../integration/helpers';
import { createRulesEnv, servicesFor, type TestUser } from './harness';

const OWNER: TestUser = {
  uid: 'stage7-owner',
  email: 'stage7-owner@example.test',
  displayName: 'Stage 7 Owner',
};
const VIEWER: TestUser = {
  uid: 'stage7-viewer',
  email: 'stage7-viewer@example.test',
  displayName: 'Stage 7 Viewer',
};

function excelBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

describe('Stage 7 export flows (E-FR-55–E-FR-63)', () => {
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

  it('exports filtered transactions to CSV/XLSX, configuration to JSON, and monthly reports to PDF', async () => {
    const owner = servicesFor(env, OWNER, clock);
    const viewer = servicesFor(env, VIEWER, clock);
    await owner.services.backend.ensureUserProfile();
    const budget = await owner.services.backend.createBudget({
      name: 'Stage 7 export budget',
    });
    const account = await owner.services.backend.createAccount({
      budget_id: budget.budget_id,
      label: 'Synthetic account',
      currency: 'CHF',
      account_type: 'CHECKING',
    });
    const food = await owner.services.backend.saveCategory({
      budget_id: budget.budget_id,
      name: 'Stage 7 food',
      kind: 'EXPENSE',
      expense_nature: 'VARIABLE',
      sort_order: 0,
    });
    const travel = await owner.services.backend.saveCategory({
      budget_id: budget.budget_id,
      name: 'Stage 7 travel',
      kind: 'EXPENSE',
      expense_nature: 'DISCRETIONARY',
      sort_order: 1,
    });
    await owner.services.backend.saveCategorizationRule({
      budget_id: budget.budget_id,
      category_id: food.category_id,
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'market',
      priority: 2,
    });
    const split = await owner.services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-10',
      description: 'Stage 7 market purchase',
      amount: '100.0000',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: food.category_id,
    });
    await owner.services.backend.saveTransactionSplit({
      budget_id: budget.budget_id,
      transaction_id: split.transaction_id,
      items: [
        {
          amount: '40.0000',
          category_id: food.category_id,
          expense_frequency: null,
          description: 'Groceries',
          note: null,
        },
        {
          amount: '60.0000',
          category_id: travel.category_id,
          expense_frequency: null,
          description: 'Train ticket',
          note: null,
        },
      ],
    });
    const privateTransaction = await owner.services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-20',
      description: 'Stage 7 private medical detail',
      amount: '20.0000',
      currency: 'CHF',
      type: 'EXPENSE',
      category_id: travel.category_id,
    });
    await owner.services.backend.setTransactionHidden({
      budget_id: budget.budget_id,
      transaction_id: privateTransaction.transaction_id,
      hidden_mode: 'TRANSACTION',
      hidden_until: null,
    });
    await owner.services.backend.saveTransaction({
      budget_id: budget.budget_id,
      account_id: account.account_id,
      operation_date: '2026-03-01',
      description: 'Stage 7 income',
      amount: '150.0000',
      currency: 'CHF',
      type: 'INCOME',
    });

    await owner.services.backend.ensureUserProfile();
    const invitation = await owner.services.backend.createInvitation({
      budget_id: budget.budget_id,
      invitee_email: VIEWER.email,
    });
    await viewer.services.backend.ensureUserProfile();
    await viewer.services.backend.updatePreferences({
      primary_currency: 'CHF',
      secondary_currencies: ['EUR'],
    });
    const viewerMembership = await viewer.services.backend.acceptInvitation(
      invitation.token,
    );
    expect(viewerMembership.budget_id).toBe(budget.budget_id);

    const savedFiles = new Map<string, Uint8Array>();
    let nextSaveResult: ExportFileResult | null = null;
    const saveExportFile = vi.fn(
      async (request: SaveExportFileRequest): Promise<ExportFileResult> => {
        if (nextSaveResult) {
          const result = nextSaveResult;
          nextSaveResult = null;
          return result;
        }
        const extension = request.format.toLowerCase();
        const filePath = `C:\\exports\\picked-${request.fileName}.${extension}`;
        savedFiles.set(
          filePath,
          new Uint8Array(Buffer.from(request.contentBase64, 'base64')),
        );
        return { status: 'saved', filePath };
      },
    );
    const pdfRequests: SaveReportPdfRequest[] = [];
    const saveReportPdf = vi.fn(
      async (request: SaveReportPdfRequest): Promise<ExportFileResult> => {
        pdfRequests.push(request);
        const filePath = `C:\\exports\\picked-${request.fileName}.pdf`;
        savedFiles.set(filePath, await createReportPdf(request));
        return { status: 'saved', filePath };
      },
    );
    const api: IpcApi = {
      ping: async () => ({ ok: true, message: 'test' }),
      saveExportFile,
      saveReportPdf,
      selectLocalFile: async () => ({ canceled: true }),
      readLocalStatement: async () => ({ success: false }),
      saveBackupFile: async () => ({ status: 'canceled' }),
      selectBackupFile: async () => ({ status: 'canceled' }),
      archiveImportedStatement: async () => ({ status: 'saved', filePath: '' }),
      listLocalStatementFiles: async () => ({
        status: 'loaded',
        files: [],
      }),
      restoreLocalStatementFiles: async () => ({
        status: 'saved',
        count: 0,
      }),
      writeTestFile: async () => ({ success: false }),
      startGoogleOAuth: async () => ({ launched: false }),
      onOAuthCallback: () => () => undefined,
    };
    Object.defineProperty(window, 'electronApi', {
      configurable: true,
      value: api,
    });

    await viewer.auth.signIn();
    const transactionView = render(
      <BudgetApp
        services={viewer.services}
        requireAuth={false}
        activeView="transactions"
      />,
    );
    const transactionUi = within(transactionView.container);
    await transactionUi.findByText('Stage 7 market purchase');

    fireEvent.change(
      transactionUi.getByLabelText('Zakres eksportu transakcji'),
      { target: { value: 'BUDGET' } },
    );
    const csvButton = transactionUi.getByRole('button', {
      name: 'Eksportuj transakcje CSV',
    });
    await waitFor(() => expect(csvButton).toBeEnabled());
    fireEvent.click(csvButton);
    await transactionUi.findByText(/Plik zapisano: C:\\exports\\picked-/);
    const csvRequest = saveExportFile.mock.calls[0][0];
    const csv = Buffer.from(csvRequest.contentBase64, 'base64').toString(
      'utf8',
    );
    expect(csv).toContain('Groceries');
    expect(csv).toContain('Train ticket');
    expect(csv).toContain('Transakcja ukryta');
    expect(csv).not.toContain('100.0000');
    expect(csv).not.toContain('Stage 7 private medical detail');
    expect(csv).not.toContain('20.0000');

    fireEvent.change(
      transactionUi.getByLabelText('Zakres eksportu transakcji'),
      { target: { value: 'DATES' } },
    );
    fireEvent.change(transactionUi.getByLabelText('Od daty eksportu'), {
      target: { value: '2026-03-01' },
    });
    fireEvent.change(transactionUi.getByLabelText('Do daty eksportu'), {
      target: { value: '2026-03-31' },
    });
    const xlsxButton = transactionUi.getByRole('button', {
      name: 'Eksportuj transakcje XLSX',
    });
    await waitFor(() => expect(xlsxButton).toBeEnabled());
    fireEvent.click(xlsxButton);
    await waitFor(() => expect(saveExportFile).toHaveBeenCalledTimes(2));
    const xlsxRequest = saveExportFile.mock.calls[1][0];
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      excelBuffer(Buffer.from(xlsxRequest.contentBase64, 'base64')),
    );
    const worksheet = workbook.getWorksheet('Transakcje');
    expect(worksheet?.getColumn(1).values).toContain('2026-03-10');
    expect(worksheet?.getColumn(2).values).toContain('Groceries');
    expect(worksheet?.getColumn(2).values).toContain('Transakcja ukryta');
    expect(worksheet?.getColumn(2).values).not.toContain(
      'Stage 7 private medical detail',
    );

    const jsonButton = transactionUi.getByRole('button', {
      name: 'Eksportuj konfigurację JSON',
    });
    await waitFor(() => expect(jsonButton).toBeEnabled());
    fireEvent.click(jsonButton);
    await waitFor(() => expect(saveExportFile).toHaveBeenCalledTimes(3));
    const configuration = JSON.parse(
      Buffer.from(saveExportFile.mock.calls[2][0].contentBase64, 'base64')
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as { currencies: string[]; budget: { categorization_rules: unknown[] } };
    expect(configuration.currencies).toEqual(['CHF', 'EUR']);
    expect(configuration.budget.categorization_rules).toHaveLength(1);
    expect(JSON.stringify(configuration)).not.toContain('Stage 7 income');
    expect(JSON.stringify(configuration)).not.toContain('password');
    expect(JSON.stringify(configuration)).not.toContain('token');

    fireEvent.change(
      transactionUi.getByLabelText('Zakres eksportu transakcji'),
      {
        target: { value: 'FILTERS' },
      },
    );
    fireEvent.change(transactionUi.getByLabelText('Szukaj opisu'), {
      target: { value: 'market' },
    });
    await waitFor(() => expect(csvButton).toBeEnabled());
    fireEvent.click(csvButton);
    await waitFor(() => expect(saveExportFile).toHaveBeenCalledTimes(4));
    const filteredCsv = Buffer.from(
      saveExportFile.mock.calls[3][0].contentBase64,
      'base64',
    ).toString('utf8');
    expect(filteredCsv).toContain('Groceries');
    expect(filteredCsv).not.toContain('Transakcja ukryta');

    nextSaveResult = { status: 'canceled' };
    fireEvent.click(
      transactionUi.getByRole('button', { name: 'Eksportuj transakcje CSV' }),
    );
    await transactionUi.findByText(/Anulowano wybór lokalizacji/);
    nextSaveResult = {
      status: 'error',
      error: 'Brak uprawnień do zapisu w wybranej lokalizacji.',
    };
    fireEvent.click(
      transactionUi.getByRole('button', { name: 'Eksportuj transakcje CSV' }),
    );
    await transactionUi.findByText(
      'Brak uprawnień do zapisu w wybranej lokalizacji.',
    );

    transactionView.unmount();
    const reportView = render(
      <BudgetApp
        services={viewer.services}
        requireAuth={false}
        activeView="reports"
      />,
    );
    const reportUi = within(reportView.container);
    fireEvent.change(await reportUi.findByLabelText('Miesiąc początkowy PDF'), {
      target: { value: '2026-03' },
    });
    fireEvent.change(reportUi.getByLabelText('Miesiąc końcowy PDF'), {
      target: { value: '2026-03' },
    });
    const pdfButton = await reportUi.findByRole('button', {
      name: 'Eksportuj raport PDF',
    });
    await waitFor(() => expect(pdfButton).toBeEnabled());
    fireEvent.click(pdfButton);
    await reportUi.findByText(/Raport zapisano: C:\\exports\\picked-/);
    expect(saveReportPdf).toHaveBeenCalledTimes(1);
    expect(pdfRequests[0].report.period).toEqual({
      start: '2026-03-01',
      end: '2026-03-31',
    });
    expect(pdfRequests[0].report.currency).toBe('CHF');
    expect(pdfRequests[0].report.income).toBe('150.0000');
    expect(pdfRequests[0].report.expenses).toBe('120.0000');
    expect(pdfRequests[0].report.hidden_transactions_included).toBe(true);
    expect(JSON.stringify(pdfRequests[0])).not.toContain(
      'Stage 7 private medical detail',
    );
    expect(savedFiles.size).toBe(4);
    expect([...savedFiles.values()].some((file) => file[0] === 0x25)).toBe(
      true,
    );
    expect(
      (
        await adminDb()
          .doc(`transactions/${privateTransaction.transaction_id}`)
          .get()
      ).exists,
    ).toBe(true);
  });
});
