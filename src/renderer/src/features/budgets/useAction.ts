import { useCallback, useState } from 'react';
import { describeError } from './errorMessages';

export interface Notice {
  type: 'success' | 'error';
  message: string;
}

export type Notify = (notice: Notice | null) => void;

/** Runs a server operation; reports success only after the server confirmed it. */
export function useAction(notify: Notify) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(action: () => Promise<T>, success: (result: T) => string) => {
      setBusy(true);
      notify(null);
      try {
        const result = await action();
        notify({ type: 'success', message: success(result) });
        return result;
      } catch (error) {
        notify({ type: 'error', message: describeError(error) });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  return { busy, run };
}
