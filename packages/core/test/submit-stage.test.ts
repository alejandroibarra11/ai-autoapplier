import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { runFill } from '../src/pipeline/fill';
import { isFormRejected, runSubmit, type SubmitDeps } from '../src/pipeline/submit';
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

  it('two concurrent submits that both pass the early checks: the atomic claim lets exactly one through (one POST)', async () => {
    const r = await filledJob();
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((res) => { release = res; });
    // both calls wait here, after the early status/limit checks and before claiming, until both have arrived
    const beforeClaim = async () => { if (++arrived === 2) release(); await barrier; };
    const [a, b] = await Promise.all([
      runSubmit(sdeps(r, live, { hooks: { beforeClaim } }), r.jobId),
      runSubmit(sdeps(r, live, { hooks: { beforeClaim } }), r.jobId),
    ]);
    expect(arrived).toBe(2);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['applied', 'refused']);
    expect([a, b].find((x) => x.status === 'refused')).toEqual({ status: 'refused', reason: 'Not awaiting submit (status submitting)' });
    expect(state.posted.length).toBe(1);
  }, 90_000);

  it('dry run then real submit on the same job: the real one re-fills on a new page, verifies, one POST, applied', async () => {
    const r = await filledJob();
    const pages = fakePages(browser, state);
    expect((await runSubmit(sdeps(r, baseCfg, { pages }), r.jobId)).status).toBe('dry_run');
    expect(state.posted).toEqual([]);
    const out = await runSubmit(sdeps(r, live, { pages }), r.jobId);
    expect(out.status).toBe('applied');
    expect(pages.opened).toHaveLength(2);
    expect(pages.opened[0]).not.toBe(pages.opened[1]);
    expect(pages.opened.every((p) => p.isClosed())).toBe(true);
    expect(state.posted.length).toBe(1);
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub).toMatchObject({ result: 'submitted', dryRun: false });
    expect(sub.submittedAt).toEqual(now);
  }, 90_000);

  it('pre-click gate: a real submission recorded after the early check → refused, no POST, back to awaiting_submit', async () => {
    const r = await filledJob();
    const other = readyJob({ db: r.db, now });
    const beforeGate = () => {
      const id = insertSubmission(r.db, { jobId: other.jobId, plan: { entries: [], missingRequired: [], manualReasons: [] }, fillShot: null, result: 'submitted' }, now);
      updateSubmission(r.db, id, { dryRun: false, submittedAt: now });
    };
    const out = await runSubmit(sdeps(r, live, { hooks: { beforeGate } }), r.jobId);
    expect(out).toEqual({ status: 'refused', reason: 'Please wait 120s before the next submission' });
    expect(state.posted).toEqual([]);
    expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.dryRun).toBe(true);
    expect(sub.submittedAt).toBeNull();
  }, 90_000);

  it('an exception after the click attempt started → submit_failed, submission failed, submittedAt kept', async () => {
    const r = await filledJob();
    // submit does nothing, so the filler keeps polling; once past the gate every wait on the page throws
    state.html = fixture('greenhouse-form.html').replace('</body>', '<script>document.addEventListener("submit", (e) => { e.preventDefault(); e.stopPropagation(); }, true);</script></body>');
    const pages = fakePages(browser, state);
    const broken = { newPage: async () => { const p = await pages.newPage(); hooked.page = p; return p; } };
    const hooked: { page: Page | null } = { page: null };
    const beforeGate = () => { hooked.page!.waitForTimeout = async () => { throw new Error('page crashed after click'); }; };
    const out = await runSubmit(sdeps(r, live, { pages: broken, hooks: { beforeGate }, confirmTimeoutMs: 5000 }), r.jobId);
    expect(out).toMatchObject({ status: 'submit_failed', reason: 'page crashed after click' });
    expect(getJob(r.db, r.jobId)!.status).toBe('submit_failed');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('failed');
    expect(sub.dryRun).toBe(false);
    expect(sub.submittedAt).toEqual(now);
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

  it('the form shows a validation error after the click → submit_failed with "the form rejected the submission" wording', async () => {
    const r = await filledJob();
    state.html = fixture('greenhouse-form.html').replace('</body>', '<script>document.addEventListener("submit", (e) => { e.preventDefault(); e.stopPropagation(); document.body.insertAdjacentHTML("afterbegin", \'<div role="alert">Email is required</div>\'); }, true);</script></body>');
    const out = await runSubmit(sdeps(r, live, { confirmTimeoutMs: 5000 }), r.jobId);
    const reason = 'The form rejected the submission: Email is required — nothing was sent; finish manually';
    expect(out).toMatchObject({ status: 'submit_failed', reason });
    expect(isFormRejected(reason)).toBe(true);
    expect(isFormRejected('unknown: no confirmation')).toBe(false);
    expect(getJob(r.db, r.jobId)!.status).toBe('submit_failed');
    expect(latestSubmission(r.db, r.jobId)).toMatchObject({ result: 'failed', evidence: reason });
    expect(latestSubmission(r.db, r.jobId)!.submittedAt).not.toBeNull(); // still counts against the limits
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
