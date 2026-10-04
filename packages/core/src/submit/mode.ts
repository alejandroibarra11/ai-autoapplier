import type { Db } from '../db/client';
import { claimStatus, getJob, latestSubmission, updateSubmission } from '../db/repo';
import type { JobStatus } from '../types';

/**
 * Dashboard Submit mode check (same rule as the Telegram buttons): the page was rendered under `renderedDry`; if the
 * current config differs, never submit — re-queue the fill (awaiting_submit → ready_to_apply) so a fresh screenshot is made.
 */
export function checkSubmitMode(db: Db, jobId: number, renderedDry: boolean, currentDry: boolean): { proceed: true } | { proceed: false; message: string } {
  const job = getJob(db, jobId);
  if (!job) return { proceed: false, message: 'Job not found' };
  if (job.status !== 'awaiting_submit') return { proceed: false, message: `Already ${job.status}` };
  if (renderedDry === currentDry) return { proceed: true };
  if (!claimStatus(db, jobId, 'awaiting_submit', 'ready_to_apply', 'mode changed: re-fill')) {
    return { proceed: false, message: `Already ${getJob(db, jobId)?.status ?? job.status}` };
  }
  return { proceed: false, message: 'Dry-run mode changed since this page was shown — nothing was submitted. The worker will re-fill and send a fresh screenshot; reload in a minute.' };
}

/** Parses the hidden renderedDry form field: '1' → dry, '0' → real, anything else (missing/forged) → null (refuse). */
export function parseRenderedDry(v: unknown): boolean | null {
  return v === '1' ? true : v === '0' ? false : null;
}

/** States the dashboard ⏭ Skip button is offered (and accepted) from. */
export const DASHBOARD_SKIP_FROM: readonly JobStatus[] = ['awaiting_review', 'draft_ready', 'ready_to_apply', 'awaiting_submit', 'needs_manual', 'submit_failed'];

/**
 * Dashboard ⏭ Skip: atomic move to `skipped` from the state the job is in (a concurrent claim, e.g. a 🚀 Submit taking
 * awaiting_submit → submitting, wins and nothing changes). Skipping a job awaiting submit cancels its pending submission.
 */
export function skipFromDashboard(db: Db, jobId: number, now = new Date()): boolean {
  const job = getJob(db, jobId);
  if (!job || !DASHBOARD_SKIP_FROM.includes(job.status)) return false;
  if (!claimStatus(db, jobId, job.status, 'skipped', 'dashboard', now)) return false;
  if (job.status === 'awaiting_submit') {
    const sub = latestSubmission(db, jobId);
    if (sub && (sub.result === 'filled' || sub.result === 'dry_run')) updateSubmission(db, sub.id, { result: 'cancelled', evidence: 'skipped by user' });
  }
  return true;
}
