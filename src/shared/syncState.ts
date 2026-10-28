export type SyncStatus = 'offline' | 'pending' | 'confirmed';

export interface SyncSnapshot {
  isOnline: boolean;
  hasPendingWrites: boolean;
}

export function deriveSyncStatus(snapshot: SyncSnapshot): SyncStatus {
  if (!snapshot.isOnline) {
    return 'offline';
  }
  if (snapshot.hasPendingWrites) {
    return 'pending';
  }
  return 'confirmed';
}
