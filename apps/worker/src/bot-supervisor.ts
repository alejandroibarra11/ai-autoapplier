import { GrammyError } from 'grammy';

export const BOT_RETRY_INITIAL_MS = 60_000;
export const BOT_RETRY_MAX_MS = 10 * 60_000;

export interface SuperviseOptions {
  /** Starts long polling; must call onStart once polling is up. Resolves when polling stops, rejects on failure. */
  start: (onStart: () => void) => Promise<void>;
  onStateChange?: (up: boolean) => void;
  shouldStop?: () => boolean;
  delay?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Keeps the Telegram bot running without taking the worker down with it. A failed start is retried
 * after 60s, doubling up to 10 min (reset after a successful start). An invalid token (401) is
 * logged once and Telegram stays disabled.
 */
export async function superviseBot(opts: SuperviseOptions): Promise<'stopped' | 'unauthorized'> {
  const delay = opts.delay ?? sleep;
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;
  let backoff = BOT_RETRY_INITIAL_MS;
  for (;;) {
    try {
      await opts.start(() => { backoff = BOT_RETRY_INITIAL_MS; opts.onStateChange?.(true); });
      return 'stopped';
    } catch (e) {
      opts.onStateChange?.(false);
      if (e instanceof GrammyError && e.error_code === 401) {
        error('[telegram] invalid TELEGRAM_BOT_TOKEN (401 Unauthorized); Telegram disabled, pipeline keeps running');
        return 'unauthorized';
      }
      if (opts.shouldStop?.()) return 'stopped';
      log(`[telegram] bot failed (${e instanceof Error ? e.message : String(e)}); notifications disabled, retrying in ${backoff / 1000}s`);
      await delay(backoff);
      backoff = Math.min(backoff * 2, BOT_RETRY_MAX_MS);
      if (opts.shouldStop?.()) return 'stopped';
    }
  }
}
