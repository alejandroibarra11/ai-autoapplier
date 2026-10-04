import { describe, it, expect } from 'vitest';
import { createMutex } from '../src/mutex';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createMutex', () => {
  it('runs overlapping calls one after the other', async () => {
    const lock = createMutex();
    const log: string[] = [];
    const a = lock(async () => { log.push('a start'); await tick(20); log.push('a end'); return 1; });
    const b = lock(async () => { log.push('b start'); await tick(1); log.push('b end'); return 2; });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end']);
  });

  it('an error in the first call does not block the second', async () => {
    const lock = createMutex();
    const a = lock(async () => { await tick(5); throw new Error('boom'); });
    const b = lock(async () => 'ok');
    await expect(a).rejects.toThrow('boom');
    expect(await b).toBe('ok');
  });

  it('a synchronous throw is a rejection, not a stuck lock', async () => {
    const lock = createMutex();
    await expect(lock((() => { throw new Error('sync'); }) as () => Promise<never>)).rejects.toThrow('sync');
    expect(await lock(async () => 3)).toBe(3);
  });
});
