import React, { useEffect, useMemo, useState } from 'react';
import type { OAuthCallbackPayload } from '../../shared/contracts';
import { deriveSyncStatus } from '../../shared/syncState';
import type { AppServices } from './backend/ports';
import { BudgetApp } from './features/budgets/BudgetApp';

type UiStatus = {
  type: 'info' | 'success' | 'error';
  message: string;
};

const DEFAULT_TEST_CONTENT = 'Stage 0 test file from Electron IPC';

export function App({ services }: { services?: AppServices } = {}) {
  const [mainHealth, setMainHealth] = useState<string>('Not checked');
  const [selectedFile, setSelectedFile] = useState<string>('None');
  const [testFilePath, setTestFilePath] = useState<string>('Not saved');
  const [status, setStatus] = useState<UiStatus>({
    type: 'info',
    message: 'Ready',
  });
  const [oauthState, setOAuthState] = useState<string>('Not started');
  const [pendingWrites, setPendingWrites] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  useEffect(() => {
    void window.electronApi.ping().then((result) => {
      setMainHealth(result.message);
    });

    const cleanup = window.electronApi.onOAuthCallback(
      (payload: OAuthCallbackPayload) => {
        if (payload.ok) {
          setStatus({
            type: 'success',
            message:
              'OAuth callback received. Configure token exchange in Firebase for live login.',
          });
          setOAuthState(`Callback accepted (state=${payload.state ?? 'n/a'})`);
          return;
        }
        setStatus({
          type: 'error',
          message: payload.error ?? 'OAuth callback failed.',
        });
      },
    );
    return cleanup;
  }, []);

  useEffect(() => {
    const onlineHandler = () => setIsOnline(true);
    const offlineHandler = () => setIsOnline(false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    return () => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
    };
  }, []);

  const syncStatus = useMemo(
    () => deriveSyncStatus({ isOnline, hasPendingWrites: pendingWrites }),
    [isOnline, pendingWrites],
  );

  async function handleSelectFile() {
    const result = await window.electronApi.selectLocalFile();
    if (result.canceled) {
      setStatus({ type: 'info', message: 'File selection was canceled.' });
      return;
    }
    if (!result.filePath) {
      setStatus({
        type: 'error',
        message: result.error ?? 'No file selected.',
      });
      return;
    }
    setSelectedFile(result.filePath);
    setStatus({ type: 'success', message: 'File selected successfully.' });
  }

  async function handleWriteTestFile() {
    setPendingWrites(true);
    const result = await window.electronApi.writeTestFile(DEFAULT_TEST_CONTENT);
    setPendingWrites(false);

    if (!result.success) {
      setStatus({
        type: 'error',
        message: result.error ?? 'Failed to write test file.',
      });
      return;
    }
    setTestFilePath(result.filePath ?? 'Unknown path');
    setStatus({
      type: 'success',
      message: 'Test file written in app data directory.',
    });
  }

  async function handleOAuthStart() {
    const result = await window.electronApi.startGoogleOAuth();
    if (!result.launched) {
      setStatus({
        type: 'error',
        message: result.error ?? 'Could not open browser.',
      });
      return;
    }
    setOAuthState(`Started (state=${result.state ?? 'n/a'})`);
    setStatus({
      type: 'info',
      message:
        'OAuth browser flow started. Complete login in system browser and return via deep link.',
    });
  }

  return (
    <main className="app-shell">
      <h1>Income Tracker — Stage 0 Prototype</h1>
      <p className="muted">
        Main process status: <strong>{mainHealth}</strong>
      </p>
      <p className="muted">
        Sync status: <strong data-testid="sync-status">{syncStatus}</strong>
      </p>

      {services && <BudgetApp services={services} />}

      <section className="card">
        <h2>Secure IPC prototype</h2>
        <div className="actions">
          <button type="button" onClick={handleSelectFile}>
            Select local file
          </button>
          <button type="button" onClick={handleWriteTestFile}>
            Write test file into app data
          </button>
          <button type="button" onClick={handleOAuthStart}>
            Start Google OAuth in system browser
          </button>
        </div>
        <p>
          Selected file: <code>{selectedFile}</code>
        </p>
        <p>
          Saved test file: <code>{testFilePath}</code>
        </p>
        <p>
          OAuth state: <code>{oauthState}</code>
        </p>
      </section>

      <section className="card">
        <h2>Network simulation</h2>
        <div className="actions">
          <button type="button" onClick={() => setIsOnline((value) => !value)}>
            Toggle online/offline
          </button>
          <button
            type="button"
            onClick={() => setPendingWrites((value) => !value)}
          >
            Toggle pending writes
          </button>
        </div>
      </section>

      <section className={`status status-${status.type}`} role="status">
        {status.message}
      </section>
    </main>
  );
}
