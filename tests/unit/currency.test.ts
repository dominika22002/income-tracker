import { describe, expect, it } from 'vitest';
import {
  convertAmountExact,
  createTransactionConversion,
  roundHalfUp,
  selectLatestRateOnOrBefore,
  sumDecimals,
} from '../../src/shared/domain/currency';

describe('currency conversion arithmetic (U-FR-23)', () => {
  const rates = [
    { date: '2026-03-06', base: 'EUR', quote: 'CHF', rate: '0.91' },
    { date: '2026-03-09', base: 'EUR', quote: 'CHF', rate: '0.92' },
  ];

  it('uses the exact date or the nearest earlier available rate', () => {
    expect(selectLatestRateOnOrBefore(rates, '2026-03-09')?.rate).toBe('0.92');
    expect(selectLatestRateOnOrBefore(rates, '2026-03-08')?.date).toBe(
      '2026-03-06',
    );
    expect(selectLatestRateOnOrBefore(rates, '2026-03-05')).toBeNull();
  });

  it('uses exact decimal multiplication and rounds display values HALF_UP', () => {
    expect(convertAmountExact('12.3456', '0.9123456789')).toBe(
      '11.26345481342784',
    );
    expect(roundHalfUp('1.005', 2)).toBe('1.01');
    expect(roundHalfUp('-1.005', 2)).toBe('-1.01');
    expect(roundHalfUp('1.0049', 2)).toBe('1.00');
  });

  it('sums unrounded conversions before rounding the total', () => {
    const amounts = ['0.004', '0.004', '0.004'];
    expect(roundHalfUp(sumDecimals(amounts), 2)).toBe('0.01');
    expect(
      amounts.reduce((sum, amount) => sum + Number(amount), 0),
    ).toBeCloseTo(0.012);
  });

  it('keeps the original source amount for a same-currency display', () => {
    const conversion = createTransactionConversion('7.1234', 'CHF', {
      date: '2026-03-09',
      base: 'CHF',
      quote: 'CHF',
      rate: '1',
    });
    expect(conversion).toMatchObject({
      rate_used: '1',
      rate_date: '2026-03-09',
      converted_amount: '7.1234',
      display_amount: '7.12',
    });
  });

  it('does not fabricate a value when no applicable rate exists', () => {
    expect(createTransactionConversion('4.00', 'USD', null)).toBeNull();
  });
});
