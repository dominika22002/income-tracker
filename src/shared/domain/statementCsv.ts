export type StatementCsvProfileId = 'history-v1' | 'savings-v1';
export type StatementCsvRowStatus =
  'ready' | 'needs_review' | 'error' | 'unrecognized';
export type StatementCsvDecision = 'include' | 'exclude' | 'pending';
export type StatementTransactionType = 'EXPENSE' | 'INCOME' | 'TRANSFER';
export type StatementCsvField =
  | 'startedDate'
  | 'completedDate'
  | 'date'
  | 'description'
  | 'amount'
  | 'fee'
  | 'currency'
  | 'status'
  | 'type'
  | 'balance'
  | 'withdrawal'
  | 'income';

export interface StatementCsvSettings {
  delimiter?: string;
  encoding?: string;
  profileId?: StatementCsvProfileId;
  mapping?: Partial<Record<StatementCsvField, string>>;
}

export interface StatementCsvRow {
  rowNumber: number;
  rawValues: Record<string, string>;
  status: StatementCsvRowStatus;
  decision: StatementCsvDecision;
  issues: string[];
  operationDate: string | null;
  description: string | null;
  amount: string | null;
  transactionType: StatementTransactionType | null;
  fee: string | null;
  currency: string | null;
  sourceStatus: string | null;
  balance: string | null;
  balanceCurrency: string | null;
}

export interface StatementCsvPreview {
  status: 'ready' | 'empty' | 'unsupported' | 'invalid';
  profileId: StatementCsvProfileId | null;
  parserVersion: string | null;
  encoding: string | null;
  delimiter: string | null;
  headers: string[];
  errors: string[];
  rows: StatementCsvRow[];
}

const PROFILE_VERSIONS: Record<StatementCsvProfileId, string> = {
  'history-v1': '1.0.0',
  'savings-v1': '1.0.0',
};

const HISTORY_HEADERS = [
  'Rodzaj',
  'Produkt',
  'Data rozpoczęcia',
  'Data zrealizowania',
  'Opis',
  'Kwota',
  'Opłata',
  'Waluta',
  'State',
  'Saldo',
];
const SAVINGS_HEADERS = [
  'Data',
  'Opis',
  'Wypłata pieniędzy',
  'Wpływy',
  'Saldo',
];

const HISTORY_DEFAULTS: Record<StatementCsvField, string> = {
  startedDate: 'Data rozpoczęcia',
  completedDate: 'Data zrealizowania',
  date: '',
  description: 'Opis',
  amount: 'Kwota',
  fee: 'Opłata',
  currency: 'Waluta',
  status: 'State',
  type: 'Rodzaj',
  balance: 'Saldo',
  withdrawal: '',
  income: '',
};
const SAVINGS_DEFAULTS: Record<StatementCsvField, string> = {
  startedDate: '',
  completedDate: '',
  date: 'Data',
  description: 'Opis',
  amount: '',
  fee: '',
  currency: '',
  status: '',
  type: '',
  balance: 'Saldo',
  withdrawal: 'Wypłata pieniędzy',
  income: 'Wpływy',
};

function decodeBytes(
  input: Uint8Array,
  forcedEncoding?: string,
): { text: string; encoding: string } {
  if (forcedEncoding) {
    try {
      return {
        text: new TextDecoder(forcedEncoding, { fatal: true }).decode(input),
        encoding: forcedEncoding,
      };
    } catch (error) {
      throw new Error(
        `Nie można zdekodować pliku jako ${forcedEncoding}: ${error instanceof Error ? error.message : 'nieznany błąd'}`,
      );
    }
  }

  if (
    input.length >= 3 &&
    input[0] === 0xef &&
    input[1] === 0xbb &&
    input[2] === 0xbf
  ) {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(3)),
      encoding: 'utf-8-bom',
    };
  }
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return {
      text: new TextDecoder('utf-16le', { fatal: true }).decode(
        input.subarray(2),
      ),
      encoding: 'utf-16le',
    };
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    return {
      text: new TextDecoder('utf-16be', { fatal: true }).decode(
        input.subarray(2),
      ),
      encoding: 'utf-16be',
    };
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(input),
      encoding: 'utf-8',
    };
  } catch {
    try {
      return {
        text: new TextDecoder('windows-1250', { fatal: true }).decode(input),
        encoding: 'windows-1250',
      };
    } catch (error) {
      throw new Error(
        `Nieobsługiwane kodowanie pliku: ${error instanceof Error ? error.message : 'nieznany błąd'}`,
      );
    }
  }
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index + 1] === '"' && quoted) {
      index += 1;
    } else if (line[index] === '"') {
      quoted = !quoted;
    } else if (line[index] === delimiter && !quoted) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  return [',', ';', '\t', '|'].sort(
    (left, right) =>
      countDelimiter(firstLine, right) - countDelimiter(firstLine, left),
  )[0];
}

