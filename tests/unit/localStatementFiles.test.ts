import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupStatementFileRecord } from '../../src/shared/contracts';
import {
  archiveLocalStatement,
  listLocalStatements,
  restoreLocalStatements,
} from '../../src/main/localStatementFiles';

const statement = Buffer.from('date,description\n2026-01-01,Synthetic\n');

describe('device-local statement archive', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'income-tracker-backup-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('archives only a selected, hash-matching source and includes available bytes', async () => {
    const source = join(directory, 'source.csv');
    await writeFile(source, statement);
    const hash = createHash('sha256').update(statement).digest('hex');
    const archivedPath = await archiveLocalStatement(
      join(directory, 'user-data'),
      'budget-1',
      'batch-1',
      source,
      hash,
    );

    expect(await readFile(archivedPath)).toEqual(statement);
    await expect(
      listLocalStatements(join(directory, 'user-data'), 'budget-1'),
    ).resolves.toEqual([
      {
        import_batch_id: 'batch-1',
        file_name: 'source.csv',
        content_type: 'text/csv',
        sha256: hash,
        content_base64: statement.toString('base64'),
      },
    ]);
  });

  it('rejects source changes and corrupted restore files without storing them', async () => {
    const source = join(directory, 'source.csv');
    await writeFile(source, statement);
    const hash = createHash('sha256').update(statement).digest('hex');
    await expect(
      archiveLocalStatement(
        join(directory, 'user-data'),
        'budget-1',
        'batch-1',
        source,
        'f'.repeat(64),
      ),
    ).rejects.toThrow('zmienił się od czasu podglądu');

    const damaged: BackupStatementFileRecord = {
      import_batch_id: 'batch-1',
      file_name: 'source.csv',
      content_type: 'text/csv',
      sha256: hash,
      content_base64: Buffer.from('damaged').toString('base64'),
    };
    await expect(
      restoreLocalStatements(
        join(directory, 'user-data'),
        'budget-1',
        [damaged],
      ),
    ).rejects.toThrow();
    await expect(
      listLocalStatements(join(directory, 'user-data'), 'budget-1'),
    ).resolves.toEqual([]);
  });

  it('restores valid files inside the application local-data folder', async () => {
    const userData = join(directory, 'user-data');
    const hash = createHash('sha256').update(statement).digest('hex');
    const file: BackupStatementFileRecord = {
      import_batch_id: 'batch-1',
      file_name: 'original.csv',
      content_type: 'text/csv',
      sha256: hash,
      content_base64: statement.toString('base64'),
    };

    await expect(
      restoreLocalStatements(userData, 'budget-1', [file]),
    ).resolves.toBe(1);
    const [restored] = await listLocalStatements(userData, 'budget-1');
    expect(restored).toEqual(file);
    expect(
      await readFile(
        join(
          userData,
          'statement-files',
          'budget-1',
          `batch-1-${hash}.csv`,
        ),
      ),
    ).toEqual(statement);
  });
});
