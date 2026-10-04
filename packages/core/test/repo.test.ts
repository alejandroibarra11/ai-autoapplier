import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import {
  insertJobs, getJob, listJobsByStatus, listJobsForScoring, setStatus, listEvents, insertScore, latestScore,
  recordUsage, spendSince, upsertCompany, listActiveCompanies, deactivateCompany, listUnnotified, markNotified,
  countByStatus, spendByDay,
} from '../src/db/repo';
import type { ScorePayload } from '../src/score/schema';

const score: ScorePayload = {
  eligibility: 'eligible', eligibilityEvidence: 'anywhere in Latin America', fitScore: 80,
  roleCategory: 'ai', matched: ['TypeScript'], missing: [], redFlags: [], compEstimate: null,
};

describe('repo', () => {
  it('same job re-polled from the same source is stored once (source + sourceJobId)', () => {
    const db = testDb();
    const a = makeJob({ company: 'Acme', title: 'AI Engineer' });
    expect(insertJobs(db, [a])).toEqual({ inserted: 1, skipped: 0 });
    expect(insertJobs(db, [a])).toEqual({ inserted: 0, skipped: 0 });
    expect(insertJobs(db, [{ ...a, title: 'AI Engineer (edited)' }])).toEqual({ inserted: 0, skipped: 0 });
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(1);
  });

  it('same company + title + location from another source is stored once', () => {
    const db = testDb();
    const a = makeJob({ company: 'Acme', title: 'AI Engineer', locationText: 'Remote - LATAM' });
    insertJobs(db, [a]);
    expect(insertJobs(db, [{ ...a, source: 'remoteok', sourceJobId: 'x', company: 'ACME', locationText: 'remote latam' }]))
      .toEqual({ inserted: 0, skipped: 0 });
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(1);
  });

  it('keeps region variants: same company + title, different location', () => {
    const db = testDb();
    const a = makeJob({ company: 'Acme', title: 'AI Engineer', locationText: 'Remote - LATAM' });
    expect(insertJobs(db, [a, { ...a, sourceJobId: 'b', locationText: 'Remote - Europe' }])).toEqual({ inserted: 2, skipped: 0 });
    expect(insertJobs(db, [{ ...a, source: 'remoteok', sourceJobId: 'c', locationText: 'Remote - US' }])).toEqual({ inserted: 1, skipped: 0 });
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(3);
  });

  it('the same sourceJobId from different sources are different jobs', () => {
    const db = testDb();
    expect(insertJobs(db, [makeJob({ sourceJobId: '1' }), makeJob({ source: 'lever', sourceJobId: '1' })])).toEqual({ inserted: 2, skipped: 0 });
  });

  it('skips rows with an invalid postedAt without dropping the rest of the batch', () => {
    const db = testDb();
    const r = insertJobs(db, [makeJob(), makeJob({ postedAt: new Date('nope') }), makeJob()]);
    expect(r).toEqual({ inserted: 2, skipped: 1 });
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(2);
  });

  it('setStatus updates row and writes an event', () => {
    const db = testDb();
    insertJobs(db, [makeJob()]);
    const [job] = listJobsByStatus(db, ['discovered']);
    setStatus(db, job!.id, 'filtered_out', 'title', { filterReason: 'title: no include match' });
    const updated = getJob(db, job!.id)!;
    expect(updated.status).toBe('filtered_out');
    expect(updated.filterReason).toBe('title: no include match');
    const events = listEvents(db, job!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: 'discovered', toStatus: 'filtered_out', note: 'title' });
  });

  it('listJobsForScoring respects statuses and attempts', () => {
    const db = testDb();
    insertJobs(db, [makeJob(), makeJob(), makeJob()]);
    const [a, b, c] = listJobsByStatus(db, ['discovered']);
    setStatus(db, a!.id, 'passed_rules');
    setStatus(db, b!.id, 'score_failed', 'err', { scoreAttempts: 2 });
    setStatus(db, c!.id, 'score_failed', 'err', { scoreAttempts: 1 });
    const ids = listJobsForScoring(db, 2, 10).map((j) => j.id).sort();
    expect(ids).toEqual([a!.id, c!.id].sort());
  });

  it('scores round-trip as json', () => {
    const db = testDb();
    insertJobs(db, [makeJob()]);
    const [job] = listJobsByStatus(db, ['discovered']);
    insertScore(db, job!.id, 'm', { ...score, fitScore: 10 });
    insertScore(db, job!.id, 'm', score);
    expect(latestScore(db, job!.id)).toEqual(score);
  });

  it('tracks spend since a date and by day', () => {
    const db = testDb();
    const u = { jobId: null, stage: 'score', provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1 };
    recordUsage(db, { ...u, costUsd: 0.5 }, new Date('2026-10-02T10:00:00Z'));
    recordUsage(db, { ...u, costUsd: 0.25 }, new Date('2026-10-03T10:00:00Z'));
    expect(spendSince(db, new Date('2026-10-03T00:00:00Z'))).toBeCloseTo(0.25);
    expect(spendByDay(db)).toEqual([{ day: '2026-10-03', costUsd: 0.25 }, { day: '2026-10-02', costUsd: 0.5 }]);
  });

  it('companies: upsert is idempotent, deactivate hides', () => {
    const db = testDb();
    upsertCompany(db, { ats: 'lever', token: 'Acme', name: 'Acme', source: 'seed' });
    upsertCompany(db, { ats: 'lever', token: 'acme', name: 'Acme 2', source: 'remoteok' });
    const list = listActiveCompanies(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.token).toBe('acme');
    deactivateCompany(db, list[0]!.id);
    expect(listActiveCompanies(db)).toHaveLength(0);
  });

  it('unnotified awaiting_review jobs', () => {
    const db = testDb();
    insertJobs(db, [makeJob(), makeJob()]);
    const [a, b] = listJobsByStatus(db, ['discovered']);
    setStatus(db, a!.id, 'awaiting_review');
    setStatus(db, b!.id, 'awaiting_review');
    markNotified(db, a!.id);
    expect(listUnnotified(db, 10).map((j) => j.id)).toEqual([b!.id]);
    expect(countByStatus(db)).toEqual([{ status: 'awaiting_review', count: 2 }]);
  });
});
