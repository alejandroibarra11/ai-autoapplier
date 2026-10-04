import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import {
  insertJobs, listJobsByStatus, setStatus, setResolved, insertSubmission, latestSubmission, updateSubmission,
  countRealSubmissionsSince, lastRealSubmissionAt, listUnnotifiedSubmissions, listJobsForFilling,
} from '../src/db/repo';
import type { FillPlan } from '../src/submit/types';

const plan: FillPlan = { entries: [{ fieldId: 'identity:email', label: 'Email', kind: 'text', value: 'a@b.c', source: 'identity', required: true }], missingRequired: [], manualReasons: [] };
function seed(n = 1) { const db = testDb(); insertJobs(db, Array.from({ length: n }, () => makeJob())); return { db, jobs: listJobsByStatus(db, ['discovered']) }; }

describe('submissions repo', () => {
  it('lists ready_to_apply jobs on supported ATS only', () => {
    const { db, jobs } = seed(3);
    for (const j of jobs) setStatus(db, j.id, 'ready_to_apply');
    setResolved(db, jobs[0]!.id, 'https://job-boards.greenhouse.io/x/jobs/1', 'greenhouse');
    setResolved(db, jobs[1]!.id, 'https://himalayas.app/x', 'manual');
    setResolved(db, jobs[2]!.id, 'https://jobs.lever.co/x/1', 'lever');
    expect(listJobsForFilling(db, 10).map((j) => j.id).sort()).toEqual([jobs[0]!.id, jobs[2]!.id].sort());
  });
  it('round-trips plan json and returns the latest', () => {
    const { db, jobs } = seed();
    insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: '/a.png', result: 'filled' });
    const id = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: '/b.png', result: 'filled' });
    const s = latestSubmission(db, jobs[0]!.id)!;
    expect(s.id).toBe(id);
    expect(s.plan.entries[0]!.value).toBe('a@b.c');
    expect(s.dryRun).toBe(true);
  });
  it('counts a clicked row (dryRun false, submittedAt set) regardless of result', () => {
    const { db, jobs } = seed();
    const t = new Date('2026-10-04T12:00:00Z');
    const a = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, a, { dryRun: false, submittedAt: t });
    expect(countRealSubmissionsSince(db, new Date('2026-10-04T00:00:00Z'))).toBe(1);
  });
  it('counts only real submissions for rate limits', () => {
    const { db, jobs } = seed();
    const t = new Date('2026-10-04T12:00:00Z');
    const a = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, a, { result: 'dry_run', dryRun: true, submittedAt: t });
    const b = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, b, { result: 'submitted', dryRun: false, submittedAt: t });
    const c = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, c, { result: 'failed', dryRun: false, submittedAt: new Date('2026-10-04T12:05:00Z') });
    expect(countRealSubmissionsSince(db, new Date('2026-10-04T00:00:00Z'))).toBe(2);
    expect(lastRealSubmissionAt(db)?.toISOString()).toBe('2026-10-04T12:05:00.000Z');
  });
  it('lists unnotified latest submissions', () => {
    const { db, jobs } = seed();
    const id = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    expect(listUnnotifiedSubmissions(db, 10).map((r) => r.sub.id)).toEqual([id]);
    updateSubmission(db, id, { notifiedAt: new Date() });
    expect(listUnnotifiedSubmissions(db, 10)).toEqual([]);
  });
});
