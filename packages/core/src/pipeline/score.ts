import type { Db } from '../db/client';
import type { Config } from '../config';
import type { LLMProvider } from '../llm/provider';
import { costUsd, LLMParseError } from '../llm/provider';
import { insertScore, listJobsForScoring, recordUsage, setStatus, spendSince } from '../db/repo';
import { decide, scoreJob } from '../score/score';

export interface ScoreRunResult { scored: number; failed: number; capped: boolean }

export async function runScore(d: { db: Db; cfg: Config; provider: LLMProvider; profileText: string; now?: Date }): Promise<ScoreRunResult> {
  const { db, cfg, provider, profileText } = d;
  const now = d.now ?? new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const res: ScoreRunResult = { scored: 0, failed: 0, capped: false };

  let consecutiveApiErrors = 0;

  for (const job of listJobsForScoring(db, cfg.scoring.maxAttempts, cfg.scoring.maxPerRun)) {
    if (spendSince(db, dayStart) >= cfg.scoring.dailySpendCapUsd) { res.capped = true; break; }
    try {
      const score = await scoreJob(provider, cfg.scoring.model, profileText, job, (u) =>
        recordUsage(db, { jobId: job.id, stage: 'score', ...u, costUsd: costUsd(cfg.pricing, u) }, now));
      insertScore(db, job.id, cfg.scoring.model, score, now);
      setStatus(db, job.id, decide(score, cfg.scoring.threshold), `fit ${score.fitScore}, ${score.eligibility}`, {}, now);
      res.scored++;
      consecutiveApiErrors = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const parseFailure = e instanceof LLMParseError;
      setStatus(db, job.id, 'score_failed', msg.slice(0, 500), parseFailure ? { scoreAttempts: job.scoreAttempts + 1 } : {}, now);
      res.failed++;
      consecutiveApiErrors = parseFailure ? 0 : consecutiveApiErrors + 1;
      if (consecutiveApiErrors >= 3) break;
    }
  }
  return res;
}
