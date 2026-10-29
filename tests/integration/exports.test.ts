import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SaveReportPdfRequest } from '../../src/shared/contracts';
import {
  configurationToJson,
  transactionRowsToCsv,
  transactionRowsToXlsx,
  type TransactionExportRow,
} from '../../src/shared/domain/exports';
import { createReportPdf } from '../../src/main/exportPdf';
import {
  describeExportError,
  validatePdfReport,
  writeExportAtomically,
} from '../../src/main/exportFiles';
import ExcelJS from 'exceljs';

let exportDirectory: string;

function excelBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const rows: TransactionExportRow[] = [
  {
    date: '2026-03-10',
    description: 'Artykuły',
    type: 'EXPENSE',
    amount: '35.0000',
    currency: 'CHF',
    category: 'Jedzenie',
    visibility: 'Widoczna',
  },
  {
    date: '',
    description: 'Transakcja ukryta',
    type: '',
    amount: '',
    currency: '',
    category: '',
    visibility: 'Ukryta',
  },
];

const pdfRequest: SaveReportPdfRequest = {
  fileName: 'raport-2026-03',
  report: {
    period: { start: '2026-03-01', end: '2026-03-31' },
    currency: 'CHF',
    income: '100.0000',
    expenses: '35.0000',
    cash_flow: '65.0000',
    hidden_transactions_included: true,
    expenses_by_category: [{ category_name: 'Jedzenie', amount: '35.0000' }],
  },
};

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const value = content.replace(/^\uFEFF/, '');
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted && character === '"' && value[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('Stage 7 export file contents', () => {
  beforeEach(async () => {
    exportDirectory = await mkdtemp(join(tmpdir(), 'income-tracker-export-'));
  });

  afterEach(async () => {
    await rm(exportDirectory, { recursive: true, force: true });
  });

  it('writes and reads CSV, XLSX, JSON, and PDF content and metadata', async () => {
    const csvPath = join(exportDirectory, 'transactions.csv');
    await writeExportAtomically(
      csvPath,
      new TextEncoder().encode(transactionRowsToCsv(rows)),
    );
    const csvRows = parseCsv(await readFile(csvPath, 'utf8'));
    expect(csvRows[0]).toEqual([
      'Data',
      'Opis',
      'Typ',
      'Kwota',
      'Waluta źródłowa',
      'Kategoria',
      'Widoczność',
    ]);
    expect(csvRows[1]).toEqual([
      '2026-03-10',
      'Artykuły',
      'EXPENSE',
      '35.0000',
      'CHF',
      'Jedzenie',
      'Widoczna',
    ]);
    expect(csvRows[2]).toEqual([
      '',
      'Transakcja ukryta',
      '',
      '',
      '',
      '',
      'Ukryta',
    ]);

    const xlsxPath = join(exportDirectory, 'transactions.xlsx');
    await writeExportAtomically(xlsxPath, await transactionRowsToXlsx(rows));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelBuffer(await readFile(xlsxPath)));
    const sheet = workbook.getWorksheet('Transakcje');
    expect(sheet?.getRow(2).getCell(2).text).toBe('Artykuły');
    expect(sheet?.getRow(2).getCell(4).text).toBe('35.0000');
    expect(sheet?.getRow(3).getCell(2).text).toBe('Transakcja ukryta');
    expect(sheet?.getRow(3).getCell(4).text).toBe('');

    const jsonPath = join(exportDirectory, 'settings.json');
    const configuration = configurationToJson(
      {
        user_id: 'user-1',
        primary_currency: 'CHF',
        secondary_currencies: ['EUR'],
      },
      'Budżet',
      [],
      [],
      [],
    );
    await writeExportAtomically(
      jsonPath,
      new TextEncoder().encode(configuration),
    );
    const parsedConfiguration = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(parsedConfiguration.application_settings.primary_currency).toBe(
      'CHF',
    );
    expect(parsedConfiguration).not.toHaveProperty('transactions');

    const pdfPath = join(exportDirectory, 'report.pdf');
    const pdfBytes = await createReportPdf(pdfRequest);
    await writeExportAtomically(pdfPath, pdfBytes);
    const pdfFile = await readFile(pdfPath);
    const pdf = await getDocument({
      data: new Uint8Array(pdfFile),
      useSystemFonts: true,
    }).promise;
    const metadata = await pdf.getMetadata();
    const page = await pdf.getPage(1);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    const title =
      'Title' in metadata.info && typeof metadata.info.Title === 'string'
        ? metadata.info.Title
        : '';
    expect(title).toContain('2026-03-01');
    expect(text).toContain('2026-03-01');
    expect(text).toContain('CHF');
    expect(text).toContain('100.0000');
    expect(text).toContain('35.0000');
    expect(text).toContain('Jedzenie');
    expect(text).toContain('transakcje ukryte');
  });

  it('does not leave a partial temporary file after an atomic write failure', async () => {
    const destinationDirectory = join(exportDirectory, 'is-a-directory');
    await mkdir(destinationDirectory);

    await expect(
      writeExportAtomically(destinationDirectory, new Uint8Array([1, 2, 3])),
    ).rejects.toThrow();
    expect(await readdir(exportDirectory)).toEqual(['is-a-directory']);
  });

  it('validates full-month PDF periods and reports storage errors explicitly', () => {
    expect(validatePdfReport(pdfRequest.report)).toBe(true);
    expect(
      validatePdfReport({
        ...pdfRequest.report,
        period: { start: '2026-02-01', end: '2026-02-28' },
      }),
    ).toBe(true);
    expect(
      validatePdfReport({
        ...pdfRequest.report,
        period: { start: '2026-02-01', end: '2026-02-27' },
      }),
    ).toBe(false);
    expect(
      validatePdfReport({
        ...pdfRequest.report,
        period: { start: '2026-12-01', end: '2027-01-31' },
      }),
    ).toBe(true);

    expect(
      describeExportError(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      ),
    ).toContain('Brak uprawnień');
    expect(
      describeExportError(Object.assign(new Error('full'), { code: 'ENOSPC' })),
    ).toContain('Brak miejsca');
  });
});
