import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/App';
import type { IpcApi, OAuthCallbackPayload } from '../../src/shared/contracts';

function mockApi(): IpcApi {
  return {
    ping: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    selectLocalFile: vi.fn().mockResolvedValue({ canceled: true }),
    readLocalStatement: vi.fn().mockResolvedValue({ success: false }),
    writeTestFile: vi
      .fn()
      .mockResolvedValue({ success: true, filePath: '/tmp/test.txt' }),
    startGoogleOAuth: vi
      .fn()
      .mockResolvedValue({ launched: true, state: 'state' }),
    onOAuthCallback: vi
      .fn()
      .mockImplementation(
        (listener: (payload: OAuthCallbackPayload) => void) => {
          listener({ ok: true, state: 'state', code: 'code' });
          return () => undefined;
        },
      ),
  };
}

describe('App', () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.electronApi = mockApi();
    window.localStorage.clear();
  });

  it('renders core screen and updates sync status', async () => {
    render(<App />);

    expect(
      await screen.findByRole('link', { name: /income tracker/i }),
    ).toHaveAttribute('href', '#top');
    expect(screen.getByTestId('sync-status')).toHaveTextContent('confirmed');

    fireEvent.click(
      screen.getByRole('button', { name: /przełącz online\/offline/i }),
    );
    expect(screen.getByTestId('sync-status')).toHaveTextContent('offline');
  });

  it('applies and persists the selected theme', async () => {
    const { getByRole } = render(<App />);

    fireEvent.change(getByRole('combobox', { name: 'Motyw' }), {
      target: { value: 'dark' },
    });

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('income-tracker-theme')).toBe('dark');
  });

  it('explains that local file access requires the Electron app', () => {
    Object.defineProperty(window, 'electronApi', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    render(<App />);

    expect(
      screen.getByText(/zwykły podgląd w przeglądarce nie ma mostu Electron/i),
    ).toBeInTheDocument();
  });
});
