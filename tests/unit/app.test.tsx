import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/App';
import type { IpcApi, OAuthCallbackPayload } from '../../src/shared/contracts';

function mockApi(): IpcApi {
  return {
    ping: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    selectLocalFile: vi.fn().mockResolvedValue({ canceled: true }),
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
  beforeEach(() => {
    window.electronApi = mockApi();
  });

  it('renders core screen and updates sync status', async () => {
    render(<App />);

    expect(
      await screen.findByRole('heading', {
        name: /income tracker — stage 0 prototype/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('sync-status')).toHaveTextContent('confirmed');

    fireEvent.click(
      screen.getByRole('button', { name: /toggle online\/offline/i }),
    );
    expect(screen.getByTestId('sync-status')).toHaveTextContent('offline');
  });
});
