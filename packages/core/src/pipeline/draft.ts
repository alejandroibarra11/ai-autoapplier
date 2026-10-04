import { join } from 'node:path';
import type { Db } from '../db/client';
import type { Config } from '../config';
import type { Profile } from '../profile';
import type { Answers } from '../answers';
import type { ApplyTarget, FormQuestion } from '../apply/types';
import { COMMON_QUESTIONS } from '../apply/common';
import { type JobRow, insertDraft, listJobsForDrafting, recordUsage, setResolved, setStatus, spendSince } from '../db/repo';
import { costUsd, LLMParseError, type LLMProvider } from '../llm/provider';
import { draftJob } from '../draft/draft';
import { renderCvHtml } from '../cv/render';
import { normalizeKey } from '../text';

export interface DraftStageDeps {
  db: Db; cfg: Config; provider: LLMProvider; profile: Profile; answers: Answers; cvDir: string;
  resolve: (job: JobRow) => Promise<ApplyTarget>;
  questions: (t: ApplyTarget) => Promise<FormQuestion[]>;
  renderPdf: (html: string, outPath: string) => Promise<void>;
  now?: Date; limit?: number;
}
export interface DraftRunResult { drafted: number; failed: number; capped: boolean }

const MAX_CONSECUTIVE_API_ERRORS = 3;

export async function runDrafting(d: DraftStageDeps): Promise<DraftRunResult> {
  const { db, cfg } = d;
  const now = d.now ?? new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const res: DraftRunResult = { drafted: 0, failed: 0, capped: false };
  let apiErrors = 0;

  for (const job of listJobsForDrafting(db, d.limit ?? 5)) {
    if (spendSince(db, dayStart, 'draft') >= cfg.drafting.dailySpendCapUsd) { res.capped = true; break; }
    setStatus(db, job.id, 'drafting', null, {}, now);

    let target: ApplyTarget;
    try { target = await d.resolve(job); } catch { target = { kind: 'manual', url: job.applyUrl }; }
    setResolved(db, job.id, target.url, target.kind);
    let questions: FormQuestion[];
    try { questions = await d.questions(target); } catch { questions = COMMON_QUESTIONS; }

    try {
      const draft = await draftJob({
        provider: d.provider, model: cfg.drafting.model, effort: cfg.drafting.effort,
        profile: d.profile, answers: d.answers, job, questions,
        onUsage: (u) => recordUsage(db, { jobId: job.id, stage: 'draft', ...u, costUsd: costUsd(cfg.pricing, u) }, now),
      });
      const flags = [...draft.flags];
      let cvPdfPath: string | null = join(d.cvDir, `${job.id}-${normalizeKey(job.company).replace(/\s+/g, '-') || 'company'}.pdf`);
      try {
        await d.renderPdf(renderCvHtml(d.profile, d.answers, draft.cvSelection), cvPdfPath);
      } catch (e) {
        console.error(`[draft] CV render failed for job #${job.id}:`, e instanceof Error ? e.message : e);
        cvPdfPath = null;
        flags.push('CV not generated');
      }
      insertDraft(db, { jobId: job.id, model: cfg.drafting.model, coverLetter: draft.coverLetter, answers: draft.answers, questions, cvSelection: draft.cvSelection, cvPdfPath, flags }, now);
      setStatus(db, job.id, 'draft_ready', `${target.kind}${flags.length ? `, ${flags.length} flag(s)` : ''}`, {}, now);
      res.drafted++;
      apiErrors = 0;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      res.failed++;
      if (e instanceof LLMParseError) {
        apiErrors = 0;
        const attempts = job.draftAttempts + 1;
        setStatus(db, job.id, attempts >= cfg.drafting.maxAttempts ? 'draft_failed' : 'shortlisted', msg, { draftAttempts: attempts }, now);
      } else {
        apiErrors++;
        setStatus(db, job.id, 'shortlisted', msg, {}, now);
        if (apiErrors >= MAX_CONSECUTIVE_API_ERRORS) break;
      }
    }
  }
  return res;
}
