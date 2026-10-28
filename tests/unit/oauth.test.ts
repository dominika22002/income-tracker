import { describe, expect, it } from 'vitest';
import {
  buildGoogleOAuthUrl,
  createOAuthState,
  parseOAuthCallbackUrl,
} from '../../src/main/oauth';

describe('oauth helpers', () => {
  it('creates random state with expected length', () => {
    const state = createOAuthState();
    expect(state).toHaveLength(32);
  });

  it('builds google oauth url with required params', () => {
    const url = buildGoogleOAuthUrl({
      clientId: 'test-client-id',
      redirectUri: 'income-tracker://oauth',
      state: 'abc',
      scopes: ['openid', 'email'],
    });

    expect(url).toContain('accounts.google.com');
    expect(url).toContain('state=abc');
    expect(url).toContain('client_id=test-client-id');
  });

  it('parses callback success and errors', () => {
    expect(
      parseOAuthCallbackUrl('income-tracker://oauth?state=abc&code=oauth-code'),
    ).toEqual({
      ok: true,
      state: 'abc',
      code: 'oauth-code',
    });

    expect(
      parseOAuthCallbackUrl(
        'income-tracker://oauth?state=abc&error=access_denied',
      ),
    ).toEqual({
      ok: false,
      state: 'abc',
      error: 'access_denied',
    });
  });
});