function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0 && !afterQuote) {
      quoted = true;
    } else if (character === delimiter) {
      record.push(field);
      field = '';
      afterQuote = false;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((value) => value.length > 0) || field.length > 0) {
        records.push(record);
      }
      record = [];
      field = '';
      afterQuote = false;
    } else if (afterQuote && character.trim() !== '') {
      throw new Error('Dodatkowe znaki po zamknięciu pola CSV.');
    } else {
      if (afterQuote && character.trim() === '') continue;
      field += character;
    }
  }
  if (quoted) throw new Error('Niezamknięte pole cytowane w pliku CSV.');
  record.push(field);
  if (record.some((value) => value.length > 0) || field.length > 0) {
    records.push(record);
  }
  return records;
}

function identifyProfile(
  headers: string[],
  requested?: StatementCsvProfileId,
): StatementCsvProfileId | null {
  if (requested) return requested;
  const names = new Set(headers.map((header) => header.trim()));
  if (HISTORY_HEADERS.every((header) => names.has(header))) {
    return 'history-v1';
  }
  if (SAVINGS_HEADERS.every((header) => names.has(header))) {
    return 'savings-v1';
  }
  return null;
}

function read(
  row: string[],
  indices: Map<string, number>,
  column: string,
): string {
  const index = indices.get(column);
  return index === undefined ? '' : (row[index] ?? '').trim();
}

function parseIsoDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: \d{2}:\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

const POLISH_MONTHS: Record<string, string> = {
  sty: '01',
  lut: '02',
  mar: '03',
  kwi: '04',
  maj: '05',
  cze: '06',
  lip: '07',
  sie: '08',
  wrz: '09',
  paź: '10',
  paz: '10',
  lis: '11',
  gru: '12',
};

function parsePolishDate(value: string): string | null {
  const match = /^(\d{1,2})\s+([A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ]{3})\s+(\d{4})$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, dayText, monthText, year] = match;
  const month = POLISH_MONTHS[monthText.toLocaleLowerCase('pl-PL')];
  if (!month) return null;
  const day = dayText.padStart(2, '0');
  return parseIsoDate(`${year}-${month}-${day}`);
}

function decimal(value: string, commaDecimal: boolean): string | null {
  const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, '');
  const pattern = commaDecimal
    ? /^([+-]?)(\d+)(?:,(\d{1,4}))?$/
    : /^([+-]?)(\d+)(?:\.(\d{1,4}))?$/;
  const match = pattern.exec(normalized);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

function savingsAmount(
  value: string,
): { amount: string; currency: string } | null {
  const match =
    /^([+-]?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:,\d{1,4})?)\s*([A-Z]{3})$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const amount = decimal(match[1], true);
  return amount ? { amount, currency: match[2] } : null;
}

function normalizeText(value: string): string {
  return value
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pl-PL');
}

function inferTransactionType(value: string): StatementTransactionType | null {
  const normalized = normalizeText(value);
  const hasTransfer = /\b(przelew|transfer)\b/.test(normalized);
  const hasIncome =
    /\b(wplyw|uznanie|przychod|income|refund|zwrot|odsetki)\b/.test(normalized);
  const hasExpense =
    /\b(wyplata|platnosc|zakup|obciazenie|expense|payment|withdrawal)\b/.test(
      normalized,
    );
  const matches = [hasTransfer, hasIncome, hasExpense].filter(Boolean).length;
  if (matches !== 1) return null;
  if (hasTransfer) return 'TRANSFER';
  if (hasIncome) return 'INCOME';
  return 'EXPENSE';
}

function isPendingStatus(value: string): boolean {
  const normalized = normalizeText(value);
  return /pending|oczekuj|w toku|zablok/.test(normalized);
}

