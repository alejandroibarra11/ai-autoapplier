import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import { getJob, insertJobs, insertSubmission, latestSubmission, listEvents, listJobsByStatus, setStatus } from '../src/db/repo';
import { DASHBOARD_SKIP_FROM, skipFromDashboard } from '../src/submit/mode';
import type { JobStatus } from '../src/types';

const plan = { entries: [], missingRequired: [], manualReasons: [] };
function seed(status: JobStatus, result?: 'filled' | 'dry_run' | 'blocked' | 'failed') {
  const db = testDb();
  insertJobs(db, [makeJob()]);
  const id = listJobsByStatus(db, ['discovered'])[0]!.id;
  setStatus(db, id, status);
  if (result) insertSubmission(db, { jobId: id, plan, fillShot: null, result });
  return { db, id };
}

describe('skipFromDashboard', () => {
  it('offers Skip from review, draft, ready and the phase 3 waiting/failed states', () => {
    expect([...DASHBOARD_SKIP_FROM].sort()).toEqual(['awaiting_review', 'awaiting_submit', 'draft_ready', 'needs_manual', 'ready_to_apply', 'submit_failed'].sort());
  });
  it('awaiting_submit → skipped and the pending submission is cancelled', () => {
    for (const result of ['filled', 'dry_run'] as const) {
      const { db, id } = seed('awaiting_submit', result);
      expect(skipFromDashboard(db, id)).toBe(true);
      expect(getJob(db, id)!.status).toBe('skipped');
      expect(latestSubmission(db, id)).toMatchObject({ result: 'cancelled', evidence: 'skipped by user' });
      expect(listEvents(db, id).at(-1)).toMatchObject({ fromStatus: 'awaiting_submit', toStatus: 'skipped', note: 'dashboard' });
    }
  });
  it('needs_manual / submit_failed → skipped; their submission result is kept', () => {
    for (const [status, result] of [['needs_manual', 'blocked'], ['submit_failed', 'failed']] as const) {
      const { db, id } = seed(status, result);
      expect(skipFromDashboard(db, id)).toBe(true);
      expect(getJob(db, id)!.status).toBe('skipped');
      expect(latestSubmission(db, id)!.result).toBe(result);
    }
  });
  it('refuses other states (submitting, filling, applied…) and changes nothing', () => {
    for (const status of ['submitting', 'filling', 'applied', 'skipped'] as const) {
      const { db, id } = seed(status, 'filled');
      expect(skipFromDashboard(db, id)).toBe(false);
      expect(getJob(db, id)!.status).toBe(status);
      expect(latestSubmission(db, id)!.result).toBe('filled');
    }
  });
});
