import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type {
  OAuthCallbackPayload,
  ReadLocalStatementResult,
} from '../shared/contracts';
import {
  buildGoogleOAuthUrl,
  createOAuthState,
  parseOAuthCallbackUrl,
} from './oauth';
import {
  MAX_LOCAL_STATEMENT_BYTES,
  validateReadLocalStatementRequest,
  validateWriteTestFileRequest,
} from '../shared/validators';

const IPC_CHANNELS = {
  ping: 'app:ping',
  selectFile: 'file:select',
  readStatement: 'file:readStatement',
  writeTestFile: 'file:writeTest',
  startOAuth: 'oauth:start',
  oauthCallback: 'oauth:callback',
} as const;

let expectedOAuthState: string | null = null;
let selectedStatementPath: string | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.ping, () => ({
    ok: true as const,
    message: 'Electron main process is reachable.',
  }));

  ipcMain.handle(IPC_CHANNELS.selectFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select local file',
      properties: ['openFile'],
      filters: [{ name: 'Statements', extensions: ['csv', 'pdf'] }],
    });

    if (result.canceled) {
      selectedStatementPath = null;
      return { canceled: true };
    }
    const [filePath] = result.filePaths;
    selectedStatementPath = filePath ?? null;
    return { canceled: false, filePath };
  });

  ipcMain.handle(
    IPC_CHANNELS.readStatement,
    async (_event, payload: unknown): Promise<ReadLocalStatementResult> => {
      const request = validateReadLocalStatementRequest(payload);
      if (!request) {
        return {
          success: false,
          error: `Invalid file request. Provide a valid path and maxBytes between 1 KB and ${Math.floor(MAX_LOCAL_STATEMENT_BYTES / (1024 * 1024))} MB.`,
        };
      }
      if (
        !selectedStatementPath ||
        request.filePath !== selectedStatementPath
      ) {
        return {
          success: false,
          error:
            'Select the statement through the file picker before reading it.',
        };
      }
      selectedStatementPath = null;
      try {
        const maxBytes = request.maxBytes ?? MAX_LOCAL_STATEMENT_BYTES;
        const extension = extname(request.filePath).slice(1).toLowerCase();
        if (extension !== 'csv' && extension !== 'pdf') {
          return {
            success: false,
            error: 'Only CSV and PDF statements can be read.',
          };
        }
        const fileInfo = await stat(request.filePath);
        if (!fileInfo.isFile()) {
          return { success: false, error: 'Selected path is not a file.' };
        }
        if (fileInfo.size > maxBytes) {
          return {
            success: false,
            error: `File is too large (${fileInfo.size} bytes). Max allowed for local preview is ${maxBytes} bytes.`,
          };
        }

        const bytes = await readFile(request.filePath);
        if (bytes.byteLength > maxBytes) {
          return {
            success: false,
            error: `File grew beyond the local preview limit of ${maxBytes} bytes while it was being read.`,
          };
        }
        const mimeType =
          extension === 'pdf'
            ? 'application/pdf'
            : extension === 'csv'
              ? 'text/csv'
              : 'application/octet-stream';
        return {
          success: true,
          filePath: request.filePath,
          fileName: basename(request.filePath),
          extension,
          mimeType,
          fileSizeBytes: fileInfo.size,
          fileSha256: createHash('sha256').update(bytes).digest('hex'),
          contentBase64: bytes.toString('base64'),
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? `Could not read local file: ${error.message}`
              : 'Could not read local file due to an unknown error.',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.writeTestFile,
    async (_event, payload: unknown) => {
      const request = validateWriteTestFileRequest(payload);
      if (!request) {
        return {
          success: false,
          error:
            'Invalid request. Content must be a non-empty string up to 2048 characters.',
        };
      }

      try {
        const baseDir = join(app.getPath('userData'), 'stage0-prototype');
        await mkdir(baseDir, { recursive: true });
        const filePath = join(baseDir, 'ipc-write-test.txt');
        const timestamp = new Date().toISOString();
        await writeFile(
          filePath,
          `${request.content}\n\nSaved at: ${timestamp}\n`,
          'utf-8',
        );
        return { success: true, filePath };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? `Could not write test file: ${error.message}`
              : 'Could not write test file due to an unknown error.',
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.startOAuth, async () => {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'income-tracker://oauth';

    if (!clientId) {
      return {
        launched: false,
        error:
          'Missing GOOGLE_OAUTH_CLIENT_ID in environment. See README for local setup.',
      };
    }

    const state = createOAuthState();
    expectedOAuthState = state;
    const url = buildGoogleOAuthUrl({
      clientId,
      redirectUri,
      state,
      scopes: ['openid', 'email', 'profile'],
    });

    try {
      await shell.openExternal(url);
    } catch (error) {
      expectedOAuthState = null;
      return {
        launched: false,
        error:
          error instanceof Error
            ? `Failed to launch system browser: ${error.message}`
            : 'Failed to launch system browser.',
      };
    }
    return { launched: true, state };
  });
}

export function handleOAuthCallback(
  mainWindow: BrowserWindow,
  callbackUrl: string,
): OAuthCallbackPayload {
  const payload = parseOAuthCallbackUrl(callbackUrl);
  if (
    payload.ok &&
    (!expectedOAuthState ||
      !payload.state ||
      payload.state !== expectedOAuthState)
  ) {
    return {
      ok: false,
      error: 'OAuth state mismatch. Session was rejected for security reasons.',
    };
  }

  mainWindow.webContents.send(IPC_CHANNELS.oauthCallback, payload);
  expectedOAuthState = null;
  return payload;
}

export function getIpcChannels() {
  return IPC_CHANNELS;
}
