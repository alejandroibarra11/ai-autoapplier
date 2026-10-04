import { describe, it, expect } from 'vitest';
import { createDraftLoop, createFailureWatch } from '../src/draft-loop';

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

describe('createFailureWatch', () => {
  const day1 = new Date('2026-10-04T10:00:00Z');
  const fail = { drafted: 0, failed: 2, capped: false, lastError: 'model not found: claude-x' };
  it('warns after 3 consecutive all-failing ticks, at most once per UTC day', () => {
    const w = createFailureWatch();
    expect(w(fail, day1)).toBeNull();
    expect(w(fail, day1)).toBeNull();
    expect(w(fail, day1)).toBe('⚠️ Drafting keeps failing: model not found: claude-x — check the model id / API key / credits');
    for (let i = 0; i < 5; i++) expect(w(fail, day1)).toBeNull();
    expect(w(fail, new Date('2026-10-05T00:01:00Z'))).toMatch(/Drafting keeps failing/);
  });
  it('resets the streak when a tick drafts something or has no failures', () => {
    const w = createFailureWatch();
    w(fail, day1); w(fail, day1);
    expect(w({ drafted: 1, failed: 1 }, day1)).toBeNull();
    w(fail, day1); w(fail, day1);
    expect(w({ drafted: 0, failed: 0 }, day1)).toBeNull();
    expect(w(fail, day1)).toBeNull();
  });
});

