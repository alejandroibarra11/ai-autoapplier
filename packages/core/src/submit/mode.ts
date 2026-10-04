import type { Db } from '../db/client';
import { claimStatus, getJob } from '../db/repo';

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
