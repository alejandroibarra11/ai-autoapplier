import { describe, it, expect } from 'vitest';
import { createDraftLoop } from '../src/draft-loop';

describe('createDraftLoop', () => {
  it('skips a tick while the previous one runs and survives errors', async () => {
    let calls = 0;
    let release!: () => void;
    const loop = createDraftLoop({ run: () => { calls++; return calls === 1 ? new Promise<void>((r) => { release = r; }) : Promise.reject(new Error('boom')); } });
    const first = loop.tick();
    await loop.tick();
    expect(calls).toBe(1);
    release();
    await first;
    await loop.tick();
    expect(calls).toBe(2);
    expect(loop.running()).toBe(false);
  });
});
