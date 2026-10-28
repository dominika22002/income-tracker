import { describe, expect, it } from 'vitest';
import { validateRemoveMemberRequest } from '../../src/shared/validators';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../../src/server/tokens';
import { isInvitationToken } from '../../src/shared/validators';

describe('invitation tokens (U-FR-03)', () => {
  it('generates URL-safe 256-bit tokens that are unique', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateInvitationToken()),
    );
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(isInvitationToken(token)).toBe(true);
    }
  });

  it('hashes deterministically to 64 hex characters that differ from the token', () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).not.toContain(token);
    expect(hashInvitationToken(generateInvitationToken())).not.toBe(hash);
  });

  it('matches the SHA-256 reference vector', () => {
    expect(hashInvitationToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('member removal request validation (U-FR-06)', () => {
  const id = '3f2b8c1e-7a4d-4c55-9e0a-1b2c3d4e5f60';

  it('accepts a budget and membership id', () => {
    expect(
      validateRemoveMemberRequest({ budget_id: id, membership_id: id }),
    ).toEqual({ budget_id: id, membership_id: id });
  });

  it('rejects missing or malformed ids', () => {
    expect(validateRemoveMemberRequest({ budget_id: id })).toBeNull();
    expect(
      validateRemoveMemberRequest({ budget_id: id, membership_id: 'x' }),
    ).toBeNull();
    expect(validateRemoveMemberRequest(null)).toBeNull();
  });
});
