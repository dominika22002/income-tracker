import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type {
  AccountView,
  CategorizationRuleView,
  CategoryView,
  TransactionView,
  UserPreferencesRecord,
} from '../../src/shared/contracts';
import {
  configurationToJson,
  transactionExportRows,
  transactionRowsToCsv,
  transactionRowsToXlsx,
} from '../../src/shared/domain/exports';

const food: CategoryView = {
  category_id: 'food',
  budget_id: 'budget-1',
  parent_category_id: null,
  name: 'Jedzenie',
  kind: 'EXPENSE',
  expense_nature: 'VARIABLE',
  sort_order: 0,
  archived_at: null,
};

const travel: CategoryView = {
  ...food,
  category_id: 'travel',
  name: 'Podróże',
  sort_order: 1,
};

const account: AccountView = {
  account_id: 'account-1',
  budget_id: 'budget-1',
  owner_membership_id: 'owner',
  label: 'Konto CHF',
  currency: 'CHF',
  account_type: 'CHECKING',
  archived_at: null,
};

function transaction(
  overrides: Partial<TransactionView> = {},
): TransactionView {
  return {
    transaction_id: 'transaction-1',
    budget_id: 'budget-1',
    account_id: 'account-1',
    account_label: 'Konto CHF',
    account_owner_membership_id: 'owner',
    import_batch_id: null,
    imported_by_membership_id: null,
    bank_transaction_id: null,
    operation_date: '2026-03-10',
    description: 'Zakupy spożywcze',
    amount: '100.0000',
    currency: 'CHF',
    type: 'EXPENSE',
    category_id: 'food',
    category_name: 'Jedzenie',
    note: null,
    tags: [],
    ...overrides,
  };
}

const splitTransaction = transaction({
  split_items: [
    {
      split_item_id: 'split-1',
      budget_id: 'budget-1',
      transaction_id: 'transaction-1',
      category_id: 'food',
      amount: '35.0000',
      expense_frequency: null,
      description: 'Artykuły',
      note: null,
      position: 0,
    },
    {
      split_item_id: 'split-2',
      budget_id: 'budget-1',
      transaction_id: 'transaction-1',
      category_id: 'travel',
      amount: '65.0000',
      expense_frequency: null,
      description: 'Bilet',
      note: null,
      position: 1,
    },
  ],
});

const hiddenTransaction = transaction({
  transaction_id: 'hidden-1',
  operation_date: '2026-03-20',
  description: 'Tajemny wydatek',
  amount: '900.0000',
  hidden_mode: 'TRANSACTION',
  hidden_until: null,
  hidden_by_membership_id: 'owner',
  category_id: 'food',
  category_name: 'Jedzenie',
});

const normalTransaction = transaction({
  transaction_id: 'normal-1',
  operation_date: '2026-04-15',
  description: '=WEBSERVICE("unsafe")',
  amount: '5.0000',
  category_id: null,
  category_name: null,
  split_items: [],
});

const allTransactions = [
  splitTransaction,
  hiddenTransaction,
  normalTransaction,
];

function excelBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

describe('Stage 7 export formatting and filtering', () => {
  it('exports split components without repeating the source total and redacts hidden records', () => {
    const rows = transactionExportRows(
      allTransactions,
      [food, travel],
      'other',
      new Date('2026-04-30T12:00:00Z'),
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: '2026-03-10',
          description: 'Artykuły',
          amount: '35.0000',
          currency: 'CHF',
          category: 'Jedzenie',
          visibility: 'Widoczna',
        }),
        expect.objectContaining({
          date: '2026-03-10',
          description: 'Bilet',
          amount: '65.0000',
          category: 'Podróże',
        }),
        expect.objectContaining({
          date: '',
          description: 'Transakcja ukryta',
          type: '',
          amount: '',
          currency: '',
          category: '',
          visibility: 'Ukryta',
        }),
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.amount)).not.toContain('100.0000');
    expect(JSON.stringify(rows)).not.toContain('Tajemny wydatek');
    expect(JSON.stringify(rows)).not.toContain('900.0000');
  });

  it('applies date and active transaction filters without exposing hidden details', () => {
    const dated = transactionExportRows(
      allTransactions,
      [food, travel],
      'other',
      new Date('2026-04-30T12:00:00Z'),
      {
        filters: { dateFrom: '2026-03-01', dateTo: '2026-03-31' },
        sort: { field: 'operation_date', direction: 'asc' },
      },
    );
    expect(dated).toHaveLength(3);
    expect(dated.map((row) => row.description)).toContain('Transakcja ukryta');

    const searched = transactionExportRows(
      allTransactions,
      [food, travel],
      'other',
      new Date('2026-04-30T12:00:00Z'),
      {
        filters: { search: 'Zakupy' },
        sort: { field: 'operation_date', direction: 'desc' },
      },
    );
    expect(searched.map((row) => row.description)).toEqual([
      'Artykuły',
      'Bilet',
    ]);

    const formula = transactionExportRows(
      [normalTransaction],
      [food, travel],
      'owner',
      new Date('2026-04-30T12:00:00Z'),
    );
    expect(transactionRowsToCsv(formula)).toContain(
      `"'=WEBSERVICE(""unsafe"")"`,
    );
  });

  it('serializes CSV and creates an XLSX workbook that reopens with the same rows', async () => {
    const rows = transactionExportRows(
      [splitTransaction],
      [food, travel],
      'owner',
      new Date('2026-04-30T12:00:00Z'),
    );
    const csv = transactionRowsToCsv(rows);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"Data","Opis","Typ","Kwota","Waluta źródłowa"');
    expect(csv).toContain('"Bilet","EXPENSE","65.0000","CHF","Podróże"');

    const bytes = await transactionRowsToXlsx(rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelBuffer(bytes));
    const sheet = workbook.getWorksheet('Transakcje');
    if (!sheet) throw new Error('Transaction worksheet was not created.');
    expect(
      Array.from(
        { length: 7 },
        (_, index) => sheet.getRow(2).getCell(index + 1).text,
      ),
    ).toEqual([
      '2026-03-10',
      'Artykuły',
      'EXPENSE',
      '35.0000',
      'CHF',
      'Jedzenie',
      'Widoczna',
    ]);
    expect(sheet?.rowCount).toBe(3);
  });

  it('exports only configuration fields and never includes transaction or secret data', () => {
    const preferences: UserPreferencesRecord = {
      user_id: 'user-1',
      primary_currency: 'CHF',
      secondary_currencies: ['EUR'],
    };
    const rule: CategorizationRuleView = {
      rule_id: 'rule-1',
      budget_id: 'budget-1',
      category_id: 'food',
      category_name: 'Jedzenie',
      source: 'USER',
      match_field: 'DESCRIPTION',
      operator: 'CONTAINS',
      match_value: 'market',
      priority: 2,
      enabled: true,
    };
    const json = configurationToJson(
      preferences,
      'Budżet osobisty',
      [account],
      [food, travel],
      [rule],
    );
    const configuration = JSON.parse(json) as {
      currencies: string[];
      budget: { categories: unknown[]; categorization_rules: unknown[] };
    };

    expect(configuration.currencies).toEqual(['CHF', 'EUR']);
    expect(configuration.budget.categories).toHaveLength(2);
    expect(configuration.budget.categorization_rules).toHaveLength(1);
    expect(json).not.toContain('Tajemny wydatek');
    expect(json).not.toContain('transaction_id');
    expect(json).not.toMatch(/password|token|secret|credential/i);
  });
});
