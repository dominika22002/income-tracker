export function isSecureProductionUrl(
  envMode: 'development' | 'production',
  url: string | undefined,
): boolean {
  if (!url) {
    return true;
  }
  if (envMode === 'development') {
    return true;
  }
  return url.startsWith('https://');
}
