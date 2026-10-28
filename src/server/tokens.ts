import { createHash, randomBytes } from 'node:crypto';

/** 256 bits from a CSPRNG, URL-safe (43 characters). */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is persisted; the token itself is shown once to the admin. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
