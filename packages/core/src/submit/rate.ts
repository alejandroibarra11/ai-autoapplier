import type { Db } from '../db/client';
import type { Config } from '../config';
import { countRealSubmissionsSince, lastRealSubmissionAt } from '../db/repo';

export function checkSubmitAllowed(db: Db, cfg: Config, now: Date): { ok: true } | { ok: false; reason: string } {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (countRealSubmissionsSince(db, dayStart) >= cfg.submit.dailyLimit) {
    return { ok: false, reason: `Daily submission limit (${cfg.submit.dailyLimit}) reached` };
  }
  const last = lastRealSubmissionAt(db);
  if (last) {
    const wait = Math.ceil(cfg.submit.minSecondsBetween - (now.getTime() - last.getTime()) / 1000);
    if (wait > 0) return { ok: false, reason: `Please wait ${wait}s before the next submission` };
  }
  return { ok: true };
}
