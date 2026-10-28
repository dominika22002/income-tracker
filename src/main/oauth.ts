import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import type { OAuthCallbackPayload } from '../shared/contracts';

const OAUTH_STATE_BYTES = 16;

export function createOAuthState(): string {
  return randomBytes(OAUTH_STATE_BYTES).toString('hex');
}

export function buildGoogleOAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const endpoint = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  endpoint.searchParams.set('client_id', args.clientId);
  endpoint.searchParams.set('redirect_uri', args.redirectUri);
  endpoint.searchParams.set('response_type', 'code');
  endpoint.searchParams.set('access_type', 'offline');
  endpoint.searchParams.set('prompt', 'consent');
  endpoint.searchParams.set('scope', args.scopes.join(' '));
  endpoint.searchParams.set('state', args.state);
  return endpoint.toString();
}

export function parseOAuthCallbackUrl(
  callbackUrl: string,
): OAuthCallbackPayload {
  const parsed = new URL(callbackUrl);
  const state = parsed.searchParams.get('state') ?? undefined;
  const code = parsed.searchParams.get('code') ?? undefined;
  const error = parsed.searchParams.get('error') ?? undefined;

  if (error) {
    return { ok: false, state, error };
  }
  if (!code || !state) {
    return { ok: false, error: 'Missing OAuth code or state parameter.' };
  }
  return { ok: true, state, code };
}
