import type { Page } from 'playwright';
import type { Db } from '../db/client';
import type { Config } from '../config';
import type { Profile } from '../profile';
import type { Answers } from '../answers';
import { claimStatus, getJob, latestSubmission, setStatus, updateSubmission } from '../db/repo';
import { verifyFill } from '../submit/verify';
import { detectCaptchaChallenge } from '../submit/detect';
import { checkSubmitAllowed } from '../submit/rate';
import { fillerFor } from '../submit/fillers';
import { withTimeout } from './draft';
import { jobTarget, openForm, safeShot, shotPath, type PageFactory } from './fill';

export interface SubmitDeps {
  db: Db; cfg: Config; profile: Profile; answers: Answers; shotsDir: string; pages: PageFactory; now?: Date;
  /** How long to wait for a confirmation after the click (default 30 s). */
  confirmTimeoutMs?: number;
}
export type SubmitRunResult =
  | { status: 'refused'; reason: string }
  | { status: 'dry_run' | 'applied' | 'submit_failed' | 'needs_manual'; reason?: string; shot: string | null };

const DEFAULT_CONFIRM_MS = 30_000;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * The only place a final submit click happens. Re-fills the form from the stored plan, verifies it, and clicks only when
 * dry run is off and the rate limits allow it. The job is claimed atomically (awaiting_submit → submitting) so concurrent
 * taps cannot both proceed; the submission row is marked as a real click (dryRun=false, submittedAt) before the click.
 */
export async function runSubmit(d: SubmitDeps, jobId: number): Promise<SubmitRunResult> {
  const { db, cfg } = d;
  const now = d.now ?? new Date();
  const refuse = (reason: string): SubmitRunResult => ({ status: 'refused', reason });

  const job = getJob(db, jobId);
  if (!job) return refuse(`Job #${jobId} not found`);
  if (job.status !== 'awaiting_submit') return refuse(`Not awaiting submit (status ${job.status})`);
  const sub = latestSubmission(db, jobId);
  // A dry-run result is a verified fill too: the user may tap Submit again (e.g. after turning dry run off).
  if (!sub || (sub.result !== 'filled' && sub.result !== 'dry_run')) return refuse(`No verified fill to submit (latest submission: ${sub?.result ?? 'none'})`);
  const filler = fillerFor(job.resolvedKind ?? '');
  const target = jobTarget(job);
  if (!filler || !target) return refuse(`No form filler for ${job.resolvedKind ?? 'unknown'} (${job.resolvedApplyUrl ?? 'no URL'})`);
  const dryRun = cfg.submit.dryRun;
  if (!dryRun) {
    const allowed = checkSubmitAllowed(db, cfg, now);
    if (!allowed.ok) return refuse(allowed.reason);
  }
  if (!claimStatus(db, jobId, 'awaiting_submit', 'submitting', dryRun ? 'dry run' : null, now)) {
    return refuse(`Not awaiting submit (status ${getJob(db, jobId)?.status ?? 'unknown'})`);
  }

  const plan = sub.plan;
  let page: Page | null = null;
  let clicked = false;
  let shot: string | null = null;
  const end = (status: 'needs_manual' | 'submit_failed', reason: string, s: string | null): SubmitRunResult => {
    updateSubmission(db, sub.id, { result: status === 'needs_manual' ? 'blocked' : 'failed', evidence: reason, submitShot: s });
    setStatus(db, jobId, status, reason.slice(0, 500), {}, now);
    return { status, reason, shot: s };
  };

  try {
    page = await d.pages.newPage();
    const p = page;
    // Only the re-fill is timed: the click below runs only if this resolved in time.
    const problems = await withTimeout((async () => {
      const blocked = await openForm(p, filler.formUrl(target));
      if (blocked) return [blocked];
      return verifyFill(plan, await filler.fill(p, plan));
    })(), cfg.submit.fillTimeoutMs, 'refill');
    shot = await safeShot(page, shotPath(d.shotsDir, jobId, 'presubmit'));
    if (problems.length) return end('needs_manual', problems.join('; '), shot);
    if (await detectCaptchaChallenge(page)) return end('needs_manual', 'captcha challenge before submit', shot);
    if (!shot) return end('needs_manual', 'could not take the pre-submit screenshot', null);

    if (dryRun) {
      updateSubmission(db, sub.id, { result: 'dry_run', evidence: 'dry run — not submitted', submitShot: shot });
      setStatus(db, jobId, 'awaiting_submit', 'dry run — not submitted', {}, now);
      return { status: 'dry_run', shot };
    }

    // Re-check the limits and record the click in one immediate transaction, right before clicking.
    const at = d.now ?? new Date();
    const gate = db.transaction(() => {
      const allowed = checkSubmitAllowed(db, cfg, at);
      if (allowed.ok) updateSubmission(db, sub.id, { dryRun: false, submittedAt: at });
      return allowed;
    }, { behavior: 'immediate' });
    if (!gate.ok) {
      setStatus(db, jobId, 'awaiting_submit', gate.reason, {}, now);
      return refuse(gate.reason);
    }

    clicked = true;
    const confirmMs = d.confirmTimeoutMs ?? DEFAULT_CONFIRM_MS;
    const outcome = await withTimeout(filler.submit(page, confirmMs), confirmMs + 20_000, 'submit');
    const after = (await safeShot(page, shotPath(d.shotsDir, jobId, 'submit'))) ?? shot;
    if (outcome.kind === 'confirmed') {
      updateSubmission(db, sub.id, { result: 'submitted', evidence: outcome.evidence.slice(0, 500), submitShot: after });
      setStatus(db, jobId, 'applied', 'submitted — confirmation seen', {}, now);
      return { status: 'applied', shot: after };
    }
    // Never assume success: captcha, an error, or no confirmation are all failures.
    return end('submit_failed', `${outcome.kind}: ${outcome.evidence}`.slice(0, 500), after);
  } catch (e) {
    const s = (await safeShot(page, shotPath(d.shotsDir, jobId, clicked ? 'submit' : 'presubmit'))) ?? shot;
    return end(clicked ? 'submit_failed' : 'needs_manual', errMsg(e), s);
  } finally {
    await page?.close().catch(() => {});
  }
}