function rowResult(
  rowNumber: number,
  rawValues: Record<string, string>,
  operationDate: string | null,
  description: string | null,
  amount: string | null,
  transactionType: StatementTransactionType | null,
  currency: string | null,
  extras: Partial<StatementCsvRow>,
  issues: string[],
): StatementCsvRow {
  const status: StatementCsvRowStatus =
    issues.length === 0
      ? 'ready'
      : issues.some((issue) => issue.startsWith('Nieznany'))
        ? 'unrecognized'
        : issues.some(
              (issue) =>
                issue.startsWith('Nie można') ||
                issue.startsWith('Wiersz') ||
                issue.startsWith('Brak'),
            )
          ? 'error'
          : 'needs_review';
  return {
    rowNumber,
    rawValues,
    status,
    decision: status === 'ready' ? 'include' : 'pending',
    issues,
    operationDate,
    description,
    amount,
    transactionType,
    fee: null,
    currency,
    sourceStatus: null,
    balance: null,
    balanceCurrency: null,
    ...extras,
  };
}

function profileRows(
  profileId: StatementCsvProfileId,
  headers: string[],
  records: string[][],
  settings: StatementCsvSettings,
): StatementCsvRow[] {
  const defaults =
    profileId === 'history-v1' ? HISTORY_DEFAULTS : SAVINGS_DEFAULTS;
  const mapping = { ...defaults, ...settings.mapping };
  const indices = new Map(
    headers.map((header, index) => [header.trim(), index]),
  );
  return records.slice(1).map((values, offset) => {
    const rawValues = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? '']),
    );
    const rowNumber = offset + 2;
    const issues: string[] = [];
    if (values.length !== headers.length) {
      issues.push(
        `Wiersz ma ${values.length} pól, oczekiwano ${headers.length}.`,
      );
    }

    if (profileId === 'history-v1') {
      const completed = read(values, indices, mapping.completedDate);
      const started = read(values, indices, mapping.startedDate);
      const sourceDate = completed || started;
      const operationDate = parseIsoDate(sourceDate);
      if (!operationDate) issues.push('Nie można rozpoznać daty operacji.');

      const description = read(values, indices, mapping.description) || null;
      if (!description) issues.push('Brak opisu transakcji.');

      const amountValue = read(values, indices, mapping.amount);
      const amount = decimal(amountValue, false);
      if (!amount) issues.push('Nie można rozpoznać kwoty transakcji.');

      const feeValue = read(values, indices, mapping.fee);
      const fee = feeValue ? decimal(feeValue, false) : null;
      if (feeValue && !fee) issues.push('Nie można rozpoznać opłaty.');

      const currency = read(values, indices, mapping.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency))
        issues.push('Nie można rozpoznać waluty.');

      const transactionType = inferTransactionType(
        read(values, indices, mapping.type),
      );
      if (!transactionType) {
        issues.push('Kierunek transakcji wymaga ręcznej weryfikacji.');
      }
      const sourceStatus = read(values, indices, mapping.status) || null;
      if (!completed) issues.push('Operacja oczekująca: brak daty realizacji.');
      if (sourceStatus && isPendingStatus(sourceStatus)) {
        issues.push('Operacja oznaczona jako oczekująca w źródle.');
      }

      const balanceValue = read(values, indices, mapping.balance);
      const balance = balanceValue ? decimal(balanceValue, false) : null;
      if (balanceValue && !balance)
        issues.push('Nie można rozpoznać salda konta.');

      return rowResult(
        rowNumber,
        rawValues,
        operationDate,
        description,
        amount,
        transactionType,
        currency,
        {
          fee,
          sourceStatus,
          balance,
          balanceCurrency: balance ? currency : null,
        },
        issues,
      );
    }

    const operationDate = parsePolishDate(read(values, indices, mapping.date));
    if (!operationDate) issues.push('Nie można rozpoznać daty operacji.');
    const description = read(values, indices, mapping.description) || null;
    if (!description) issues.push('Brak opisu transakcji.');

    const withdrawalValue = read(values, indices, mapping.withdrawal);
    const incomeValue = read(values, indices, mapping.income);
    if (withdrawalValue && incomeValue) {
      issues.push('Wiersz zawiera jednocześnie wypłatę i wpływ.');
    } else if (!withdrawalValue && !incomeValue) {
      issues.push('Wiersz nie zawiera ani wypłaty, ani wpływu.');
    }
    const amountValue = withdrawalValue || incomeValue;
    const parsedAmount = amountValue ? savingsAmount(amountValue) : null;
    if (amountValue && !parsedAmount) {
      issues.push('Nie można rozpoznać kwoty lub waluty.');
    }
    const transactionType = withdrawalValue
      ? 'EXPENSE'
      : incomeValue
        ? 'INCOME'
        : null;
    const balanceValue = read(values, indices, mapping.balance);
    const parsedBalance = balanceValue ? savingsAmount(balanceValue) : null;
    if (balanceValue && !parsedBalance) {
      issues.push('Nie można rozpoznać salda lub waluty salda.');
    }
    if (
      parsedAmount &&
      parsedBalance &&
      parsedAmount.currency !== parsedBalance.currency
    ) {
      issues.push('Waluta salda różni się od waluty transakcji.');
    }

    return rowResult(
      rowNumber,
      rawValues,
      operationDate,
      description,
      parsedAmount?.amount ?? null,
      transactionType,
      parsedAmount?.currency ?? null,
      {
        balance: parsedBalance?.amount ?? null,
        balanceCurrency: parsedBalance?.currency ?? null,
      },
      issues,
    );
  });
}

