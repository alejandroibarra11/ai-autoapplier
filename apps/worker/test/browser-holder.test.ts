import { describe, it, expect } from 'vitest';
import type { BrowserSession } from '@autoapplier/core';
import { createBrowserHolder, createLogThrottle } from '../src/browser-holder';

function fake() {
  const handlers: Array<() => void> = [];
  const s = { context: { on: (_e: string, h: () => void) => { handlers.push(h); } }, close: async () => {} } as unknown as BrowserSession;
  return { s, fireClose: () => handlers.forEach((h) => h()) };
}

describe('createBrowserHolder', () => {
  it('reuses the session until its context closes, then reopens', async () => {
    const made: ReturnType<typeof fake>[] = [];
    const holder = createBrowserHolder(async () => { const f = fake(); made.push(f); return f.s; });
    const a = await holder.get();
    expect(await holder.get()).toBe(a);
    expect(made).toHaveLength(1);
    made[0]!.fireClose();
    const b = await holder.get();
    expect(b).not.toBe(a);
    expect(made).toHaveLength(2);
  });

  it('a stale close event does not reset a newer session', async () => {
    const made: ReturnType<typeof fake>[] = [];
    const holder = createBrowserHolder(async () => { const f = fake(); made.push(f); return f.s; });
    await holder.get();
    holder.reset();
    const b = await holder.get();
    made[0]!.fireClose();
    expect(await holder.get()).toBe(b);
  });
});

describe('createLogThrottle', () => {
  it('logs at most once per interval', () => {
    let t = 0;
    const th = createLogThrottle(1000, () => t);
    let n = 0;
    th(() => n++); th(() => n++);
    t = 1500; th(() => n++);
    expect(n).toBe(2);
  });
});
