import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import { getJob, insertJobs, listJobsByStatus, setStatus } from '../src/db/repo';
import { checkSubmitMode } from '../src/submit/mode';

function seed(status: 'awaiting_submit' | 'needs_manual') {
  const db = testDb();
  insertJobs(db, [makeJob()]);
  const id = listJobsByStatus(db, ['discovered'])[0]!.id;
  setStatus(db, id, status);
  return { db, id };
}

describe('checkSubmitMode', () => {
  it('proceeds without touching the job when the modes match', () => {
    const { db, id } = seed('awaiting_submit');
    expect(checkSubmitMode(db, id, true, true)).toEqual({ proceed: true });
    expect(checkSubmitMode(db, id, false, false)).toEqual({ proceed: true });
    expect(getJob(db, id)!.status).toBe('awaiting_submit');
  });
  it('on mismatch (either way) re-queues the fill and does not proceed', () => {
    for (const [rendered, current] of [[true, false], [false, true]] as const) {
      const { db, id } = seed('awaiting_submit');
      const r = checkSubmitMode(db, id, rendered, current);
      expect(r.proceed).toBe(false);
      expect(getJob(db, id)!.status).toBe('ready_to_apply');
    }
  });
  it('does not proceed or change a job that is not awaiting submit', () => {
    const { db, id } = seed('needs_manual');
    const r = checkSubmitMode(db, id, true, false);
    expect(r).toEqual({ proceed: false, message: expect.stringContaining('needs_manual') });
    expect(getJob(db, id)!.status).toBe('needs_manual');
  });
});
