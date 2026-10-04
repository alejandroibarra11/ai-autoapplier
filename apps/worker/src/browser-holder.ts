import type { BrowserSession } from '@autoapplier/core';

export function createBrowserHolder(open: () => Promise<BrowserSession>) {
  let current: { session: BrowserSession; closed: boolean } | null = null;
  return {
    async get(): Promise<BrowserSession> {
      if (current && !current.closed) return current.session;
      const session = await open();
      const entry = { session, closed: false };
      current = entry;
      session.context.on('close', () => { entry.closed = true; if (current === entry) current = null; });
      return session;
    },
    reset(): void { current = null; },
    peek(): BrowserSession | null { return current && !current.closed ? current.session : null; },
  };
}

/** Logs at most once per interval. */
export function createLogThrottle(intervalMs: number, now: () => number = Date.now) {
  let last = -Infinity;
  return (log: () => void) => { if (now() - last >= intervalMs) { last = now(); log(); } };
}
