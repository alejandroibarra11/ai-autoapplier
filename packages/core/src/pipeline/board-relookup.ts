import type { Db } from '../db/client';
import type { ApplyTarget } from '../apply/types';
import { addJobNote, knownBoardsFor, listJobsForBoardRelookup, markBoardLookup, setResolved } from '../db/repo';
import { lookupCompanyBoard, type FetchLike } from '../apply/board-lookup';
import type { BoardLookup } from '../apply/resolve';

/** Company-board lookup for a job, trying the boards the companies table already knows for that name too. */
export function makeBoardLookup(db: Db, fetchFn: FetchLike, timeoutMs?: number): BoardLookup {
  return (job) => lookupCompanyBoard(job.company, job.title, fetchFn, { known: knownBoardsFor(db, job.company), ...(timeoutMs ? { timeoutMs } : {}) });
}

export interface BoardRelookupDeps { db: Db; lookup: BoardLookup; now?: Date; limit?: number }

/**
 * One-time re-resolve of draft_ready / ready_to_apply jobs stuck on manual/other, using only the company's public ATS
 * board (no browser). A job is marked as tried before the lookup, so it is never retried. On a match the resolved
 * kind/URL change (with a job_events note); the status never does. A ready_to_apply job that becomes
 * greenhouse/lever/ashby is then picked up by the fill loop.
 */
export async function runBoardRelookup(d: BoardRelookupDeps): Promise<{ checked: number; matched: number }> {
  const now = d.now ?? new Date();
  const res = { checked: 0, matched: 0 };
  for (const job of listJobsForBoardRelookup(d.db, d.limit ?? 10)) {
    markBoardLookup(d.db, job.id, now);
    res.checked++;
    let t: ApplyTarget | null = null;
    try { t = await d.lookup(job); } catch (e) {
      console.error(`[board] lookup failed for job #${job.id}:`, e instanceof Error ? e.message : e);
    }
    if (!t || t.kind === 'manual' || t.kind === 'other') continue;
    setResolved(d.db, job.id, t.url, t.kind);
    addJobNote(d.db, job.id, `apply target found on the company's ${t.kind} board (was ${job.resolvedKind}): ${t.url}`, now);
    res.matched++;
  }
  return res;
}
