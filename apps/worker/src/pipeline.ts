import {
  buildSources, listActiveCompanies, runDiscover, runFilter, runScore,
  type Config, type Db, type DiscoverResult, type LLMProvider, type ScoreRunResult,
} from '@autoapplier/core';
import { notifyPending, type MessageSender } from './telegram';

export interface PipelineCtx { db: Db; cfg: Config; provider: LLMProvider; profileText: string; sender?: MessageSender; chatId?: string }
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
    if (score.capped) await ctx.sender.sendMessage(ctx.chatId, `⚠️ Daily LLM spend cap ($${cfg.scoring.dailySpendCapUsd}) reached; scoring paused until tomorrow (UTC).`);
    notified = await notifyPending(ctx.sender, ctx.chatId, db);
  }
  return { discover, filter, score, notified };
}

export function logSummary(s: PipelineSummary): void {
  console.log(`[pipeline] sources fetched=${s.discover.fetched} new=${s.discover.inserted} errors=${s.discover.errors.length}`);
  for (const e of s.discover.errors) console.log(`  ! ${e.source}: ${e.message}`);
  console.log(`[pipeline] rules passed=${s.filter.passed} rejected=${s.filter.rejected}`);
  console.log(`[pipeline] scored=${s.score.scored} failed=${s.score.failed} capped=${s.score.capped} notified=${s.notified}`);
}
