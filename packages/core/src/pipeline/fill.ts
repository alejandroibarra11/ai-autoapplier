import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Db } from '../db/client';
import type { Config } from '../config';
import type { Profile } from '../profile';
import type { Answers } from '../answers';
import type { ApplyTarget, DraftAnswer } from '../apply/types';
import { targetFromUrl } from '../apply/resolve';
import {
  type JobRow, getJob, insertSubmission, latestDraft, latestSubmission, listJobsForFilling, listStaleByStatus, recordUsage, setStatus, updateSubmission,
} from '../db/repo';
import { costUsd, type LLMProvider } from '../llm/provider';
import { draftJob, isBlockingFlag } from '../draft/draft';
import { buildFillPlan } from '../submit/plan';
import { verifyFill } from '../submit/verify';
import { detectCaptchaChallenge, detectLoginWall } from '../submit/detect';
import { takeShot } from '../submit/screenshot';
import { fillerFor } from '../submit/fillers';
import { bodyText } from '../submit/fillers/common';
import type { AtsFiller, FillPlan } from '../submit/types';
import { withTimeout } from './draft';

export interface PageFactory { newPage(): Promise<Page> }
export interface FillDeps {
  db: Db; cfg: Config; provider: LLMProvider; profile: Profile; answers: Answers; shotsDir: string;
  pages: PageFactory; now?: Date; limit?: number; onlyJobId?: number;
}
export interface FillRunResult { filled: number; manual: number }

const STALE_MS = 15 * 60_000;
export const STALE_SUBMIT_NOTE = 'worker restarted during submit — check your email before retrying';
const EMPTY_PLAN: FillPlan = { entries: [], missingRequired: [], manualReasons: [] };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
export const shotPath = (dir: string, jobId: number, kind: string) => join(dir, `${jobId}-${kind}-${Date.now()}.png`);

/** Screenshot that never throws (null when the page is gone or slow). */
export async function safeShot(page: Page | null, path: string): Promise<string | null> {
  if (!page || page.isClosed()) return null;
  try { return await withTimeout(takeShot(page, path), 15_000, 'screenshot'); } catch { return null; }
}

/** Opens the form; null when it loaded, else the reason it cannot be filled. */
export async function openForm(page: Page, url: string): Promise<string | null> {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (res && res.status() >= 400) return `form page returned HTTP ${res.status()}`;
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  const text = `${await page.title().catch(() => '')}\n${await bodyText(page)}`;
  if (detectLoginWall(page.url(), text)) return 'login required to apply';
  if (await detectCaptchaChallenge(page)) return 'captcha challenge on the form page';
  return null;
}

/** The ATS target for a job's resolved apply URL, or null when it lacks the board token / job id the filler needs. */
export function jobTarget(job: Pick<JobRow, 'resolvedApplyUrl' | 'resolvedKind'>): ApplyTarget | null {
  if (!job.resolvedApplyUrl) return null;
  let t: ApplyTarget | null;
  try { t = targetFromUrl(job.resolvedApplyUrl); } catch { return null; }
  if (!t || t.kind !== job.resolvedKind || !t.atsToken || !t.atsJobId) return null;
  return t;
}

/**
 * Stale `filling` → `ready_to_apply` (retried). Stale `submitting` → `submit_failed`, never back to awaiting_submit:
 * the click may have happened. Its submission row keeps `submittedAt` so it still counts against the limits.
 */
export function resetStaleFillSubmit(db: Db, olderThan: Date, now = new Date()): void {
  for (const j of listStaleByStatus(db, 'filling', olderThan)) setStatus(db, j.id, 'ready_to_apply', 'stale filling reset', {}, now);
  for (const j of listStaleByStatus(db, 'submitting', olderThan)) {
    setStatus(db, j.id, 'submit_failed', STALE_SUBMIT_NOTE, {}, now);
    const sub = latestSubmission(db, j.id);
    if (sub && (sub.result === 'filled' || sub.result === 'dry_run')) updateSubmission(db, sub.id, { result: 'failed', evidence: STALE_SUBMIT_NOTE });
  }
}

interface FillCtx { page: Page | null; plan: FillPlan; done: boolean }
type Outcome = { kind: 'filled'; plan: FillPlan; shot: string | null } | { kind: 'manual'; plan: FillPlan; reasons: string[]; shot: string | null };

