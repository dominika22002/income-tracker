import { randomUUID } from 'node:crypto';
import { unlink, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const FILE_EXTENSIONS = {
  CSV: 'csv',
  XLSX: 'xlsx',
  JSON: 'json',
} as const;

export function exportFileName(
  fileName: string,
  extension: string,
): string | null {
  if (
    !fileName.trim() ||
    fileName.length > 120 ||
    basename(fileName) !== fileName ||
    /[<>:"/\\|?*]/.test(fileName) ||
    [...fileName].some((character) => character.charCodeAt(0) < 32)
  ) {
    return null;
  }
  const suffix = `.${extension}`;
  return fileName.toLowerCase().endsWith(suffix)
    ? fileName
    : `${fileName}${suffix}`;
}

export function ensureExportExtension(
  filePath: string,
  extension: string,
): string {
  return extname(filePath).toLowerCase() === `.${extension.toLowerCase()}`
    ? filePath
    : `${filePath}.${extension}`;
}

export function decodeExportContent(contentBase64: string): Buffer | null {
  if (
    !contentBase64 ||
    contentBase64.length > Math.ceil((MAX_EXPORT_BYTES * 4) / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      contentBase64,
    )
  ) {
    return null;
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (
    content.length === 0 ||
    content.length > MAX_EXPORT_BYTES ||
    content.toString('base64') !== contentBase64
  ) {
    return null;
  }
  return content;
}

export function exportExtension(format: keyof typeof FILE_EXTENSIONS): string {
  return FILE_EXTENSIONS[format];
}

export async function writeExportAtomically(
  filePath: string,
  content: Uint8Array,
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (failure) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupFailure) {
      if (!(
        cleanupFailure instanceof Error &&
        'code' in cleanupFailure &&
        cleanupFailure.code === 'ENOENT'
      )) {
        const cleanupMessage =
          cleanupFailure instanceof Error
            ? cleanupFailure.message
            : 'unknown cleanup failure';
        throw new Error(
          `${failure instanceof Error ? failure.message : 'Export write failed.'} Temporary file cleanup failed: ${cleanupMessage}`,
        );
      }
    }
    throw failure;
  }
}

export function describeExportError(failure: unknown): string {
  const code =
    failure instanceof Error && 'code' in failure ? failure.code : undefined;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'Brak uprawnień do zapisu w wybranej lokalizacji.';
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'Brak miejsca na dysku, aby zapisać eksport.';
  }
  return failure instanceof Error
    ? `Nie udało się zapisać pliku eksportu: ${failure.message}`
    : 'Nie udało się zapisać pliku eksportu z nieznanego powodu.';
}

export function validatePdfReport(report: unknown): report is {
  period: { start: string; end: string };
  currency: string;
  income: string;
  expenses: string;
  cash_flow: string;
  hidden_transactions_included: boolean;
  expenses_by_category: Array<{ category_name: string; amount: string }>;
} {
  if (!report || typeof report !== 'object') return false;
  const candidate = report as Record<string, unknown>;
  const period = candidate.period;
  if (!period || typeof period !== 'object') return false;
  const start = (period as Record<string, unknown>).start;
  const end = (period as Record<string, unknown>).end;
  if (typeof start !== 'string' || typeof end !== 'string') return false;
  const startMatch = /^(\d{4})-(\d{2})-01$/.exec(start);
  const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!startMatch || !endMatch) return false;
  const [startYear, startMonth] = [
    Number(startMatch[1]),
    Number(startMatch[2]),
  ];
  const [endYear, endMonth] = [Number(endMatch[1]), Number(endMatch[2])];
  if (
    startMonth < 1 ||
    startMonth > 12 ||
    endMonth < 1 ||
    endMonth > 12 ||
    endYear * 12 + endMonth < startYear * 12 + startMonth
  ) {
    return false;
  }
  const expectedLastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  if (Number(endMatch[3]) !== expectedLastDay) {
    return false;
  }
  const amountPattern = /^-?\d{1,15}(?:\.\d{1,14})?$/;
  if (
    typeof candidate.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(candidate.currency) ||
    ![candidate.income, candidate.expenses, candidate.cash_flow].every(
      (value) => typeof value === 'string' && amountPattern.test(value),
    ) ||
    typeof candidate.hidden_transactions_included !== 'boolean' ||
    !Array.isArray(candidate.expenses_by_category) ||
    candidate.expenses_by_category.length > 10_000 ||
    candidate.expenses_by_category.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        typeof (row as Record<string, unknown>).category_name !== 'string' ||
        ((row as Record<string, unknown>).category_name as string).length >
          500 ||
        typeof (row as Record<string, unknown>).amount !== 'string' ||
        !amountPattern.test((row as Record<string, unknown>).amount as string),
    )
  ) {
    return false;
  }
  return true;
}
