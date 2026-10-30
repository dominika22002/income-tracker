import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BACKUP_COLLECTIONS } from '../../src/shared/firestorePaths';
import {
  type BackupPayload,
  type BackupDatasets,
  createBackupFile,
  parseBackupFile,
  planBackupMerge,
  resolveBackupMerge,
  BACKUP_FORMAT,
} from '../../src/shared/domain/backup';

function payload(): BackupPayload {
  const datasets = Object.fromEntries(
    BACKUP_COLLECTIONS.map((collection) => [collection, []]),
  ) as unknown as BackupDatasets;
  datasets.accounts.push({
    document_id: 'account-1',
    data: {
      budget_id: 'budget-1',
      owner_membership_id: 'member-1',
      label: 'Checking',
      currency: 'PLN',
    },
  });
  return {
    format: BACKUP_FORMAT,
    schema_version: 2 as const,
    created_at: '2026-10-30T08:00:00.000Z',
    source_budget: { budget_id: 'budget-1', name: 'Home' },
    datasets,
    membership_history: [
      {
        document_id: 'member-1',
        data: {
          budget_id: 'budget-1',
          role: 'ADMIN',
          status: 'ACTIVE',
          user_id: 'user-1',
        },
      },
    ],
    currency_settings: {
      primary_currency: 'PLN',
      secondary_currencies: ['EUR'],
    },
    statement_files: [],
  };
}

function hash(value: unknown): string {
  const canonicalize = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonicalize).join(',')}]`;
    if (item && typeof item === 'object') {
      const entries = Object.entries(item).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return `{${entries
        .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

describe('local backup format', () => {
  it('round-trips the versioned payload and verifies its checksum', async () => {
    const file = await createBackupFile(payload());
    const parsed = await parseBackupFile(file);

    expect(parsed.schema_version).toBe(2);
    expect(parsed.source_budget.name).toBe('Home');
    expect(parsed.datasets.accounts).toEqual(payload().datasets.accounts);
    expect(parsed.integrity.algorithm).toBe('SHA-256');
  });

  it('rejects a changed byte before producing a restore payload', async () => {
    const file = await createBackupFile(payload());
    const changed = file.replace('Checking', 'Checkinq');

    await expect(parseBackupFile(changed)).rejects.toThrow(
      'integrity check failed',
    );
  });

  it('rejects malformed schemas and unsupported versions', async () => {
    const valid = JSON.parse(await createBackupFile(payload())) as Record<
      string,
      unknown
    >;
    const malformed: Record<string, unknown> = {
      ...valid,
      datasets: { ...payload().datasets, accounts: 'not-an-array' },
    };
    const malformedPayload = { ...malformed };
    delete malformedPayload.integrity;
    const badSchema = JSON.stringify({
      ...malformed,
      integrity: {
        algorithm: 'SHA-256',
        checksum: hash(malformedPayload),
      },
    });
    await expect(parseBackupFile(badSchema)).rejects.toThrow(
      'Invalid backup datasets.accounts',
    );

    const unsupported: Record<string, unknown> = {
      ...valid,
      schema_version: 99,
    };
    const unsupportedPayload = { ...unsupported };
    delete unsupportedPayload.integrity;
    await expect(
      parseBackupFile(
        JSON.stringify({
          ...unsupported,
          integrity: {
            algorithm: 'SHA-256',
            checksum: hash(unsupportedPayload),
          },
        }),
      ),
    ).rejects.toThrow('Unsupported backup schema version: 99');
  });

  it('migrates the explicitly supported version 1 format', async () => {
    const current = payload();
    const version1 = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => key !== 'currency_settings' && key !== 'statement_files',
      ),
    );
    version1.schema_version = 1;
    const file = JSON.stringify({
      ...version1,
      integrity: {
        algorithm: 'SHA-256',
        checksum: hash(version1),
      },
    });

    const parsed = await parseBackupFile(file);

    expect(parsed.schema_version).toBe(2);
    expect(parsed.membership_history).toEqual(current.membership_history);
    expect(parsed.currency_settings).toBeNull();
    expect(parsed.statement_files).toEqual([]);
  });

  it('rejects authentication fields even if a file has a valid checksum', async () => {
    const unsafe = payload();
    unsafe.datasets.accounts[0].data.password = 'never-export';

    await expect(createBackupFile(unsafe)).rejects.toThrow(
      'forbidden authentication field',
    );
  });
});

describe('backup merge planning', () => {
  it('preserves non-conflicting current records and exposes each record conflict', () => {
    const current = payload();
    current.datasets.accounts.push({
      document_id: 'account-2',
      data: {
        budget_id: 'budget-1',
        owner_membership_id: 'member-1',
        label: 'Savings',
        currency: 'PLN',
      },
    });
    const incoming = payload();
    incoming.datasets.accounts[0].data.label = 'Primary';

    const plan = planBackupMerge(current, incoming);

    expect(plan.merged.datasets.accounts).toHaveLength(2);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      collection: 'accounts',
      document_id: 'account-1',
    });
    expect(() =>
      resolveBackupMerge(plan, {}),
    ).toThrow('A choice is required for merge conflict accounts/account-1');

    expect(
      resolveBackupMerge(plan, { 'accounts/account-1': 'incoming' }).datasets
        .accounts[0].data.label,
    ).toBe('Primary');
    expect(
      resolveBackupMerge(plan, { 'accounts/account-1': 'current' }).datasets
        .accounts[0].data.label,
    ).toBe('Checking');
  });
});
