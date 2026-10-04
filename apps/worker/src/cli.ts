import { Bot } from 'grammy';
import { createProvider } from '@autoapplier/core';
import { bootstrap } from './bootstrap';
import { logSummary, runPipelineOnce } from './pipeline';
import type { MessageSender } from './telegram';

const [cmd] = process.argv.slice(2);
const app = bootstrap();

if (cmd === 'once') {
  const sender: MessageSender | undefined = app.env.telegramToken
    ? (() => { const api = new Bot(app.env.telegramToken!).api; return { sendMessage: (c, t, o) => api.sendMessage(c, t, o as never) }; })()
    : undefined;
  const summary = await runPipelineOnce({
    db: app.db, cfg: app.cfg, provider: createProvider(app.cfg.scoring.provider), profileText: app.profileText,
    sender, chatId: app.env.chatId,
  });
  logSummary(summary);
} else if (cmd === 'export-eval') {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { listJobsByStatus } = await import('@autoapplier/core');
  const n = Number(process.argv[3] ?? 30);
  const pool = listJobsByStatus(app.db, ['awaiting_review', 'ineligible', 'low_score', 'shortlisted', 'skipped'], 1000);
  const pick = pool.sort(() => Math.random() - 0.5).slice(0, n);
  mkdirSync(join(app.root, 'data/eval'), { recursive: true });
  const out = join(app.root, 'data/eval/eligibility.jsonl');
  writeFileSync(out, pick.map((j) => JSON.stringify({ jobId: j.id, company: j.company, title: j.title, location: j.locationText, url: j.applyUrl, label: null })).join('\n') + '\n');
  console.log(`wrote ${pick.length} rows to ${out}. Set "label" to "eligible" or "ineligible" for each (open the url), then run: pnpm --filter @autoapplier/worker cli eval`);
} else if (cmd === 'eval') {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { getJob, scoreJob, computeEligibilityMetrics, recordUsage, costUsd } = await import('@autoapplier/core');
  const model = process.argv[3] ?? app.cfg.scoring.model;
  const provider = createProvider(model.startsWith('claude') ? 'anthropic' : 'openai');
  const lines = readFileSync(join(app.root, 'data/eval/eligibility.jsonl'), 'utf8').split('\n').filter(Boolean);
  const labeled = lines.map((l) => JSON.parse(l) as { jobId: number; label: 'eligible' | 'ineligible' | null }).filter((r) => r.label);
  const rows = [];
  for (const r of labeled) {
    const job = getJob(app.db, r.jobId);
    if (!job) continue;
    const s = await scoreJob(provider, model, app.profileText, job, (u) =>
      recordUsage(app.db, { jobId: job.id, stage: 'eval', ...u, costUsd: costUsd(app.cfg.pricing, u) }));
    rows.push({ jobId: job.id, label: r.label!, predicted: s.eligibility });
  }
  const m = computeEligibilityMetrics(rows);
  console.log(`model=${model} n=${m.n} accuracy=${(m.accuracy * 100).toFixed(1)}%`);
  console.log(`false positives (would waste an application): ${m.falsePositives.join(', ') || 'none'}`);
  console.log(`false negatives (missed eligible jobs): ${m.falseNegatives.join(', ') || 'none'}`);
} else {
  console.log('usage: pnpm --filter @autoapplier/worker cli <once|export-eval [n]|eval [model]>');
  process.exitCode = 1;
}
