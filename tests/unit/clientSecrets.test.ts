import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const CLIENT_DIRS = ['src/renderer', 'src/main', 'src/preload', 'src/shared'];

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const clientFiles = CLIENT_DIRS.flatMap((dir) =>
  listFiles(join(ROOT, dir)).filter((file) => /\.(ts|tsx|html)$/.test(file)),
);

describe('no administrative secrets or SDKs in the client (B-TR-07, TR-07)', () => {
  it('scans a meaningful set of client files', () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it('never imports Admin SDK, functions runtime or server code', () => {
    const offenders = clientFiles.filter((file) =>
      /from\s+['"](firebase-admin|firebase-functions)(\/[^'"]*)?['"]|from\s+['"][^'"]*\/server\//.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('contains no service-account material or private keys', () => {
    const pattern =
      /BEGIN (RSA )?PRIVATE KEY|"private_key"|GOOGLE_APPLICATION_CREDENTIALS|service[-_ ]?account/i;
    const offenders = clientFiles.filter((file) =>
      pattern.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the client package free of admin dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(
      'firebase-admin',
    );
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(
      'firebase-functions',
    );
  });

  it('documents no secret or administrative variables in .env.example', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const line of example.split(/\r?\n/)) {
      const name = line.split('=')[0]?.trim();
      if (name && !name.startsWith('#')) {
        expect(name).not.toMatch(
          /SECRET|PRIVATE|SERVICE_ACCOUNT|ADMIN|CREDENTIALS/i,
        );
      }
    }
  });
});
