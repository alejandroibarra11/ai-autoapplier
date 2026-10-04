import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { runFill, resetStaleFillSubmit, type FillDeps } from '../src/pipeline/fill';
import { getJob, insertSubmission, latestSubmission, listEvents, setStatus, updateSubmission } from '../src/db/repo';
import type { LLMProvider } from '../src/llm/provider';
import {
  answers, baseCfg, fakePages, fixture, FakeProvider, GH_ANSWERS, GH_QUESTIONS, llmOut, profile, readyJob,
} from './fill-helpers';

let browser: Browser;
const state = { html: '', posted: [] as string[] };
const now = new Date('2026-10-04T12:00:00Z');
const min = (n: number) => new Date(now.getTime() - n * 60_000);
const noLlm: LLMProvider = { name: 'anthropic', generateStructured: async () => { throw new Error('LLM must not be called'); } };

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(() => { state.html = fixture('greenhouse-form.html'); state.posted.length = 0; });

const deps = (r: ReturnType<typeof readyJob>, extra: Partial<FillDeps> = {}): FillDeps =>
  ({ db: r.db, cfg: baseCfg, provider: noLlm, profile, answers, shotsDir: r.shotsDir, pages: fakePages(browser, state), now, ...extra });

describe('runFill', () => {
  it('fills a ready Greenhouse job: awaiting_submit, filled submission with a screenshot, no POST', async () => {
    const r = readyJob({ now });
    const pages = fakePages(browser, state);
    const res = await runFill(deps(r, { pages }));
    expect(res).toEqual({ filled: 1, manual: 0 });
    expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('filled');
    expect(sub.fillShot && existsSync(sub.fillShot)).toBe(true);
    expect(sub.dryRun).toBe(true);
    expect(sub.submittedAt).toBeNull();
    expect(sub.plan.entries.find((e) => e.fieldId === 'question_3')).toMatchObject({ value: 'Because I like it', source: 'draft' });
    expect(state.posted).toEqual([]);
    expect(pages.opened.every((p) => p.isClosed())).toBe(true);
    expect(listEvents(r.db, r.jobId).map((e) => e.toStatus).slice(-2)).toEqual(['filling', 'awaiting_submit']);
  }, 90_000);

  it('answers a missing required question at fill time (source fill_time, usage stage fill)', async () => {
    const r = readyJob({ now, answers: GH_ANSWERS.filter((a) => a.questionId !== 'question_3') });
    const llm = new FakeProvider(llmOut([{ questionId: 'question_3', answer: 'I like the product' }]));
    await runFill(deps(r, { provider: llm }));
    expect(llm.calls).toBe(1);
    expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
    const e = latestSubmission(r.db, r.jobId)!.plan.entries.find((x) => x.fieldId === 'question_3');
    expect(e).toMatchObject({ value: 'I like the product', source: 'fill_time', required: true });
    expect(r.db.$client.prepare("select count(*) n from llm_usage where stage = 'fill'").get()).toEqual({ n: 1 });
  }, 90_000);

  it('a fill-time answer with an unverified claim goes to needs_manual without opening a page', async () => {
    const r = readyJob({ now, answers: GH_ANSWERS.filter((a) => a.questionId !== 'question_3') });
    const llm = new FakeProvider(llmOut([{ questionId: 'question_3', answer: 'I love Haskell' }], ['Haskell']));
    const pages = fakePages(browser, state);
    const res = await runFill(deps(r, { provider: llm, pages }));
    expect(res).toEqual({ filled: 0, manual: 1 });
    expect(getJob(r.db, r.jobId)!.status).toBe('needs_manual');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('blocked');
    expect(sub.evidence).toContain('unverified claim: Haskell');
    expect(pages.opened).toEqual([]);
  }, 90_000);

  it('a planned field the page lacks → needs_manual, blocked with "field not found"', async () => {
    const r = readyJob({
      now,
      questions: [...GH_QUESTIONS, { id: 'question_99', label: 'Extra question', type: 'text', required: true }],
      answers: [...GH_ANSWERS, { questionId: 'question_99', label: 'Extra question', answer: 'x', source: 'generated' }],
    });
    const res = await runFill(deps(r));
    expect(res).toEqual({ filled: 0, manual: 1 });
    expect(getJob(r.db, r.jobId)!.status).toBe('needs_manual');
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub.result).toBe('blocked');
    expect(sub.evidence).toContain('field not found: Extra question');
    expect(sub.fillShot && existsSync(sub.fillShot)).toBe(true);
    expect(state.posted).toEqual([]);
  }, 90_000);

  it('a login wall → needs_manual', async () => {
    const r = readyJob({ now });
    state.html = '<!doctype html><html><head><title>Acme</title></head><body><h1>Sign in to apply</h1><input id="first_name"></body></html>';
    await runFill(deps(r));
    expect(getJob(r.db, r.jobId)!.status).toBe('needs_manual');
    expect(latestSubmission(r.db, r.jobId)!.evidence).toMatch(/login/i);
  }, 90_000);

  it('a resolved URL without an ATS job id → needs_manual', async () => {
    const r = readyJob({ now });
    r.db.$client.prepare('update jobs set resolved_apply_url = ? where id = ?').run('https://job-boards.greenhouse.io/acme', r.jobId);
    await runFill(deps(r));
    expect(getJob(r.db, r.jobId)!.status).toBe('needs_manual');
  }, 30_000);

  it('a page error during fill → needs_manual with the message; the page is closed', async () => {
    const r = readyJob({ now });
    const pages = fakePages(browser, state);
    const broken = { newPage: async () => { const p = await pages.newPage(); p.goto = async () => { throw new Error('net::ERR_BOOM'); }; return p; } };
    await runFill(deps(r, { pages: broken }));
    expect(getJob(r.db, r.jobId)!.status).toBe('needs_manual');
    expect(latestSubmission(r.db, r.jobId)!.evidence).toContain('ERR_BOOM');
    expect(pages.opened.every((p) => p.isClosed())).toBe(true);
  }, 30_000);

  it('onlyJobId fills just that job', async () => {
    const a = readyJob({ now });
    const b = readyJob({ db: a.db, now });
    const res = await runFill(deps(a, { onlyJobId: b.jobId }));
    expect(res.filled).toBe(1);
    expect(getJob(a.db, a.jobId)!.status).toBe('ready_to_apply');
    expect(getJob(a.db, b.jobId)!.status).toBe('awaiting_submit');
  }, 90_000);

  it('skipStaleSweep leaves stale filling/submitting jobs alone (cli fill)', async () => {
    const r = readyJob({ now });
    const s = readyJob({ db: r.db, now });
    const t = readyJob({ db: r.db, now });
    setStatus(r.db, s.jobId, 'submitting', null, {}, min(20));
    setStatus(r.db, t.jobId, 'filling', null, {}, min(20));
    const res = await runFill(deps(r, { onlyJobId: r.jobId, skipStaleSweep: true }));
    expect(res.filled).toBe(1);
    expect(getJob(r.db, s.jobId)!.status).toBe('submitting');
    expect(getJob(r.db, t.jobId)!.status).toBe('filling');
  }, 90_000);

  it('resets a stale filling job and fills it; a stale submitting job becomes submit_failed', async () => {
    const r = readyJob({ now });
    setStatus(r.db, r.jobId, 'filling', null, {}, min(20));
    const s = readyJob({ db: r.db, now });
    const subId = insertSubmission(r.db, { jobId: s.jobId, plan: { entries: [], missingRequired: [], manualReasons: [] }, fillShot: null, result: 'filled' }, min(30));
    updateSubmission(r.db, subId, { dryRun: false, submittedAt: min(20) });
    setStatus(r.db, s.jobId, 'submitting', null, {}, min(20));
    const res = await runFill(deps(r));
    expect(res.filled).toBe(1);
    expect(getJob(r.db, r.jobId)!.status).toBe('awaiting_submit');
    expect(listEvents(r.db, r.jobId).map((e) => e.toStatus)).toContain('ready_to_apply');
    expect(getJob(r.db, s.jobId)!.status).toBe('submit_failed');
    expect(listEvents(r.db, s.jobId).at(-1)!.note).toContain('worker restarted during submit — check your email');
    const sub = latestSubmission(r.db, s.jobId)!;
    expect(sub.result).toBe('failed');
    expect(sub.submittedAt).not.toBeNull(); // a possibly-clicked submission keeps counting against the limits
  }, 90_000);

  it('resetStaleFillSubmit makes the stale submit_failed notifiable again (the fill card was already notified)', () => {
    const r = readyJob({ now });
    const subId = insertSubmission(r.db, { jobId: r.jobId, plan: { entries: [], missingRequired: [], manualReasons: [] }, fillShot: null, result: 'filled' }, min(30));
    updateSubmission(r.db, subId, { notifiedAt: min(29), dryRun: false, submittedAt: min(20) });
    setStatus(r.db, r.jobId, 'submitting', null, {}, min(20));
    resetStaleFillSubmit(r.db, min(15), now);
    const sub = latestSubmission(r.db, r.jobId)!;
    expect(sub).toMatchObject({ result: 'failed', notifiedAt: null });
  });

  it('resetStaleFillSubmit leaves fresh filling/submitting jobs alone', () => {
    const r = readyJob({ now });
    const s = readyJob({ db: r.db, now });
    setStatus(r.db, r.jobId, 'filling', null, {}, min(5));
    setStatus(r.db, s.jobId, 'submitting', null, {}, min(5));
    resetStaleFillSubmit(r.db, min(15), now);
    expect(getJob(r.db, r.jobId)!.status).toBe('filling');
    expect(getJob(r.db, s.jobId)!.status).toBe('submitting');
  });

  it('two concurrent runFill on one job: one claim, one submission row', async () => {
    const r = readyJob({ now });
    const [a, b] = await Promise.all([runFill(deps(r, { onlyJobId: r.jobId })), runFill(deps(r, { onlyJobId: r.jobId }))]);
    expect(a.filled + b.filled).toBe(1);
    expect(a.manual + b.manual).toBe(0);
    expect(r.db.$client.prepare('select count(*) n from submissions where job_id = ?').get(r.jobId)).toEqual({ n: 1 });
    expect(listEvents(r.db, r.jobId).filter((e) => e.toStatus === 'filling')).toHaveLength(1);
  }, 90_000);

  it('runFill skips a job whose claim fails (no submission row)', async () => {
    const r = readyJob({ now });
    const res = await runFill(deps(r, { onlyJobId: r.jobId, hooks: { beforeClaim: () => { setStatus(r.db, r.jobId, 'skipped', null, {}, now); } } }));
    expect(res).toEqual({ filled: 0, manual: 0 });
    expect(getJob(r.db, r.jobId)!.status).toBe('skipped');
    expect(latestSubmission(r.db, r.jobId)).toBeUndefined();
  }, 30_000);
});
