import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountView,
  IpcApi,
  MyBudgetView,
} from '../../src/shared/contracts';
import type { AppServices } from '../../src/renderer/src/backend/ports';
import { StatementCsvPreview } from '../../src/renderer/src/features/imports/StatementCsvPreview';

function mockApi(): IpcApi {
  return {
    ping: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    saveExportFile: vi.fn().mockResolvedValue({ status: 'canceled' }),
    saveReportPdf: vi.fn().mockResolvedValue({ status: 'canceled' }),
    selectLocalFile: vi.fn().mockResolvedValue({
      canceled: false,
      filePath: 'C:\\local\\synthetic.csv',
    }),
    readLocalStatement: vi.fn().mockResolvedValue({
      success: true,
      filePath: 'C:\\local\\synthetic.csv',
      fileName: 'synthetic.csv',
      extension: 'csv',
      mimeType: 'text/csv',
      fileSizeBytes: 120,
      fileSha256: '0'.repeat(64),
      contentBase64: Buffer.from(
        readFileSync(
          resolve(process.cwd(), 'tests/fixtures/import/history-synthetic.csv'),
        ),
      ).toString('base64'),
    }),
    writeTestFile: vi.fn().mockResolvedValue({ success: true }),
    startGoogleOAuth: vi.fn().mockResolvedValue({ launched: true }),
    onOAuthCallback: vi.fn().mockReturnValue(() => undefined),
  };
}