/** Builds the plan (with fill-time answers) and fills the form. Writes nothing to the job/submission tables. */
async function fillJob(d: FillDeps, job: JobRow, filler: AtsFiller, now: Date, ctx: FillCtx): Promise<Outcome> {
  const manual = (reasons: string[], shot: string | null = null): Outcome => ({ kind: 'manual', plan: ctx.plan, reasons, shot });
  const target = jobTarget(job);
  if (!target) return manual([`cannot build the ${job.resolvedKind} form URL from ${job.resolvedApplyUrl ?? '(none)'}`]);
  const draft = latestDraft(d.db, job.id);
  if (!draft) return manual(['no draft']);

  const input = { questions: draft.questions, answers: d.answers, profile: d.profile };
  let plan = buildFillPlan({ ...input, draft });
  ctx.plan = plan;
  if (plan.missingRequired.length) {
    const ids = new Set(plan.missingRequired.map((m) => m.fieldId));
    const res = await draftJob({
      provider: d.provider, model: d.cfg.drafting.model, effort: d.cfg.drafting.effort,
      profile: d.profile, answers: d.answers, job, questions: draft.questions.filter((q) => ids.has(q.id)),
      onUsage: (u) => recordUsage(d.db, { jobId: job.id, stage: 'fill', ...u, costUsd: costUsd(d.cfg.pricing, u) }, now),
    });
    const extra: DraftAnswer[] = res.answers.filter((a) => ids.has(a.questionId));
    plan = buildFillPlan({ ...input, draft: { ...draft, answers: [...draft.answers.filter((a) => !ids.has(a.questionId)), ...extra] } });
    plan = { ...plan, entries: plan.entries.map((e) => (ids.has(e.fieldId) ? { ...e, source: 'fill_time' as const } : e)) };
    ctx.plan = plan;
    const blocking = res.flags.filter(isBlockingFlag);
    if (blocking.length) return manual(blocking);
  }
  const reasons = [...plan.manualReasons, ...plan.missingRequired.map((m) => `missing answer: ${m.label}`)];
  if (reasons.length) return manual(reasons);

  const page = await d.pages.newPage();
  if (ctx.done) { await page.close().catch(() => {}); throw new Error('fill abandoned'); }
  ctx.page = page;
  const blocked = await openForm(page, filler.formUrl(target));
  if (blocked) return manual([blocked], await safeShot(page, shotPath(d.shotsDir, job.id, 'fill')));
  const report = await filler.fill(page, plan);
  const shot = await safeShot(page, shotPath(d.shotsDir, job.id, 'fill'));
  const mismatches = verifyFill(plan, report);
  if (mismatches.length) return manual(mismatches, shot);
  if (!shot) return manual(['could not take the fill screenshot']);
  return { kind: 'filled', plan, shot };
}

export async function runFill(d: FillDeps): Promise<FillRunResult> {
  const { db } = d;
  const now = d.now ?? new Date();
  resetStaleFillSubmit(db, new Date(now.getTime() - STALE_MS), now);
  const res: FillRunResult = { filled: 0, manual: 0 };
  const queue = d.onlyJobId === undefined
    ? listJobsForFilling(db, d.limit ?? 3)
    : [getJob(db, d.onlyJobId)].filter((j): j is JobRow => !!j && j.status === 'ready_to_apply' && !!fillerFor(j.resolvedKind ?? ''));

  for (const job of queue) {
    const filler = fillerFor(job.resolvedKind ?? '');
    if (!filler) continue;
    setStatus(db, job.id, 'filling', null, {}, now);
    const ctx: FillCtx = { page: null, plan: EMPTY_PLAN, done: false };
    let out: Outcome;
    try {
      out = await withTimeout(fillJob(d, job, filler, now, ctx), d.cfg.submit.fillTimeoutMs, 'fill');
    } catch (e) {
      out = { kind: 'manual', plan: ctx.plan, reasons: [errMsg(e)], shot: await safeShot(ctx.page, shotPath(d.shotsDir, job.id, 'fill')) };
    } finally {
      ctx.done = true; // a timed-out fillJob keeps running in the background: it must not open another page
      await ctx.page?.close().catch(() => {});
    }
    try {
      if (out.kind === 'filled') {
        insertSubmission(db, { jobId: job.id, plan: out.plan, fillShot: out.shot, result: 'filled' }, now);
        setStatus(db, job.id, 'awaiting_submit', `${out.plan.entries.length} fields planned`, {}, now);
        res.filled++;
      } else {
        const evidence = out.reasons.join('; ');
        insertSubmission(db, { jobId: job.id, plan: out.plan, fillShot: out.shot, result: 'blocked', evidence }, now);
        setStatus(db, job.id, 'needs_manual', evidence.slice(0, 500), {}, now);
        res.manual++;
      }
    } catch (e) {
      console.error(`[fill] could not record the result for job #${job.id}:`, errMsg(e));
    }
  }
  return res;
}
