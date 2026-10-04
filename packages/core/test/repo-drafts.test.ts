import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import {
  insertJobs, listJobsByStatus, setStatus, getJob, insertDraft, latestDraft, updateDraftContent,
  markDraftNotified, listUnnotifiedDrafts, listUnnotifiedDraftFailures, markDraftFailureNotified, listJobsForDrafting, setResolved, recordUsage, spendSince,
  type DraftInput,
} from '../src/db/repo';

function seed(n = 1) {
  const db = testDb();
  insertJobs(db, Array.from({ length: n }, () => makeJob()));
  return { db, jobs: listJobsByStatus(db, ['discovered']) };
}
const draft = (jobId: number): DraftInput => ({
  jobId, model: 'claude-opus-5-5', coverLetter: 'Hello', cvPdfPath: null, flags: [],
  answers: [{ questionId: 'q1', label: 'Why?', answer: 'Because', source: 'generated' }],
  questions: [{ id: 'q1', label: 'Why?', type: 'textarea', required: true }],
  cvSelection: { skillsOrder: ['ai'], bulletIds: ['e0-b0'] },
});

describe('drafts repo', () => {
  it('lists only shortlisted jobs for drafting', () => {
    const { db, jobs } = seed(3);
    setStatus(db, jobs[0]!.id, 'shortlisted');
    setStatus(db, jobs[1]!.id, 'awaiting_review');
    expect(listJobsForDrafting(db, 10).map((j) => j.id)).toEqual([jobs[0]!.id]);
  });

  it('stores drafts as json and returns the latest', () => {
    const { db, jobs } = seed();
    const id = jobs[0]!.id;
    insertDraft(db, { ...draft(id), coverLetter: 'old' });
    insertDraft(db, draft(id));
    const d = latestDraft(db, id)!;
    expect(d.coverLetter).toBe('Hello');
    expect(d.answers[0]!.source).toBe('generated');
    expect(d.cvSelection.bulletIds).toEqual(['e0-b0']);
    expect(d.editedByUser).toBe(false);
  });

  it('updates content and marks edited', () => {
    const { db, jobs } = seed();
    const draftId = insertDraft(db, draft(jobs[0]!.id));
    updateDraftContent(db, draftId, { coverLetter: 'Edited', answers: [] });
    const d = latestDraft(db, jobs[0]!.id)!;
    expect(d.coverLetter).toBe('Edited');
    expect(d.editedByUser).toBe(true);
  });

  it('lists unnotified drafts of draft_ready jobs only', () => {
    const { db, jobs } = seed(2);
    const [a, b] = jobs;
    setStatus(db, a!.id, 'draft_ready');
    setStatus(db, b!.id, 'draft_ready');
    const da = insertDraft(db, draft(a!.id));
    insertDraft(db, draft(b!.id));
    markDraftNotified(db, da);
    expect(listUnnotifiedDrafts(db, 10).map((r) => r.job.id)).toEqual([b!.id]);
  });

  it('records resolution and draft attempts', () => {
    const { db, jobs } = seed();
    setResolved(db, jobs[0]!.id, 'https://jobs.lever.co/x/1', 'lever');
    setStatus(db, jobs[0]!.id, 'shortlisted', null, { draftAttempts: 1 });
    const j = getJob(db, jobs[0]!.id)!;
    expect(j.resolvedApplyUrl).toBe('https://jobs.lever.co/x/1');
    expect(j.resolvedKind).toBe('lever');
    expect(j.draftAttempts).toBe(1);
  });

  it('filters spend by stage', () => {
    const { db } = seed();
    const u = { jobId: null, provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1 };
    const now = new Date('2026-10-04T10:00:00Z');
    recordUsage(db, { ...u, stage: 'score', costUsd: 1 }, now);
    recordUsage(db, { ...u, stage: 'draft', costUsd: 0.5 }, now);
    const since = new Date('2026-10-04T00:00:00Z');
    expect(spendSince(db, since)).toBeCloseTo(1.5);
    expect(spendSince(db, since, 'draft')).toBeCloseTo(0.5);
  });
});

describe('draft failure notices', () => {
  it('lists draft_failed jobs once with the failure reason until marked', () => {
    const { db, jobs } = seed(2);
    const [a, b] = [jobs[0]!.id, jobs[1]!.id];
    setStatus(db, a, 'shortlisted');
    setStatus(db, a, 'draft_failed', 'bad json from model');
    setStatus(db, b, 'shortlisted');
    expect(listUnnotifiedDraftFailures(db, 10).map((f) => [f.job.id, f.reason])).toEqual([[a, 'bad json from model']]);
    markDraftFailureNotified(db, a, new Date('2026-10-04T00:00:00Z'));
    expect(getJob(db, a)!.draftFailureNotifiedAt).toEqual(new Date('2026-10-04T00:00:00Z'));
    expect(listUnnotifiedDraftFailures(db, 10)).toEqual([]);
  });
  it('resets the marker when the status patch clears it (regenerate)', () => {
    const { db, jobs } = seed();
    const id = jobs[0]!.id;
    setStatus(db, id, 'draft_failed', 'x');
    markDraftFailureNotified(db, id);
    setStatus(db, id, 'shortlisted', 'dashboard regenerate', { draftAttempts: 0, draftFailureNotifiedAt: null });
    expect(getJob(db, id)!.draftFailureNotifiedAt).toBeNull();
    setStatus(db, id, 'draft_failed', 'again');
    expect(listUnnotifiedDraftFailures(db, 10).map((f) => f.reason)).toEqual(['again']);
  });
});
