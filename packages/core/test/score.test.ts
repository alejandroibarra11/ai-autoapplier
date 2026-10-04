import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { applyEvidenceCheck, decide, evidenceFound } from '../src/score/score';
import { evidenceText, jobContextText, MAX_POSTING_CHARS } from '../src/score/prompt';
import { runScore } from '../src/pipeline/score';
import { LLMParseError, type LLMProvider, type StructuredRequest } from '../src/llm/provider';
import type { ScorePayload } from '../src/score/schema';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import { makeJob, testDb } from './helpers';
import { getJob, insertJobs, latestScore, listJobsByStatus, recordUsage, setStatus, spendSince } from '../src/db/repo';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const base: ScorePayload = {
  eligibility: 'eligible', eligibilityEvidence: 'contractors anywhere in Latin America', fitScore: 82,
  roleCategory: 'ai', matched: ['TypeScript'], missing: [], redFlags: [], compEstimate: null,
};

describe('evidenceFound', () => {
  const text = 'Location: Remote - LATAM\n\nWe hire contractors   anywhere in\nLatin America.';
  it('matches verbatim quotes ignoring case/whitespace and wrapping quotes', () => {
    expect(evidenceFound('"Contractors anywhere in Latin America"', text)).toBe(true);
    expect(evidenceFound('Remote - LATAM', text)).toBe(true);
  });
  it('supports ellipsis-joined fragments', () => {
    expect(evidenceFound('We hire contractors ... Latin America', text)).toBe(true);
  });
  it('requires ellipsis fragments in order', () => {
    expect(evidenceFound('work from anywhere ... Latin America', 'customers in Latin America. work from anywhere in the US')).toBe(false);
  });
  it('rejects invented or too-short quotes', () => {
    expect(evidenceFound('open to candidates in Mexico', text)).toBe(false);
    expect(evidenceFound('none found', text)).toBe(false);
    expect(evidenceFound('LA', text)).toBe(false);
  });
});

describe('applyEvidenceCheck / decide', () => {
  it('downgrades eligible with invented evidence', () => {
    const s = applyEvidenceCheck({ ...base, eligibilityEvidence: 'Mexico welcome' }, 'Remote - US only');
    expect(s.eligibility).toBe('unlikely');
    expect(s.redFlags).toContain('eligibility evidence not found in posting');
  });
  it('leaves ineligible untouched', () => {
    const s = applyEvidenceCheck({ ...base, eligibility: 'ineligible', eligibilityEvidence: 'made up' }, 'text');
    expect(s.eligibility).toBe('ineligible');
  });
  it('decides by eligibility then threshold', () => {
    expect(decide(base, 65)).toBe('awaiting_review');
    expect(decide({ ...base, eligibility: 'likely', fitScore: 65 }, 65)).toBe('awaiting_review');
    expect(decide({ ...base, fitScore: 64 }, 65)).toBe('low_score');
    expect(decide({ ...base, eligibility: 'unlikely' }, 65)).toBe('ineligible');
    expect(decide({ ...base, eligibility: 'ineligible' }, 65)).toBe('ineligible');
  });
});

describe('evidenceText', () => {
  it('excludes synthetic header lines', () => {
    const text = evidenceText(makeJob());
    expect(evidenceFound('Title: Senior AI Engineer', text)).toBe(false);
    expect(evidenceFound('Compensation: not stated', text)).toBe(false);
    expect(evidenceFound('Location: Remote - LATAM', text)).toBe(true);
    expect(evidenceFound('Location: not stated', evidenceText({ ...makeJob(), locationText: '' }))).toBe(false);
  });
});

describe('jobContextText', () => {
  it('includes header fields and truncates long descriptions with a marker', () => {
    const t = jobContextText({ ...makeJob({ compMin: 50, compMax: 70, compCurrency: 'USD', compPeriod: 'hour' }), description: 'x'.repeat(MAX_POSTING_CHARS + 10) });
    expect(t).toContain('Location: Remote - LATAM');
    expect(t).toContain('Compensation: USD 50–70 per hour');
    expect(t).toContain('[description truncated]');
  });
});

class FakeProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  calls = 0;
  constructor(private readonly responses: (ScorePayload | Error)[]) {}
  async generateStructured<T>(model: string, _req: StructuredRequest<T>) {
    const r = this.responses[Math.min(this.calls++, this.responses.length - 1)]!;
    const usage = { provider: 'anthropic' as const, model, inputTokens: 3000, outputTokens: 300 };
    if (r instanceof Error) throw r;
    return { data: r as unknown as T, usage };
  }
}

function seedPassed(db: ReturnType<typeof testDb>, n = 1) {
  insertJobs(db, Array.from({ length: n }, () => makeJob()));
  for (const j of listJobsByStatus(db, ['discovered'])) setStatus(db, j.id, 'passed_rules');
  return listJobsByStatus(db, ['passed_rules']);
}

describe('runScore', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('scores, stores payload, records usage, and routes by decision', async () => {
    const db = testDb();
    const [job] = seedPassed(db);
    const provider = new FakeProvider([base]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(r).toEqual({ scored: 1, failed: 0, capped: false });
    expect(getJob(db, job!.id)!.status).toBe('awaiting_review');
    expect(latestScore(db, job!.id)).toEqual(base);
    expect(spendSince(db, new Date('2026-10-03T00:00:00Z'))).toBeCloseTo(0.0045);
  });

  it('clamps fitScore to 0..100', async () => {
    const db = testDb();
    const [job] = seedPassed(db);
    await runScore({ db, cfg, provider: new FakeProvider([{ ...base, fitScore: 140.6 }]), profileText: 'p', now });
    expect(latestScore(db, job!.id)!.fitScore).toBe(100);
  });

  it('retries once on parse errors, then marks score_failed and increments attempts', async () => {
    const db = testDb();
    const [job] = seedPassed(db);
    const provider = new FakeProvider([new LLMParseError('bad'), new LLMParseError('bad again')]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(provider.calls).toBe(2);
    expect(r).toEqual({ scored: 0, failed: 1, capped: false });
    const j = getJob(db, job!.id)!;
    expect(j.status).toBe('score_failed');
    expect(j.scoreAttempts).toBe(1);
  });

  it('recovers when the retry succeeds', async () => {
    const db = testDb();
    seedPassed(db);
    const r = await runScore({ db, cfg, provider: new FakeProvider([new LLMParseError('bad'), base]), profileText: 'p', now });
    expect(r.scored).toBe(1);
  });

  it('does not retry non-parse errors (e.g. API errors) and does not crash', async () => {
    const db = testDb();
    seedPassed(db, 2);
    const provider = new FakeProvider([new Error('500 overloaded')]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(provider.calls).toBe(2);
    expect(r).toEqual({ scored: 0, failed: 2, capped: false });
    for (const j of listJobsByStatus(db, ['score_failed'])) expect(j.scoreAttempts).toBe(0);
  });

  it('stops after 3 consecutive non-parse errors', async () => {
    const db = testDb();
    seedPassed(db, 5);
    const provider = new FakeProvider([new Error('401')]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(provider.calls).toBe(3);
    expect(r.failed).toBe(3);
  });

  it('records usage attached to parse errors', async () => {
    const db = testDb();
    seedPassed(db);
    const usage = { provider: 'anthropic' as const, model: cfg.scoring.model, inputTokens: 3000, outputTokens: 300 };
    const r = await runScore({ db, cfg, provider: new FakeProvider([new LLMParseError('bad', usage)]), profileText: 'p', now });
    expect(r.failed).toBe(1);
    expect(spendSince(db, new Date('2026-10-03T00:00:00Z'))).toBeCloseTo(0.009);
  });

  it('stops when the daily spend cap is reached', async () => {
    const db = testDb();
    seedPassed(db, 3);
    recordUsage(db, { jobId: null, stage: 'score', provider: 'anthropic', model: 'x', inputTokens: 0, outputTokens: 0, costUsd: cfg.scoring.dailySpendCapUsd }, now);
    const provider = new FakeProvider([base]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(r).toEqual({ scored: 0, failed: 0, capped: true });
    expect(provider.calls).toBe(0);
  });
});
