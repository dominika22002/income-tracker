export interface IpcApi {
  ping(): Promise<{ ok: true; message: string }>;
  selectLocalFile(): Promise<{
    canceled: boolean;
    filePath?: string;
    error?: string;
  }>;
  writeTestFile(content: string): Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  startGoogleOAuth(): Promise<{
    launched: boolean;
    state?: string;
    error?: string;
  }>;
  onOAuthCallback(
    listener: (payload: OAuthCallbackPayload) => void,
  ): () => void;
}

export interface OAuthCallbackPayload {
  ok: boolean;
  state?: string;
  code?: string;
  error?: string;
}

export interface WriteTestFileRequest {
  content: string;
}
