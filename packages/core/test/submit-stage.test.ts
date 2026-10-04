import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { runFill } from '../src/pipeline/fill';
import { runSubmit, type SubmitDeps } from '../src/pipeline/submit';
import { claimStatus, getJob, insertSubmission, listEvents, latestSubmission, setStatus, updateSubmission } from '../src/db/repo';
import type { Config } from '../src/config';
import type { LLMProvider } from '../src/llm/provider';
import { answers, baseCfg, cfgWith, fakePages, fixture, profile, readyJob } from './fill-helpers';

let browser: Browser;
const state = { html: '', posted: [] as string[] };
const now = new Date('2026-10-04T12:00:00Z');
const noLlm: LLMProvider = { name: 'anthropic', generateStructured: async () => { throw new Error('LLM must not be called'); } };
const live = cfgWith({ dryRun: false });

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(() => { state.html = fixture('greenhouse-form.html'); state.posted.length = 0; });

/** A job filled through runFill (status awaiting_submit, submission filled). */
async function filledJob(r = readyJob({ now })) {
  await runFill({ db: r.db, cfg: baseCfg, provider: noLlm, profile, answers, shotsDir: r.shotsDir, pages: fakePages(browser, state), now });
  expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
  state.posted.length = 0;
  return r;
}
const sdeps = (r: ReturnType<typeof readyJob>, cfg: Config, extra: Partial<SubmitDeps> = {}): SubmitDeps =>
  ({ db: r.db, cfg, profile, answers, shotsDir: r.shotsDir, pages: fakePages(browser, state), now, ...extra });

describe('runSubmit', () => {
  it('dry run: refills and verifies, no POST, back to awaiting_submit, submission dry_run; can be run again', async () => {
    const r = await filledJob();
    const out = await runSubmit(sdeps(r, baseCfg), r.jobId);
    expect(out.status).toBe('dry_run');
    expect(out.status !== 'refused' && out.shot && existsSync(out.shot)).toBe(true);
    expect(state.posted).toEqual([]);
    expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('dry_run');
    expect(sub.dryRun).toBe(true);
    expect(sub.submittedAt).toBeNull();
    expect((await runSubmit(sdeps(r, baseCfg), r.jobId)).status).toBe('dry_run');
  }, 90_000);

  it('real submit: exactly one POST, applied, submission submitted with submittedAt; a second call is refused', async () => {
    const r = await filledJob();
    const out = await runSubmit(sdeps(r, live), r.jobId);
    expect(out).toMatchObject({ status: 'applied' });
    expect(state.posted.length).toBe(1);
    expect(getJob(r.db, r.jobId)!.status).toBe('applied');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('submitted');
    expect(sub.dryRun).toBe(false);
    expect(sub.submittedAt).toEqual(now);
    expect(sub.submitShot && existsSync(sub.submitShot)).toBe(true);

    const again = await runSubmit(sdeps(r, live, { now: new Date(now.getTime() + 3600_000) }), r.jobId);
    expect(again).toEqual({ status: 'refused', reason: 'Not awaiting submit (status applied)' });
    expect(state.posted.length).toBe(1);
  }, 90_000);

  it('two concurrent submits on the same job: exactly one POST, the other refused', async () => {
    const r = await filledJob();
    const [a, b] = await Promise.all([runSubmit(sdeps(r, live), r.jobId), runSubmit(sdeps(r, live), r.jobId)]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'refused']);
    expect(state.posted.length).toBe(1);
  }, 90_000);

  it('rate limit: a real submission 30 s ago → refused with the wait message, no POST, status unchanged', async () => {
    const r = await filledJob();
    const other = readyJob({ db: r.db, now });
    const id = insertSubmission(r.db, { jobId: other.jobId, plan: { entries: [], missingRequired: [], manualReasons: [] }, fillShot: null, result: 'submitted' }, now);
    updateSubmission(r.db, id, { dryRun: false, submittedAt: new Date(now.getTime() - 30_000) });
    const pages = fakePages(browser, state);
    const out = await runSubmit(sdeps(r, live, { pages }), r.jobId);
    expect(out).toEqual({ status: 'refused', reason: 'Please wait 90s before the next submission' });
    expect(pages.opened).toEqual([]);
    expect(state.posted).toEqual([]);
    expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
    expect(latestSubmission(r.db, r.jobId)!.result).toBe('filled');
  }, 90_000);

  it('form changed at submit time (question_3 gone) → needs_manual, no POST', async () => {
    const r = await filledJob();
    state.html = fixture('greenhouse-form.html').replace(/<div><label for="question_3">[\s\S]*?<\/textarea><\/div>/, '');
    expect(state.html).not.toContain('question_3"');
    const out = await runSubmit(sdeps(r, live), r.jobId);
    expect(out.status).toBe('needs_manual');
    expect(out.status !== 'refused' && out.reason).toContain('field not found');
    expect(state.posted).toEqual([]);
    expect(getJob(r.db, r.jobId)!.status).toBe('needs_manual');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('blocked');
    expect(sub.submittedAt).toBeNull();
  }, 90_000);

  it('no confirmation (submit does nothing) with a short timeout → submit_failed, submission failed', async () => {
    const r = await filledJob();
    // a capturing listener swallows the submit event before the fixture's handler (no POST, no confirmation)
    state.html = fixture('greenhouse-form.html').replace('</body>', '<script>document.addEventListener("submit", (e) => { e.preventDefault(); e.stopPropagation(); }, true);</script></body>');
    const out = await runSubmit(sdeps(r, live, { confirmTimeoutMs: 1500 }), r.jobId);
    expect(out.status).toBe('submit_failed');
    expect(state.posted).toEqual([]);
    expect(getJob(r.db, r.jobId)!.status).toBe('submit_failed');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('failed');
    expect(sub.evidence).toContain('unknown');
    expect(sub.submittedAt).not.toBeNull(); // the click happened: it counts against the limits
  }, 90_000);

  it('refuses jobs that are not awaiting_submit or whose latest submission is not a verified fill', async () => {
    const r = readyJob({ now });
    expect(await runSubmit(sdeps(r, live), r.jobId)).toEqual({ status: 'refused', reason: 'Not awaiting submit (status ready_to_apply)' });
    setStatus(r.db, r.jobId, 'awaiting_submit');
    insertSubmission(r.db, { jobId: r.jobId, plan: { entries: [], missingRequired: [], manualReasons: [] }, fillShot: null, result: 'blocked' }, now);
    expect((await runSubmit(sdeps(r, live), r.jobId)).status).toBe('refused');
    expect(await runSubmit(sdeps(r, live), 999_999)).toMatchObject({ status: 'refused' });
    expect(state.posted).toEqual([]);
  }, 30_000);

  it('claimStatus is a conditional transition: only the first of two claims wins', () => {
    const r = readyJob({ now });
    setStatus(r.db, r.jobId, 'awaiting_submit', null, {}, now);
    expect(claimStatus(r.db, r.jobId, 'awaiting_submit', 'submitting', null, now)).toBe(true);
    expect(claimStatus(r.db, r.jobId, 'awaiting_submit', 'submitting', null, now)).toBe(false);
    expect(getJob(r.db, r.jobId)!.status).toBe('submitting');
    expect(listEvents(r.db, r.jobId).filter((e) => e.toStatus === 'submitting')).toHaveLength(1);
  });
});
