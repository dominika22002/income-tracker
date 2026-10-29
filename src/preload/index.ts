import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi, OAuthCallbackPayload } from '../shared/contracts';

const api: IpcApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  saveExportFile: (request) => ipcRenderer.invoke('export:saveFile', request),
  saveReportPdf: (request) =>
    ipcRenderer.invoke('export:saveReportPdf', request),
  selectLocalFile: () => ipcRenderer.invoke('file:select'),
  readLocalStatement: (request) =>
    ipcRenderer.invoke('file:readStatement', request),
  writeTestFile: (content) => ipcRenderer.invoke('file:writeTest', { content }),
  startGoogleOAuth: () => ipcRenderer.invoke('oauth:start'),
  onOAuthCallback: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: OAuthCallbackPayload,
    ) => listener(payload);
    ipcRenderer.on('oauth:callback', wrapped);
    return () => {
      ipcRenderer.removeListener('oauth:callback', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('electronApi', api);
