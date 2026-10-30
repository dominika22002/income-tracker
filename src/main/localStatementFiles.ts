import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { BackupStatementFileRecord } from '../shared/contracts';
import { writeExportAtomically } from './exportFiles';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;

interface LocalStatementMetadata {
  import_batch_id: string;
  file_name: string;
  content_type: BackupStatementFileRecord['content_type'];
  sha256: string;
}

function validFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !/[<>:"/\\|?*]/.test(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}

function decodeContent(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error('Nieprawidłowa zawartość lokalnego pliku wyciągu.');
  }
  const content = Buffer.from(value, 'base64');
  if (
    content.length === 0 ||
    content.length > MAX_FILE_BYTES ||
    content.toString('base64') !== value
  ) {
    throw new Error('Lokalny plik wyciągu jest pusty lub przekracza 10 MB.');
  }
  return content;
}

function metadataFromBackup(
  file: BackupStatementFileRecord,
): LocalStatementMetadata {
  if (
    !file ||
    !SAFE_ID.test(file.import_batch_id) ||
    !validFileName(file.file_name) ||
    (file.content_type !== 'text/csv' &&
      file.content_type !== 'application/pdf') ||
    !HASH.test(file.sha256)
  ) {
    throw new Error('Nieprawidłowe metadane lokalnego pliku wyciągu.');
  }
  return {
    import_batch_id: file.import_batch_id,
    file_name: file.file_name,
    content_type: file.content_type,
    sha256: file.sha256,
  };
}

function localNames(metadata: LocalStatementMetadata) {
  const extension = metadata.content_type === 'text/csv' ? 'csv' : 'pdf';
  const stem = `${metadata.import_batch_id}-${metadata.sha256}`;
  return {
    content: `${stem}.${extension}`,
    metadata: `${stem}.meta.json`,
  };
}

export async function archiveLocalStatement(
  userDataDirectory: string,
  budgetId: string,
  importBatchId: string,
  filePath: string,
  expectedHash: string,
): Promise<string> {
  if (!SAFE_ID.test(budgetId) || !SAFE_ID.test(importBatchId)) {
    throw new Error('Nieprawidłowy identyfikator budżetu lub importu.');
  }
  if (!HASH.test(expectedHash)) {
    throw new Error('Nieprawidłowy odcisk lokalnego pliku wyciągu.');
  }
  const extension = extname(filePath).slice(1).toLowerCase();
  if (extension !== 'csv' && extension !== 'pdf') {
    throw new Error('Obsługiwane pliki wyciągów to CSV i PDF.');
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) {
    throw new Error('Wybrany plik wyciągu jest pusty lub przekracza 10 MB.');
  }
  const content = await readFile(filePath);
  const hash = createHash('sha256').update(content).digest('hex');
  if (hash !== expectedHash) {
    throw new Error('Wybrany plik zmienił się od czasu podglądu.');
  }
  const metadata: LocalStatementMetadata = {
    import_batch_id: importBatchId,
    file_name: filePath.split(/[\\/]/).pop() ?? `statement.${extension}`,
    content_type: extension === 'csv' ? 'text/csv' : 'application/pdf',
    sha256: hash,
  };
  if (!validFileName(metadata.file_name)) {
    throw new Error('Nieprawidłowa nazwa oryginalnego pliku wyciągu.');
  }
  const directory = join(userDataDirectory, 'statement-files', budgetId);
  const names = localNames(metadata);
  const contentPath = join(directory, names.content);
  await mkdir(directory, { recursive: true });
  await writeExportAtomically(contentPath, content);
  try {
    await writeExportAtomically(
      join(directory, names.metadata),
      Buffer.from(JSON.stringify(metadata), 'utf8'),
    );
  } catch (error) {
    await unlink(contentPath);
    throw error;
  }
  return contentPath;
}

