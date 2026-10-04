import {
  buildSources, listActiveCompanies, runDiscover, runFilter, runScore,
  type Config, type Db, type DiscoverResult, type LLMProvider, type ScoreRunResult,
} from '@autoapplier/core';
import { notifyPending, type MessageSender } from './telegram';

/** Returns true the first time it is called on each UTC day (in-memory). */
export type DailyGate = (now: Date) => boolean;
export function createDailyGate(): DailyGate {
  let lastDay: string | null = null;
  return (now) => {
    const day = now.toISOString().slice(0, 10);
    if (day === lastDay) return false;
    lastDay = day;
    return true;
  };
}
const spendCapWarningGate = createDailyGate();

export interface PipelineCtx {
  db: Db; cfg: Config; provider: LLMProvider; profileText: string; sender?: MessageSender; chatId?: string;
  /** Spend-cap warning limiter; defaults to a process-wide once-per-UTC-day gate. */
  capWarningGate?: DailyGate;
}
export interface PipelineSummary {
  discover: DiscoverResult; filter: { passed: number; rejected: number }; score: ScoreRunResult; notified: number;
}

export async function runPipelineOnce(ctx: PipelineCtx): Promise<PipelineSummary> {
  const { db, cfg } = ctx;
  const sources = buildSources(cfg, listActiveCompanies(db));
  const discover = await runDiscover(db, sources);
  const filter = runFilter(db, cfg);
  const score = await runScore({ db, cfg, provider: ctx.provider, profileText: ctx.profileText });
  let notified = 0;
  if (ctx.sender && ctx.chatId) {
    if (score.capped && (ctx.capWarningGate ?? spendCapWarningGate)(new Date())) {
      try {
        await ctx.sender.sendMessage(ctx.chatId, `⚠️ Daily LLM spend cap ($${cfg.scoring.dailySpendCapUsd}) reached; scoring paused until tomorrow (UTC).`);
      } catch (e) {
        console.error('[pipeline] failed to send spend-cap warning', e);
      }
    }
    notified = await notifyPending(ctx.sender, ctx.chatId, db);
  }
  return { discover, filter, score, notified };
}

export function logSummary(s: PipelineSummary): void {
  console.log(`[pipeline] sources fetched=${s.discover.fetched} new=${s.discover.inserted} skipped=${s.discover.skipped} errors=${s.discover.errors.length}`);
  for (const e of s.discover.errors) console.log(`  ! ${e.source}: ${e.message}`);
  console.log(`[pipeline] rules passed=${s.filter.passed} rejected=${s.filter.rejected}`);
  console.log(`[pipeline] scored=${s.score.scored} failed=${s.score.failed} capped=${s.score.capped} notified=${s.notified}`);
}
