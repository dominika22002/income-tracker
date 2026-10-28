import { describe, expect, it } from 'vitest';
import { deriveSyncStatus } from '../../src/shared/syncState';

describe('deriveSyncStatus', () => {
  it('reports offline when there is no connection', () => {
    expect(deriveSyncStatus({ isOnline: false, hasPendingWrites: false })).toBe(
      'offline',
    );
  });

  it('reports pending when online and there are pending writes', () => {
    expect(deriveSyncStatus({ isOnline: true, hasPendingWrites: true })).toBe(
      'pending',
    );
  });

  it('reports confirmed when online and no pending writes', () => {
    expect(deriveSyncStatus({ isOnline: true, hasPendingWrites: false })).toBe(
      'confirmed',
    );
  });
});