export async function listLocalStatements(
  userDataDirectory: string,
  budgetId: string,
): Promise<BackupStatementFileRecord[]> {
  if (!SAFE_ID.test(budgetId)) {
    throw new Error('Nieprawidłowy identyfikator budżetu.');
  }
  const directory = join(userDataDirectory, 'statement-files', budgetId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
  const records: BackupStatementFileRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.meta.json'))) {
    const metadataPath = join(directory, name);
    const raw = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('import_batch_id' in raw) ||
      !('file_name' in raw) ||
      !('content_type' in raw) ||
      !('sha256' in raw)
    ) {
      throw new Error(`Metadane pliku ${name} są uszkodzone.`);
    }
    const metadata = metadataFromBackup({
      ...(raw as LocalStatementMetadata),
      content_base64: '',
    });
    const expectedNames = localNames(metadata);
    if (name !== expectedNames.metadata) {
      throw new Error(`Nieprawidłowa ścieżka lokalnego pliku ${name}.`);
    }
    const contentPath = join(directory, expectedNames.content);
    let content: Buffer;
    try {
      content = await readFile(contentPath);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    if (
      content.length > MAX_FILE_BYTES ||
      createHash('sha256').update(content).digest('hex') !== metadata.sha256
    ) {
      throw new Error(`Lokalny plik ${metadata.file_name} jest uszkodzony.`);
    }
    records.push({
      ...metadata,
      content_base64: content.toString('base64'),
    });
  }
  return records;
}

export async function restoreLocalStatements(
  userDataDirectory: string,
  budgetId: string,
  files: BackupStatementFileRecord[],
): Promise<number> {
  if (!SAFE_ID.test(budgetId) || !Array.isArray(files)) {
    throw new Error('Nieprawidłowe dane lokalnych plików wyciągów.');
  }
  const prepared = files.map((file) => {
    const metadata = metadataFromBackup(file);
    const content = decodeContent(file.content_base64);
    if (createHash('sha256').update(content).digest('hex') !== metadata.sha256) {
      throw new Error(`Integralność pliku ${metadata.file_name} jest nieprawidłowa.`);
    }
    return { metadata, content, names: localNames(metadata) };
  });
  const root = join(userDataDirectory, 'statement-files');
  const temporaryDirectory = join(root, `.restore-${randomUUID()}`);
  const moved: string[] = [];
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    for (const item of prepared) {
      await writeFile(join(temporaryDirectory, item.names.content), item.content, {
        flag: 'wx',
      });
      await writeFile(
        join(temporaryDirectory, item.names.metadata),
        JSON.stringify(item.metadata),
        { flag: 'wx' },
      );
    }
    for (const item of prepared) {
      const directory = join(root, budgetId);
      await mkdir(directory, { recursive: true });
      const destinations = [
        item.names.content,
        item.names.metadata,
      ].map((name) => join(directory, name));
      const sources = [
        item.names.content,
        item.names.metadata,
      ].map((name) => join(temporaryDirectory, name));
      const [contentInfo, metadataInfo] = await Promise.all(
        destinations.map(async (path) => {
          try {
            return await stat(path);
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            ) {
              return null;
            }
            throw error;
          }
        }),
      );
      if (contentInfo || metadataInfo) {
        if (!contentInfo || !metadataInfo) {
          throw new Error('Istniejący lokalny plik wyciągu jest niekompletny.');
        }
        const existing = await readFile(destinations[0]);
        if (
          createHash('sha256').update(existing).digest('hex') !==
          item.metadata.sha256
        ) {
          throw new Error('Istniejący lokalny plik wyciągu ma inny odcisk.');
        }
        continue;
      }
      for (let index = 0; index < sources.length; index += 1) {
        await rename(sources[index], destinations[index]);
        moved.push(destinations[index]);
      }
    }
    return moved.length / 2;
  } catch (error) {
    await Promise.all(
      moved.map(async (path) => {
        try {
          await unlink(path);
        } catch (cleanupError) {
          if (
            !(
              cleanupError instanceof Error &&
              'code' in cleanupError &&
              cleanupError.code === 'ENOENT'
            )
          ) {
            throw cleanupError;
          }
        }
      }),
    );
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
