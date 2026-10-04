import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDrafting } from '../src/pipeline/draft';
import { loadConfig } from '../src/config';
import { loadProfile } from '../src/profile';
import { parseAnswers } from '../src/answers';
import { findRoot } from '../src/root';
import { COMMON_QUESTIONS } from '../src/apply/common';
import { LLMParseError, type LLMProvider, type StructuredRequest } from '../src/llm/provider';
import { getJob, resetStaleDrafting, insertJobs, latestDraft, listJobsByStatus, recordUsage, setStatus } from '../src/db/repo';
import { makeJob, testDb } from './helpers';

const root = findRoot();
const cfg = loadConfig(join(root, 'config.yaml'));
const profile = loadProfile(join(root, 'profile/profile.example.yaml'));
const answers = parseAnswers(readFileSync(join(root, 'profile/answers.example.yaml'), 'utf8'));
const out = { coverLetter: 'Hi', answers: [{ questionId: 'why_company', answer: 'X' }, { questionId: 'why_role', answer: 'Y' }], skillsOrder: [], bulletIds: ['e0-b0'], claimedSkills: [] };
const now = new Date('2026-10-04T12:00:00Z');

class Fake implements LLMProvider {
  readonly name = 'anthropic' as const;
  calls = 0;
  constructor(private readonly r: unknown[]) {}
  async generateStructured<T>(model: string, _q: StructuredRequest<T>) {
    const x = this.r[Math.min(this.calls++, this.r.length - 1)];
    if (x instanceof Error) throw x;
    return { data: x as T, usage: { provider: 'anthropic' as const, model, inputTokens: 5000, outputTokens: 1000 } };
  }
}

function setup(n = 1) {
  const db = testDb();
  insertJobs(db, Array.from({ length: n }, () => makeJob()));
  const jobs = listJobsByStatus(db, ['discovered']);
  for (const j of jobs) setStatus(db, j.id, 'shortlisted');
  return { db, jobs };
}
const deps = (db: ReturnType<typeof testDb>, provider: LLMProvider, extra = {}) => ({
  db, cfg, provider, profile, answers, cvDir: '/tmp/aa-cv-test', now,
  resolve: async () => ({ kind: 'manual' as const, url: 'https://himalayas.app/j' }),
  questions: async () => COMMON_QUESTIONS,
  renderPdf: async () => {},
  ...extra,
});

