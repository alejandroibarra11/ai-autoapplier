import { join } from 'node:path';
import type { Db } from '../db/client';
import type { Config } from '../config';
import type { Profile } from '../profile';
import type { Answers } from '../answers';
import type { ApplyTarget, FormQuestion } from '../apply/types';
import { COMMON_QUESTIONS } from '../apply/common';
import { type JobRow, insertDraft, getJob, listJobsForDrafting, recordUsage, resetStaleDrafting, setResolved, setStatus, spendSince } from '../db/repo';
import { costUsd, LLMParseError, type LLMProvider } from '../llm/provider';
import { draftJob } from '../draft/draft';
import { renderCvHtml } from '../cv/render';
import { normalizeKey } from '../text';

export interface DraftStageDeps {
  db: Db; cfg: Config; provider: LLMProvider; profile: Profile; answers: Answers; cvDir: string;
  resolve: (job: JobRow) => Promise<ApplyTarget>;
  questions: (t: ApplyTarget) => Promise<FormQuestion[]>;
  renderPdf: (html: string, outPath: string) => Promise<void>;
  now?: Date; limit?: number; onlyJobId?: number; stepTimeoutMs?: number; save?: typeof insertDraft;
}
export interface DraftRunResult { drafted: number; failed: number; capped: boolean; lastError?: string }

const MAX_CONSECUTIVE_API_ERRORS = 3;
const STALE_DRAFTING_MS = 15 * 60_000;

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function runDrafting(d: DraftStageDeps): Promise<DraftRunResult> {
  const { db, cfg } = d;
  const now = d.now ?? new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const res: DraftRunResult = { drafted: 0, failed: 0, capped: false };
  let apiErrors = 0;
  const stepMs = d.stepTimeoutMs ?? 90_000;
  const save = d.save ?? insertDraft;
  resetStaleDrafting(db, new Date(now.getTime() - STALE_DRAFTING_MS), now);

  const queue = d.onlyJobId === undefined
    ? listJobsForDrafting(db, d.limit ?? 5)
    : [getJob(db, d.onlyJobId)].filter((j): j is JobRow => !!j && j.status === 'shortlisted');
  for (const job of queue) {
    if (spendSince(db, dayStart, 'draft') >= cfg.drafting.dailySpendCapUsd) { res.capped = true; break; }
    setStatus(db, job.id, 'drafting', null, {}, now);

    try {
      let target: ApplyTarget;
      try { target = await withTimeout(d.resolve(job), stepMs, 'resolve'); } catch { target = { kind: 'manual', url: job.applyUrl }; }
      setResolved(db, job.id, target.url, target.kind);
      let questions: FormQuestion[];
      try { questions = await withTimeout(d.questions(target), stepMs, 'questions'); } catch { questions = COMMON_QUESTIONS; }

      const draft = await draftJob({
        provider: d.provider, model: cfg.drafting.model, effort: cfg.drafting.effort,
        profile: d.profile, answers: d.answers, job, questions,
        onUsage: (u) => recordUsage(db, { jobId: job.id, stage: 'draft', ...u, costUsd: costUsd(cfg.pricing, u) }, now),
      });
      try {
        const flags = [...draft.flags];
        let cvPdfPath: string | null = join(d.cvDir, `${job.id}-${normalizeKey(job.company).replace(/\s+/g, '-') || 'company'}.pdf`);
        try {
          await withTimeout(d.renderPdf(renderCvHtml(d.profile, d.answers, draft.cvSelection), cvPdfPath), stepMs, 'renderPdf');
        } catch (e) {
          console.error(`[draft] CV render failed for job #${job.id}:`, e instanceof Error ? e.message : e);
          cvPdfPath = null;
          flags.push('CV not generated');
        }
        save(db, { jobId: job.id, model: cfg.drafting.model, coverLetter: draft.coverLetter, answers: draft.answers, questions, cvSelection: draft.cvSelection, cvPdfPath, flags }, now);
        setStatus(db, job.id, 'draft_ready', `${target.kind}${flags.length ? `, ${flags.length} flag(s)` : ''}`, {}, now);
        res.drafted++;
        apiErrors = 0;
      } catch (e) {
        // save failed after a billed draft: count it as an attempt so it cannot be re-billed forever
        throw new LLMParseError(`save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      res.failed++;
      res.lastError = msg;
      try {
        if (e instanceof LLMParseError) {
          apiErrors = 0;
          const attempts = job.draftAttempts + 1;
          const failed = attempts >= cfg.drafting.maxAttempts;
          // Entering draft_failed re-arms the one-time Telegram failure notice.
          setStatus(db, job.id, failed ? 'draft_failed' : 'shortlisted', msg, { draftAttempts: attempts, ...(failed ? { draftFailureNotifiedAt: null } : {}) }, now);
        } else {
          apiErrors++;
          setStatus(db, job.id, 'shortlisted', msg, {}, now);
        }
      } catch (e2) {
        console.error(`[draft] could not record failure for job #${job.id}:`, e2 instanceof Error ? e2.message : e2);
      }
      if (!(e instanceof LLMParseError) && apiErrors >= MAX_CONSECUTIVE_API_ERRORS) break;
    }
  }
  return res;
}
