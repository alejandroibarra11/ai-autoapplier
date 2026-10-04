import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  findRoot, insertJobs, listJobsByStatus, loadConfig, openDb, recordUsage, setStatus,
  type Config, type LLMProvider,
} from '@autoapplier/core';
import { createDailyGate, runPipelineOnce } from '../src/pipeline';

const base = loadConfig(join(findRoot(), 'config.yaml'));
const cfg: Config = {
  ...base,
  sources: {
    greenhouse: false, lever: false, ashby: false, remoteok: false,
    remotive: { ...base.sources.remotive, enabled: false },
    himalayas: { ...base.sources.himalayas, enabled: false },
    wwr: { ...base.sources.wwr, enabled: false },
  },
};
const provider: LLMProvider = { name: 'anthropic', generateStructured: async () => { throw new Error('must not be called when capped'); } };

function cappedDb(now: Date) {
  const db = openDb(':memory:');
  insertJobs(db, [{
    source: 'ashby', sourceJobId: '1', company: 'Acme', title: 'AI Engineer', locationText: 'Remote - LATAM', description: 'd',
    applyUrl: 'https://x', ats: null, atsToken: null, compMin: null, compMax: null, compCurrency: null, compPeriod: null, postedAt: now,
  }]);
  setStatus(db, listJobsByStatus(db, ['discovered'])[0]!.id, 'passed_rules');
  recordUsage(db, { jobId: null, stage: 'score', provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 100 }, now);
  return db;
}

describe('createDailyGate', () => {
  it('opens once per UTC day', () => {
    const gate = createDailyGate();
    expect(gate(new Date('2026-10-03T00:30:00Z'))).toBe(true);
    expect(gate(new Date('2026-10-03T23:59:00Z'))).toBe(false);
    expect(gate(new Date('2026-10-04T00:00:01Z'))).toBe(true);
    expect(gate(new Date('2026-10-04T12:00:00Z'))).toBe(false);
  });
});

describe('runPipelineOnce spend-cap warning', () => {
  it('warns at most once per UTC day', async () => {
    const now = new Date();
    const db = cappedDb(now);
    const sent: string[] = [];
    const sender = { sendMessage: async (_c: string, t: string) => { sent.push(t); } };
    const ctx = { db, cfg, provider, profileText: 'p', sender, chatId: '42', capWarningGate: createDailyGate() };
    const first = await runPipelineOnce(ctx);
    expect(first.score.capped).toBe(true);
    await runPipelineOnce(ctx);
    expect(sent.filter((t) => t.includes('spend cap'))).toHaveLength(1);
  });
});
