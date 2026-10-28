import { describe, expect, it } from 'vitest';
import { isSecureProductionUrl } from '../../src/shared/networkPolicy';

describe('isSecureProductionUrl', () => {
  it('allows HTTP in development', () => {
    expect(isSecureProductionUrl('development', 'http://localhost:9099')).toBe(
      true,
    );
  });

  it('requires HTTPS in production', () => {
    expect(isSecureProductionUrl('production', 'https://firebaseapp.com')).toBe(
      true,
    );
    expect(isSecureProductionUrl('production', 'http://firebaseapp.com')).toBe(
      false,
    );
  });
});
