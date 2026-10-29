import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchFrankfurterRateSeries } from '../../src/server/frankfurter';

describe('Frankfurter ECB client (I-FR-23)', () => {
  it('requests only currencies and dates, explicitly selecting ECB', async () => {
    const body = readFileSync(
      resolve(
        process.cwd(),
        'tests/fixtures/exchange-rates/ecb-synthetic.json',
      ),
      'utf8',
    );
    let requestedUrl: URL | undefined;
    const fetcher: typeof fetch = async (input) => {
      requestedUrl = new URL(input.toString());
      return new Response(body, { status: 200 });
    };
    await fetchFrankfurterRateSeries(
      'EUR',
      'CHF',
      '2026-03-01',
      '2026-03-10',
      fetcher,
    );

    const requestUrl = requestedUrl;
    if (!requestUrl) throw new Error('Frankfurter request was not made.');
    expect(requestUrl.origin).toBe('https://api.frankfurter.dev');
    expect(requestUrl.pathname).toBe('/v2/rates');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      base: 'EUR',
      quotes: 'CHF',
      from: '2026-03-01',
      to: '2026-03-10',
      providers: 'ecb',
    });
  });

  it('rejects malformed or unavailable API responses explicitly', async () => {
    await expect(
      fetchFrankfurterRateSeries(
        'EUR',
        'CHF',
        '2026-03-01',
        '2026-03-10',
        async () => new Response('[]', { status: 503 }),
      ),
    ).rejects.toThrow('HTTP 503');
    await expect(
      fetchFrankfurterRateSeries(
        'EUR',
        'CHF',
        '2026-03-01',
        '2026-03-10',
        async () => new Response('[{}]', { status: 200 }),
      ),
    ).rejects.toThrow('malformed rate row');
  });
});
