export interface ExchangeRatePoint {
  date: string;
  base: string;
  quote: string;
  rate: string;
}

export interface TransactionConversion {
  target_currency: string;
  rate_used: string;
  rate_date: string;
  converted_amount: string;
  display_amount: string;
}

interface DecimalParts {
  coefficient: bigint;
  scale: number;
}

function decimalParts(value: string): DecimalParts {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[3]?.length ?? 0) > 18) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  const fraction = match[3] ?? '';
  const coefficient = BigInt(
    `${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`,
  );
  return { coefficient, scale: fraction.length };
}

function decimalString(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function fixedDecimalString(coefficient: bigint, scale: number): string {
  const value = decimalString(coefficient, scale);
  if (scale === 0) return value;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  return `${negative ? '-' : ''}${whole}.${fraction.padEnd(scale, '0')}`;
}

export function multiplyDecimals(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  return decimalString(a.coefficient * b.coefficient, a.scale + b.scale);
}

export function sumDecimals(values: readonly string[]): string {
  if (values.length === 0) return '0';
  const parts = values.map(decimalParts);
  const scale = Math.max(...parts.map((part) => part.scale));
  const total = parts.reduce(
    (sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale),
    0n,
  );
  return decimalString(total, scale);
}

export function roundHalfUp(value: string, fractionDigits: number): string {
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 18
  ) {
    throw new Error('Invalid currency precision.');
  }
  const { coefficient, scale } = decimalParts(value);
  if (scale <= fractionDigits) {
    return fixedDecimalString(
      coefficient * 10n ** BigInt(fractionDigits - scale),
      fractionDigits,
    );
  }
  const divisor = 10n ** BigInt(scale - fractionDigits);
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  let rounded = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) rounded += 1n;
  return fixedDecimalString(
    coefficient < 0n ? -rounded : rounded,
    fractionDigits,
  );
}

export function currencyFractionDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2
  );
}

export function selectLatestRateOnOrBefore(
  rates: readonly ExchangeRatePoint[],
  requestedDate: string,
): ExchangeRatePoint | null {
  return (
    [...rates]
      .filter((rate) => rate.date <= requestedDate)
      .sort((left, right) => right.date.localeCompare(left.date))[0] ?? null
  );
}

export function convertAmountExact(amount: string, rate: string): string {
  return multiplyDecimals(amount, rate);
}

export function createTransactionConversion(
  amount: string,
  targetCurrency: string,
  rate: ExchangeRatePoint | null,
): TransactionConversion | null {
  if (!rate) return null;
  const converted = convertAmountExact(amount, rate.rate);
  return {
    target_currency: targetCurrency,
    rate_used: rate.rate,
    rate_date: rate.date,
    converted_amount: converted,
    display_amount: roundHalfUp(
      converted,
      currencyFractionDigits(targetCurrency),
    ),
  };
}
