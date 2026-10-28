/// <reference types="vite/client" />

import type { IpcApi } from '../../shared/contracts';

declare global {
  interface Window {
    electronApi: IpcApi;
  }
}

export {};
