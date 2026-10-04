import { describe, it, expect, vi } from 'vitest';
import { GrammyError } from 'grammy';
import { superviseBot, BOT_RETRY_INITIAL_MS, BOT_RETRY_MAX_MS } from '../src/bot-supervisor';

const apiError = (code: number) => new GrammyError(`code ${code}`, { ok: false, error_code: code, description: `code ${code}` }, 'getMe', {});
const quiet = { log: () => {}, error: () => {} };

describe('superviseBot', () => {
  it('reports up on start and returns when polling stops normally', async () => {
    const states: boolean[] = [];
    const r = await superviseBot({ ...quiet, start: async (onStart) => { onStart(); }, onStateChange: (up) => states.push(up), delay: async () => {} });
    expect(r).toBe('stopped');
    expect(states).toEqual([true]);
  });

  it('retries failed starts with backoff from 60s capped at 10 min, and resets after a success', async () => {
    let attempt = 0;
    const delays: number[] = [];
    const states: boolean[] = [];
    const start = async (onStart: () => void) => {
      attempt += 1;
      if (attempt <= 6) throw new Error('network down');
      if (attempt === 7) { onStart(); throw new Error('polling died'); } // ran, then failed
      if (attempt === 8) throw new Error('network down again');
      onStart();
    };
    const r = await superviseBot({ ...quiet, start, delay: async (ms) => { delays.push(ms); }, onStateChange: (up) => states.push(up) });
    expect(r).toBe('stopped');
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 60_000, 120_000]);
    expect(BOT_RETRY_INITIAL_MS).toBe(60_000);
    expect(BOT_RETRY_MAX_MS).toBe(600_000);
    expect(states).toEqual([false, false, false, false, false, false, true, false, false, true]);
  });

  it('disables Telegram without retrying on 401 (invalid token) and logs once', async () => {
    const start = vi.fn(async () => { throw apiError(401); });
    const delay = vi.fn(async () => {});
    const error = vi.fn();
    const states: boolean[] = [];
    const r = await superviseBot({ start, delay, error, log: () => {}, onStateChange: (up) => states.push(up) });
    expect(r).toBe('unauthorized');
    expect(start).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/401|token/i);
    expect(states).toEqual([false]);
  });

  it('stops retrying when shutdown is requested', async () => {
    let stopping = false;
    const start = vi.fn(async () => { throw new Error('down'); });
    const r = await superviseBot({ ...quiet, start, delay: async () => { stopping = true; }, shouldStop: () => stopping });
    expect(r).toBe('stopped');
    expect(start).toHaveBeenCalledTimes(1);
  });
});
