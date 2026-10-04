import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { checkSubmitAllowed } from '../src/submit/rate';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import { makeJob, testDb } from './helpers';
import { insertJobs, listJobsByStatus, insertSubmission, updateSubmission } from '../src/db/repo';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const plan = { entries: [], missingRequired: [], manualReasons: [] };
function real(db: ReturnType<typeof testDb>, jobId: number, at: Date) {
  const id = insertSubmission(db, { jobId, plan, fillShot: null, result: 'filled' });
  updateSubmission(db, id, { result: 'submitted', dryRun: false, submittedAt: at });
}
describe('checkSubmitAllowed', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('allows when idle', () => { expect(checkSubmitAllowed(testDb(), cfg, now)).toEqual({ ok: true }); });
  it('enforces the minimum gap', () => {
    const db = testDb(); insertJobs(db, [makeJob()]); const [j] = listJobsByStatus(db, ['discovered']);
    real(db, j!.id, new Date(now.getTime() - 30_000));
    expect(checkSubmitAllowed(db, cfg, now)).toEqual({ ok: false, reason: 'Please wait 90s before the next submission' });
  });
  it('enforces the daily limit', () => {
    const db = testDb(); insertJobs(db, [makeJob()]); const [j] = listJobsByStatus(db, ['discovered']);
    for (let i = 0; i < cfg.submit.dailyLimit; i++) real(db, j!.id, new Date(now.getTime() - (i + 3) * 300_000));
    expect(checkSubmitAllowed(db, cfg, now)).toEqual({ ok: false, reason: `Daily submission limit (${cfg.submit.dailyLimit}) reached` });
  });
});
