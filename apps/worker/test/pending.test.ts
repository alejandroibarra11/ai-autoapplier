import { describe, it, expect } from 'vitest';
import { openDb, insertJobs, listJobsByStatus, setStatus, insertDraft, insertScore } from '@autoapplier/core';
import { resendPending } from '../src/pending';

function job(db: ReturnType<typeof openDb>, n: string, kind: string) {
  insertJobs(db, [{
    source: 'ashby', sourceJobId: n, company: `Co${n}`, title: `T${n}`, locationText: 'Remote', description: 'd',
    applyUrl: `https://x/${n}`, ats: null, atsToken: null, compMin: null, compMax: null, compCurrency: null, compPeriod: null, postedAt: new Date('2026-10-02T00:00:00Z'),
  }]);
  const j = listJobsByStatus(db, ['discovered']).find((x) => x.sourceJobId === n)!;
  db.$client.prepare('update jobs set resolved_kind=? where id=?').run(kind, j.id);
  return j.id;
}
const draft = (db: any, jobId: number, flags: string[] = []) => insertDraft(db, {
  jobId, model: 'm', coverLetter: 'Hi', cvPdfPath: null, flags, questions: [], cvSelection: { skillsOrder: [], bulletIds: [] }, answers: [],
});

describe('resendPending', () => {
  it('re-sends review cards, draft cards and manual copy-paste messages; skips jobs the fill loop owns', async () => {
    const db = openDb(':memory:');
    const r = job(db, '1', 'greenhouse'); setStatus(db, r, 'awaiting_review');
    insertScore(db, r, 'm', { eligibility: 'eligible', eligibilityEvidence: 'x', fitScore: 80, roleCategory: 'voice', matched: [], missing: [], redFlags: [], compEstimate: null } as any);
    const d = job(db, '2', 'other'); setStatus(db, d, 'draft_ready'); draft(db, d, ['unverified claim: Go']);
    const m = job(db, '3', 'manual'); setStatus(db, m, 'ready_to_apply'); draft(db, m);
    const a = job(db, '4', 'greenhouse'); setStatus(db, a, 'ready_to_apply'); draft(db, a);
    const sent: string[] = [];
    const sender = { sendMessage: async (_c: string, t: string) => { sent.push(t); }, sendDocument: async () => {}, sendPhoto: async () => {} };
    const c = await resendPending(sender as any, '42', db, { submit: { dryRun: true } }, { delay: async () => {} });
    expect(c).toEqual({ review: 1, drafts: 1, submit: 0, manual: 1 });
    expect(sent.some((t) => t.includes('Co1'))).toBe(true);
    expect(sent.some((t) => t.includes('Co2'))).toBe(true);
    expect(sent.some((t) => t.includes('https://x/3'))).toBe(true);
    expect(sent.some((t) => t.includes('Co4'))).toBe(false);
    expect(listJobsByStatus(db, ['ready_to_apply']).length).toBe(2); // nothing changed state
  });
});
