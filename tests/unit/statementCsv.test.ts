import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatementCsv } from '../../src/shared/domain/statementCsv';

function fixture(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'tests/fixtures/import', name),
    'utf8',
  );
}

describe('statement CSV parser (U-FR-12, U-FR-13, U-FR-16)', () => {
  it('recognizes history profile, preserves fee and balance, and flags pending or invalid rows', () => {
    const preview = parseStatementCsv(fixture('history-synthetic.csv'));

    expect(preview).toMatchObject({
      status: 'ready',
      profileId: 'history-v1',
      parserVersion: '1.0.0',
      delimiter: ',',
    });
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows[0]).toMatchObject({
      status: 'ready',
      decision: 'include',
      operationDate: '2026-03-01',
      description: 'Sklep testowy, artykuły',
      amount: '12.34',
      transactionType: 'EXPENSE',
      fee: '0.30',
      currency: 'CHF',
      balance: '987.66',
      balanceCurrency: 'CHF',
    });
    expect(preview.rows[1]).toMatchObject({
      status: 'needs_review',
      decision: 'pending',
      operationDate: '2026-03-02',
      transactionType: 'TRANSFER',
      sourceStatus: 'Pending',
    });
    expect(preview.rows[1].issues.join(' ')).toContain('oczekująca');
    expect(preview.rows[2]).toMatchObject({
      rowNumber: 4,
      status: 'error',
      decision: 'pending',
    });
    expect(preview.rows[2].issues.join(' ')).toContain('daty');
  });

  it('recognizes savings profile, handles grouped comma decimals and attached currency', () => {
    const preview = parseStatementCsv(fixture('savings-synthetic.csv'));

    expect(preview.profileId).toBe('savings-v1');
    expect(preview.rows[0]).toMatchObject({
      status: 'ready',
      operationDate: '2026-03-01',
      amount: '1234.50',
      transactionType: 'EXPENSE',
      currency: 'PLN',
      balance: '8765.50',
      balanceCurrency: 'PLN',
    });
    expect(preview.rows[1]).toMatchObject({
      status: 'ready',
      operationDate: '2026-03-02',
      amount: '42.75',
      transactionType: 'INCOME',
      currency: 'EUR',
      balance: '8808.25',
      balanceCurrency: 'EUR',
    });
    expect(preview.rows[2]).toMatchObject({
      status: 'error',
      decision: 'pending',
    });
    expect(preview.rows[2].issues.join(' ')).toContain(
      'jednocześnie wypłatę i wpływ',
    );
  });

  it('detects UTF-8 BOM, honors a corrected separator and custom column mapping', () => {
    const csv = [
      'date;description;withdraw;deposit;balance',
      '4 kwi 2026;Synthetic row;25,00 PLN;;100,00 PLN',
    ].join('\r\n');
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(csv),
    ]);
    const preview = parseStatementCsv(bytes, {
      delimiter: ';',
      profileId: 'savings-v1',
      mapping: {
        date: 'date',
        description: 'description',
        withdrawal: 'withdraw',
        income: 'deposit',
        balance: 'balance',
      },
    });

    expect(preview).toMatchObject({
      status: 'ready',
      profileId: 'savings-v1',
      encoding: 'utf-8-bom',
      delimiter: ';',
    });
    expect(preview.rows[0]).toMatchObject({
      status: 'ready',
      operationDate: '2026-04-04',
      description: 'Synthetic row',
      amount: '25.00',
    });
  });

  it('falls back to Windows-1250 for legacy Polish text without a BOM', () => {
    const bytes = new Uint8Array([
      0x4e, 0x61, 0x7a, 0x77, 0x61, 0xb3, 0x2c, 0x4f, 0x70, 0x69, 0x73, 0x0a,
      0x61, 0x2c, 0x62,
    ]);
    const preview = parseStatementCsv(bytes);

    expect(preview.encoding).toBe('windows-1250');
    expect(preview.headers).toEqual(['Nazwał', 'Opis']);
  });

  it('leaves unknown profile rows visible and pending instead of dropping them', () => {
    const preview = parseStatementCsv(
      'when,what,value\n2026-03-01,Synthetic,3.00',
    );

    expect(preview.status).toBe('unsupported');
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      status: 'unrecognized',
      decision: 'pending',
      rawValues: {
        when: '2026-03-01',
        what: 'Synthetic',
        value: '3.00',
      },
    });
  });

  it('reports empty files, headers without rows and malformed quoted CSV', () => {
    expect(parseStatementCsv('  ').status).toBe('empty');
    expect(
      parseStatementCsv(
        'Rodzaj,Produkt,Data rozpoczęcia,Data zrealizowania,Opis,Kwota,Opłata,Waluta,State,Saldo',
      ).errors[0],
    ).toContain('nie zawiera wierszy');
    expect(parseStatementCsv('a,b\n"broken').status).toBe('invalid');
  });
});
