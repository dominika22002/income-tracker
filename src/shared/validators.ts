import type { OAuthCallbackPayload, WriteTestFileRequest } from './contracts';

const MAX_TEST_CONTENT_SIZE = 2_048;

export function validateWriteTestFileRequest(
  input: unknown,
): WriteTestFileRequest | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('content' in input) ||
    typeof input.content !== 'string'
  ) {
    return null;
  }

  const trimmed = input.content.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEST_CONTENT_SIZE) {
    return null;
  }

  return { content: trimmed };
}

export function validateOAuthState(
  expectedState: string,
  payload: OAuthCallbackPayload,
): boolean {
  return (
    payload.ok &&
    typeof payload.state === 'string' &&
    payload.state === expectedState
  );
}
