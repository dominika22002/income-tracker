import React, { useEffect, useMemo, useState } from 'react';
import type { OAuthCallbackPayload } from '../../shared/contracts';
import { deriveSyncStatus } from '../../shared/syncState';
import type { AppServices } from './backend/ports';
import { BudgetApp, type AppView } from './features/budgets/BudgetApp';

type ThemePreference = 'light' | 'dark' | 'system';

type UiStatus = {
  type: 'info' | 'success' | 'error';
  message: string;
};

const DEFAULT_TEST_CONTENT = 'Stage 0 test file from Electron IPC';
const THEME_STORAGE_KEY = 'income-tracker-theme';

function getStoredTheme(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function isThemePreference(value: string): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function App({
  services,
  requireAuth = true,
}: {
  services?: AppServices;
  requireAuth?: boolean;
} = {}) {
  const hasElectronBridge =
    typeof window.electronApi !== 'undefined' &&
    typeof window.electronApi.ping === 'function';
  const [mainHealth, setMainHealth] = useState<string>(
    hasElectronBridge ? 'Not checked' : 'Electron preload unavailable',
  );
  const [selectedFile, setSelectedFile] = useState<string>('None');
  const [testFilePath, setTestFilePath] = useState<string>('Not saved');
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [oauthState, setOAuthState] = useState<string>('Not started');
  const [pendingWrites, setPendingWrites] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [activeView, setActiveView] = useState<AppView>('overview');

  useEffect(() => {
    if (!hasElectronBridge) {
      return undefined;
    }

    void window.electronApi.ping().then((result) => {
      setMainHealth(result.message);
    });

    if (!requireAuth) return undefined;

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
  }, [hasElectronBridge, requireAuth]);

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

  useEffect(() => {
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        theme === 'system'
          ? (systemTheme?.matches ?? false)
            ? 'dark'
            : 'light'
          : theme;
    };

    applyTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    systemTheme?.addEventListener('change', applyTheme);
    return () => systemTheme?.removeEventListener('change', applyTheme);
  }, [theme]);

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

  if (!hasElectronBridge) {
    return (
      <main className="app-shell">
        <section className="card feature-panel">
          <h1>Income Tracker</h1>
          <p>
            Import plików wymaga dostępu do lokalnego systemu plików. Otwórz
            aplikację desktopową Income Tracker przez `npm run dev`; zwykły
            podgląd w przeglądarce nie ma mostu Electron.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="#top" aria-label="Income Tracker — początek">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M5 7h14M5 12h14M5 17h14" />
            </svg>
          </span>
          <span>Income Tracker</span>
        </a>
        {services && (
          <nav className="primary-nav" aria-label="Nawigacja główna">
            {(
              [
                ['overview', 'Przegląd'],
                ['transactions', 'Transakcje'],
                ['reports', 'Raporty'],
                ['budgets', 'Budżety'],
                ['imports', 'Importy'],
                ['settings', 'Ustawienia'],
              ] as const
            ).map(([view, label]) => (
              <button
                key={view}
                type="button"
                className={`nav-pill ${activeView === view ? 'is-active' : ''}`}
                aria-current={activeView === view ? 'page' : undefined}
                onClick={() => setActiveView(view)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        <div className="header-controls">
          <span className="sync-indicator">
            <span className="sync-dot" aria-hidden="true" />
            <span>
              Synchronizacja:{' '}
              <strong data-testid="sync-status">{syncStatus}</strong>
            </span>
          </span>
          <label className="theme-control">
            <span>Motyw</span>
            <select
              aria-label="Motyw"
              value={theme}
              onChange={(event) => {
                if (isThemePreference(event.target.value)) {
                  setTheme(event.target.value);
                }
              }}
            >
              <option value="light">Jasny</option>
              <option value="dark">Ciemny</option>
              <option value="system">Systemowy</option>
            </select>
          </label>
        </div>
      </header>

      <div className="app-content" id="top">
        {services && (
          <BudgetApp
            services={services}
            requireAuth={requireAuth}
            activeView={activeView}
            onViewChange={setActiveView}
          />
        )}

        {import.meta.env.DEV && (
          <details className="developer-tools">
            <summary>Narzędzia deweloperskie</summary>
            <p className="muted">
              Stan procesu głównego: <strong>{mainHealth}</strong>
            </p>
            <div className="actions">
              <button
                className="button-secondary"
                type="button"
                onClick={handleSelectFile}
              >
                Wybierz lokalny plik
              </button>
              <button
                className="button-secondary"
                type="button"
                onClick={handleWriteTestFile}
              >
                Zapisz plik testowy
              </button>
              {requireAuth && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={handleOAuthStart}
                >
                  Uruchom test OAuth
                </button>
              )}
            </div>
            <p>
              Wybrany plik: <code>{selectedFile}</code>
            </p>
            <p>
              Zapisany plik testowy: <code>{testFilePath}</code>
            </p>
            {requireAuth && (
              <p>
                Stan OAuth: <code>{oauthState}</code>
              </p>
            )}
            <div className="actions">
              <button
                className="button-secondary"
                type="button"
                onClick={() => setIsOnline((value) => !value)}
              >
                Przełącz online/offline
              </button>
              <button
                className="button-secondary"
                type="button"
                onClick={() => setPendingWrites((value) => !value)}
              >
                Przełącz oczekujące zapisy
              </button>
            </div>
          </details>
        )}

        {status && (
          <section
            className={`status status-${status.type}`}
            role={status.type === 'error' ? 'alert' : 'status'}
          >
            {status.message}
          </section>
        )}
      </div>
    </main>
  );
}