describe('StatementCsvPreview', () => {
  const budget: MyBudgetView = {
    budget_id: 'budget-1',
    name: 'Synthetic budget',
    membership_id: 'membership-1',
    role: 'ADMIN',
  };
  const account: AccountView = {
    account_id: 'account-1',
    budget_id: budget.budget_id,
    owner_membership_id: budget.membership_id,
    label: 'Synthetic checking',
    currency: 'CHF',
    account_type: 'CHECKING',
    archived_at: null,
  };
  const commitCsvImport = vi.fn().mockResolvedValue({
    import_batch_id: 'batch-1',
    imported_row_count: 1,
    skipped_duplicate_row_numbers: [],
    periods: [{ period_start: '2026-03-01', period_end: '2026-03-01' }],
    already_imported: false,
  });
  const services = {
    backend: {
      createAccount: vi
        .fn()
        .mockResolvedValue({ account_id: account.account_id }),
      commitCsvImport,
    },
    data: {
      subscribeAccounts: (
        ...args: Parameters<AppServices['data']['subscribeAccounts']>
      ) => {
        args[2]([account]);
        return () => undefined;
      },
    },
  };

  beforeEach(() => {
    window.electronApi = mockApi();
    commitCsvImport.mockClear();
  });
  afterEach(cleanup);

  it('reads only the picker-selected local CSV and presents parsed rows for review', async () => {
    render(<StatementCsvPreview services={services} budgets={[budget]} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Wybierz lokalny CSV' }),
    );

    expect(await screen.findByText('Plik: synthetic.csv')).toBeInTheDocument();
    expect(await screen.findByText('Wiersz 2 — ready')).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Opis — wiersz 2' }),
    ).toHaveValue('Sklep testowy, artykuły');
    expect(
      screen.getByText(/Plik ani jego zawartość nie zostały wysłane/),
    ).toBeInTheDocument();
    expect(window.electronApi.readLocalStatement).toHaveBeenCalledWith({
      filePath: 'C:\\local\\synthetic.csv',
    });
    const invalidRow = screen.getByText('Wiersz 4 — error').closest('li');
    if (!invalidRow) throw new Error('Expected the invalid row list item.');
    fireEvent.change(
      within(invalidRow).getByRole('textbox', { name: 'Data — wiersz 4' }),
      { target: { value: '2026-03-03' } },
    );
    fireEvent.change(
      within(invalidRow).getByRole('textbox', { name: 'Kwota — wiersz 4' }),
      { target: { value: '5.00' } },
    );
    expect(
      within(invalidRow).getByRole('heading', {
        name: 'Wiersz 4 — ready',
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(invalidRow).getByRole('button', { name: 'Uwzględnij wiersz' }),
    );
    expect(
      within(invalidRow).getByText('Decyzja: include'),
    ).toBeInTheDocument();

    fireEvent.change(
      within(invalidRow).getByRole('textbox', { name: 'Data — wiersz 4' }),
      { target: { value: 'not-a-date' } },
    );
    expect(
      within(invalidRow).getByRole('heading', {
        name: 'Wiersz 4 — error',
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(invalidRow).getByRole('button', {
        name: 'Jawnie wyklucz wiersz',
      }),
    );
    expect(
      within(invalidRow).getByText('Decyzja: exclude'),
    ).toBeInTheDocument();
  });

  it('explains why import approval is disabled', async () => {
    render(<StatementCsvPreview services={services} budgets={[budget]} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Wybierz lokalny CSV' }),
    );
    await screen.findByText('Plik: synthetic.csv');

    expect(
      screen.getByRole('button', { name: 'Zatwierdź import' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Nie można zatwierdzić importu:.*Wybierz budżet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Dla każdego wiersza wybierz/)).toBeInTheDocument();
  });

  it('commits only reviewed transaction fields and the local file hash', async () => {
    const { container } = render(
      <StatementCsvPreview services={services} budgets={[budget]} />,
    );
    fireEvent.click(
      within(container).getByRole('button', { name: 'Wybierz lokalny CSV' }),
    );
    expect(
      await within(container).findByText('Plik: synthetic.csv'),
    ).toBeInTheDocument();
    fireEvent.change(within(container).getByLabelText('Budżet importu'), {
      target: { value: budget.budget_id },
    });
    expect(
      await within(container).findByLabelText('Konto źródłowe'),
    ).toBeInTheDocument();
    fireEvent.change(within(container).getByLabelText('Konto źródłowe'), {
      target: { value: account.account_id },
    });

    const previewRows = Array.from(container.querySelectorAll('li.import-row'));
    for (const row of previewRows) {
      const rowUi = within(row as HTMLElement);
      const include = rowUi.getByRole('button', {
        name: 'Uwzględnij wiersz',
      });
      fireEvent.click(
        include.hasAttribute('disabled')
          ? rowUi.getByRole('button', { name: 'Jawnie wyklucz wiersz' })
          : include,
      );
    }

    fireEvent.click(
      within(container).getByRole('button', { name: 'Zatwierdź import' }),
    );
    expect(
      await within(container).findByText(/Import zatwierdzono: 1 transakcji/),
    ).toBeInTheDocument();
    expect(commitCsvImport).toHaveBeenCalledWith(
      expect.objectContaining({
        budget_id: budget.budget_id,
        account_id: account.account_id,
        file_sha256: '0'.repeat(64),
        parser_id: 'history-v1',
        parser_version: '1.0.0',
      }),
    );
    const sentPayload = commitCsvImport.mock.calls[0][0] as {
      rows: Array<{ decision: string }>;
    };
    expect(JSON.stringify(sentPayload)).not.toContain('filePath');
    expect(JSON.stringify(sentPayload)).not.toContain('contentBase64');
    expect(sentPayload.rows.some((row) => row.decision === 'include')).toBe(
      true,
    );
  });

  it('requires an explicit choice when the backend flags a possible duplicate', async () => {
    commitCsvImport.mockRejectedValueOnce(
      Object.assign(new Error('Row 2 may duplicate an existing transaction.'), {
        code: 'DUPLICATE_REVIEW_REQUIRED',
      }),
    );
    const { container } = render(
      <StatementCsvPreview services={services} budgets={[budget]} />,
    );
    fireEvent.click(
      within(container).getByRole('button', { name: 'Wybierz lokalny CSV' }),
    );
    await within(container).findByText('Plik: synthetic.csv');
    fireEvent.change(within(container).getByLabelText('Budżet importu'), {
      target: { value: budget.budget_id },
    });
    fireEvent.change(
      await within(container).findByLabelText('Konto źródłowe'),
      {
        target: { value: account.account_id },
      },
    );
    const previewRows = Array.from(container.querySelectorAll('li.import-row'));
    for (const row of previewRows) {
      const rowUi = within(row as HTMLElement);
      const include = rowUi.getByRole('button', {
        name: 'Uwzględnij wiersz',
      });
      fireEvent.click(
        include.hasAttribute('disabled')
          ? rowUi.getByRole('button', { name: 'Jawnie wyklucz wiersz' })
          : include,
      );
    }

    fireEvent.click(
      within(container).getByRole('button', { name: 'Zatwierdź import' }),
    );
    const row = container.querySelector('li.import-row');
    if (!row) throw new Error('Expected the duplicate candidate row.');
    const rowUi = within(row as HTMLElement);
    expect(await rowUi.findByText(/może być duplikatem/)).toBeInTheDocument();
    fireEvent.click(
      rowUi.getByRole('button', { name: 'To nie duplikat — importuj' }),
    );
    fireEvent.click(
      within(container).getByRole('button', { name: 'Zatwierdź import' }),
    );
    expect(
      await within(container).findByText(/Import zatwierdzono/),
    ).toBeInTheDocument();
    expect(commitCsvImport).toHaveBeenCalledTimes(2);
  });
});
