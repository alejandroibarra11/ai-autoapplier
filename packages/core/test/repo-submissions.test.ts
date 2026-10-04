import { describe, it, expect, vi } from 'vitest';
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
  it('stores the fill report (nullable) with the submission', () => {
    const { db, jobs } = seed();
    insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'blocked' });
    expect(latestSubmission(db, jobs[0]!.id)!.report).toBeNull();
    const report = { filled: ['identity:email'], notFound: ['identity:github'], failed: [], requiredEmpty: [] };
    insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: '/a.png', result: 'filled', report });
    expect(latestSubmission(db, jobs[0]!.id)!.report).toEqual(report);
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
  it('only the latest submission per job counts; ordered by job id; limit honoured; one SQL query', () => {
    const { db, jobs } = seed(8);
    const ids = jobs.map((j) => j.id).sort((a, b) => a - b);
    const t = new Date('2026-10-04T12:00:00Z');
    const add = (jobId: number, notified: boolean) => {
      const id = insertSubmission(db, { jobId, plan, fillShot: null, result: 'filled' });
      if (notified) updateSubmission(db, id, { notifiedAt: t });
      return id;
    };
    add(ids[0]!, true);                                   // latest notified → out
    add(ids[1]!, false); add(ids[1]!, true);              // older unnotified, latest notified → out
    add(ids[2]!, true); const c = add(ids[2]!, false);    // latest unnotified → in
    const d = add(ids[3]!, false);                        // in
    // ids[4] has no submission → out
    add(ids[5]!, true); add(ids[5]!, true);               // out
    const g = add(ids[6]!, false);
    const h = add(ids[7]!, false);
    const spy = vi.spyOn(db.$client, 'prepare');
    const rows = listUnnotifiedSubmissions(db, 10);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(rows.map((r) => [r.job.id, r.sub.id])).toEqual([[ids[2], c], [ids[3], d], [ids[6], g], [ids[7], h]]);
    expect(rows[0]!.job).toEqual(listJobsByStatus(db, ['discovered']).find((j) => j.id === ids[2]));
    expect(rows[0]!.sub).toEqual(latestSubmission(db, ids[2]!));
    expect(listUnnotifiedSubmissions(db, 2).map((r) => r.sub.id)).toEqual([c, d]);
  });
});

import { getSubmission } from '../src/db/repo';
describe('getSubmission', () => {
  it('returns a row by id, undefined when missing', () => {
    const { db, jobs } = seed();
    const id = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: '/a.png', result: 'filled' });
    expect(getSubmission(db, id)?.fillShot).toBe('/a.png');
    expect(getSubmission(db, id + 99)).toBeUndefined();
  });
});
