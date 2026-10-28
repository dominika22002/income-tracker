import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OAuthCallbackPayload } from '../shared/contracts';
import {
  buildGoogleOAuthUrl,
  createOAuthState,
  parseOAuthCallbackUrl,
} from './oauth';
import { validateWriteTestFileRequest } from '../shared/validators';

const IPC_CHANNELS = {
  ping: 'app:ping',
  selectFile: 'file:select',
  writeTestFile: 'file:writeTest',
  startOAuth: 'oauth:start',
  oauthCallback: 'oauth:callback',
} as const;

let expectedOAuthState: string | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.ping, () => ({
    ok: true as const,
    message: 'Electron main process is reachable.',
  }));

  ipcMain.handle(IPC_CHANNELS.selectFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select local file',
      properties: ['openFile'],
    });

    if (result.canceled) {
      return { canceled: true };
    }
    const [filePath] = result.filePaths;
    return { canceled: false, filePath };
  });

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