export function parseStatementCsv(
  input: string | Uint8Array,
  settings: StatementCsvSettings = {},
): StatementCsvPreview {
  let text: string;
  let encoding: string | null = null;
  try {
    if (typeof input === 'string') {
      text = input.replace(/^\uFEFF/, '');
      encoding = 'unicode';
    } else {
      const decoded = decodeBytes(input, settings.encoding);
      text = decoded.text.replace(/^\uFEFF/, '');
      encoding = decoded.encoding;
    }
  } catch (error) {
    return {
      status: 'invalid',
      profileId: null,
      parserVersion: null,
      encoding: settings.encoding ?? null,
      delimiter: settings.delimiter ?? null,
      headers: [],
      errors: [
        error instanceof Error
          ? error.message
          : 'Nie można odczytać kodowania.',
      ],
      rows: [],
    };
  }

  if (text.trim().length === 0) {
    return {
      status: 'empty',
      profileId: null,
      parserVersion: null,
      encoding,
      delimiter: null,
      headers: [],
      errors: ['Plik CSV jest pusty.'],
      rows: [],
    };
  }
  const delimiter = settings.delimiter ?? detectDelimiter(text);
  let records: string[][];
  try {
    records = parseRecords(text, delimiter);
  } catch (error) {
    return {
      status: 'invalid',
      profileId: null,
      parserVersion: null,
      encoding,
      delimiter,
      headers: [],
      errors: [
        error instanceof Error ? error.message : 'Nieprawidłowa składnia CSV.',
      ],
      rows: [],
    };
  }

  const headers = (records[0] ?? []).map((header) => header.trim());
  if (headers.length === 0) {
    return {
      status: 'empty',
      profileId: null,
      parserVersion: null,
      encoding,
      delimiter,
      headers,
      errors: ['Plik CSV nie zawiera nagłówków.'],
      rows: [],
    };
  }
  const profileId = identifyProfile(headers, settings.profileId);
  if (!profileId) {
    const rows = records.slice(1).map((values, offset) => ({
      rowNumber: offset + 2,
      rawValues: Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? '']),
      ),
      status: 'unrecognized' as const,
      decision: 'pending' as const,
      issues: ['Nieznany układ CSV; wiersz nie może być zatwierdzony.'],
      operationDate: null,
      description: null,
      amount: null,
      transactionType: null,
      fee: null,
      currency: null,
      sourceStatus: null,
      balance: null,
      balanceCurrency: null,
    }));
    return {
      status: 'unsupported',
      profileId: null,
      parserVersion: null,
      encoding,
      delimiter,
      headers,
      errors: ['Nieznany układ CSV. Wiersze pozostają widoczne do mapowania.'],
      rows,
    };
  }

  const rows = profileRows(profileId, headers, records, settings);
  return {
    status: 'ready',
    profileId,
    parserVersion: PROFILE_VERSIONS[profileId],
    encoding,
    delimiter,
    headers,
    errors:
      rows.length === 0
        ? ['Plik zawiera nagłówki, ale nie zawiera wierszy.']
        : [],
    rows,
  };
}
