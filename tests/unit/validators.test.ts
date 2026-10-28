import { describe, expect, it } from 'vitest';
import {
  validateOAuthState,
  validateWriteTestFileRequest,
} from '../../src/shared/validators';

describe('validateWriteTestFileRequest', () => {
  it('accepts non-empty content', () => {
    expect(validateWriteTestFileRequest({ content: 'hello' })).toEqual({
      content: 'hello',
    });
  });

  it('rejects blank content', () => {
    expect(validateWriteTestFileRequest({ content: '   ' })).toBeNull();
  });

  it('rejects invalid payload shape', () => {
    expect(validateWriteTestFileRequest('hello')).toBeNull();
    expect(validateWriteTestFileRequest({})).toBeNull();
  });
});

describe('validateOAuthState', () => {
  it('accepts matching successful state', () => {
    expect(
      validateOAuthState('abc', { ok: true, state: 'abc', code: 'code' }),
    ).toBe(true);
  });

  it('rejects mismatching state and failed payload', () => {
    expect(validateOAuthState('abc', { ok: true, state: 'different' })).toBe(
      false,
    );
    expect(
      validateOAuthState('abc', { ok: false, state: 'abc', error: 'x' }),
    ).toBe(false);
  });
});