describe('runDrafting', () => {
  it('drafts exactly onlyJobId even when it is newest among many shortlisted jobs', async () => {
    const { db, jobs } = setup(60);
    const target = jobs[59]!.id;
    setStatus(db, target, 'shortlisted', null, {}, new Date('2026-10-04T11:00:00Z'));
    const r = await runDrafting(deps(db, new Fake([out]), { onlyJobId: target, limit: 1 }));
    expect(r.drafted).toBe(1);
    expect(getJob(db, target)!.status).toBe('draft_ready');
    expect(listJobsByStatus(db, ['shortlisted'], 100)).toHaveLength(59);
  });

  it('onlyJobId ignores a job that is not shortlisted', async () => {
    const { db, jobs } = setup(1);
    setStatus(db, jobs[0]!.id, 'skipped');
    const r = await runDrafting(deps(db, new Fake([out]), { onlyJobId: jobs[0]!.id }));
    expect(r.drafted).toBe(0);
  });

  it('drafts shortlisted jobs into draft_ready with a stored draft and resolution', async () => {
    const { db, jobs } = setup();
    const r = await runDrafting(deps(db, new Fake([out])));
    expect(r).toEqual({ drafted: 1, failed: 0, capped: false });
    const j = getJob(db, jobs[0]!.id)!;
    expect(j.status).toBe('draft_ready');
    expect(j.resolvedKind).toBe('manual');
    const d = latestDraft(db, j.id)!;
    expect(d.cvPdfPath).toMatch(/aa-cv-test\/\d+-acme\.pdf$/);
    expect(d.answers.find((a) => a.questionId === 'work_auth')).toMatchObject({ answer: 'No', source: 'answers' });
  });

  it('still drafts when resolve or questions throw', async () => {
    const { db, jobs } = setup();
    await runDrafting(deps(db, new Fake([out]), {
      resolve: async () => { throw new Error('browser crashed'); },
      questions: async () => { throw new Error('nope'); },
    }));
    expect(getJob(db, jobs[0]!.id)!.status).toBe('draft_ready');
    expect(getJob(db, jobs[0]!.id)!.resolvedKind).toBe('manual');
  });

  it('keeps the draft and flags it when the PDF fails', async () => {
    const { db, jobs } = setup();
    await runDrafting(deps(db, new Fake([out]), { renderPdf: async () => { throw new Error('chromium missing'); } }));
    const d = latestDraft(db, jobs[0]!.id)!;
    expect(d.cvPdfPath).toBeNull();
    expect(d.flags).toContain('CV not generated');
  });

  it('parse failures count attempts: back to shortlisted, then draft_failed', async () => {
    const { db, jobs } = setup();
    const bad = () => new Fake([new LLMParseError('bad')]);
    await runDrafting(deps(db, bad()));
    expect(getJob(db, jobs[0]!.id)).toMatchObject({ status: 'shortlisted', draftAttempts: 1 });
    const r = await runDrafting(deps(db, bad()));
    expect(getJob(db, jobs[0]!.id)).toMatchObject({ status: 'draft_failed', draftAttempts: 2, draftFailureNotifiedAt: null });
    expect(r).toMatchObject({ failed: 1, drafted: 0, lastError: 'bad' });
  });

  it('API errors do not count attempts and stop after 3 in a row', async () => {
    const { db, jobs } = setup(5);
    const p = new Fake([new Error('529 overloaded')]);
    const r = await runDrafting(deps(db, p));
    expect(p.calls).toBe(3);
    expect(r.failed).toBe(3);
    expect(jobs.every((j) => getJob(db, j.id)!.status === 'shortlisted' && getJob(db, j.id)!.draftAttempts === 0)).toBe(true);
  });

  it('respects the drafting spend cap (scoring spend does not count)', async () => {
    const { db } = setup();
    const u = { jobId: null, provider: 'anthropic', model: 'x', inputTokens: 0, outputTokens: 0 };
    recordUsage(db, { ...u, stage: 'score', costUsd: 100 }, now);
    expect((await runDrafting(deps(db, new Fake([out])))).drafted).toBe(1);
    const { db: db2 } = setup();
    recordUsage(db2, { ...u, stage: 'draft', costUsd: cfg.drafting.dailySpendCapUsd }, now);
    const p = new Fake([out]);
    expect(await runDrafting(deps(db2, p))).toEqual({ drafted: 0, failed: 0, capped: true });
    expect(p.calls).toBe(0);
  });

  it('never drafts jobs that are not shortlisted', async () => {
    const db = testDb();
    insertJobs(db, [makeJob()]);
    const [j] = listJobsByStatus(db, ['discovered']);
    setStatus(db, j!.id, 'awaiting_review');
    const p = new Fake([out]);
    await runDrafting(deps(db, p));
    expect(p.calls).toBe(0);
  });

  it('resets stale drafting jobs and leaves fresh ones', async () => {
    const { db, jobs } = setup(2);
    setStatus(db, jobs[0]!.id, 'drafting', null, {}, new Date(now.getTime() - 20 * 60_000));
    setStatus(db, jobs[1]!.id, 'drafting', null, {}, new Date(now.getTime() - 5 * 60_000));
    const r = await runDrafting(deps(db, new Fake([out])));
    expect(r.drafted).toBe(1);
    expect(getJob(db, jobs[0]!.id)!.status).toBe('draft_ready');
    expect(getJob(db, jobs[1]!.id)!.status).toBe('drafting');
    expect(resetStaleDrafting(db, now, now)).toBe(1);
  });

  it('times out hung steps and carries on', async () => {
    const { db, jobs } = setup();
    const never = () => new Promise<never>(() => {});
    await runDrafting(deps(db, new Fake([out]), { stepTimeoutMs: 20, resolve: never, questions: never, renderPdf: never }));
    expect(getJob(db, jobs[0]!.id)!.status).toBe('draft_ready');
    expect(getJob(db, jobs[0]!.id)!.resolvedKind).toBe('manual');
    expect(latestDraft(db, jobs[0]!.id)!.flags).toContain('CV not generated');
  });

  it('counts a failed save as an attempt', async () => {
    const { db, jobs } = setup();
    const save = () => { throw new Error('disk full'); };
    await runDrafting(deps(db, new Fake([out]), { save }));
    expect(getJob(db, jobs[0]!.id)).toMatchObject({ status: 'shortlisted', draftAttempts: 1 });
    await runDrafting(deps(db, new Fake([out]), { save }));
    expect(getJob(db, jobs[0]!.id)).toMatchObject({ status: 'draft_failed', draftAttempts: 2 });
  });
});
