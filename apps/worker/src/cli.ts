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
  const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { listJobsByStatus } = await import('@autoapplier/core');
  const hasForce = process.argv.slice(3).includes('--force');
  const n = Number(process.argv.slice(3).find((a) => !a.startsWith('-')) ?? 30);
  const out = join(app.root, 'data/eval/eligibility.jsonl');
  if (existsSync(out) && !hasForce) {
    console.log(`${out} already exists. This would overwrite your labels. Use --force to overwrite.`);
    process.exitCode = 1;
  } else {
    const pool = listJobsByStatus(app.db, ['awaiting_review', 'ineligible', 'low_score', 'shortlisted', 'skipped'], 1000);
    const pick = pool.sort(() => Math.random() - 0.5).slice(0, n);
    mkdirSync(join(app.root, 'data/eval'), { recursive: true });
    writeFileSync(out, pick.map((j) => JSON.stringify({ jobId: j.id, company: j.company, title: j.title, location: j.locationText, url: j.applyUrl, label: null })).join('\n') + '\n');
    console.log(`wrote ${pick.length} rows to ${out}. Set "label" to "eligible" or "ineligible" for each (open the url), then run: pnpm --filter @autoapplier/worker cli eval`);
  }
} else if (cmd === 'eval') {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { getJob, scoreJob, computeEligibilityMetrics, recordUsage, costUsd } = await import('@autoapplier/core');
  const model = process.argv[3] ?? app.cfg.scoring.model;
  const isAnthropic = model.startsWith('claude');
  const providerName = isAnthropic ? 'anthropic' : 'openai';
  const apiKeyVar = isAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = isAnthropic ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(`${apiKeyVar} missing in .env (needed to evaluate ${model})`);
    process.exitCode = 1;
  } else {
    const provider = createProvider(providerName);
    const { parseEvalLabels } = await import('./eval-labels');
    const parsed = parseEvalLabels(readFileSync(join(app.root, 'data/eval/eligibility.jsonl'), 'utf8'));
    for (const bad of parsed.invalid) console.log(`skipping line ${bad.line}: ${bad.reason}`);
    if (parsed.unlabeled) console.log(`${parsed.unlabeled} unlabeled rows ignored`);
    const labeled = parsed.rows;
    const rows = [];
    for (const r of labeled) {
      const job = getJob(app.db, r.jobId);
      if (!job) continue;
      const s = await scoreJob(provider, model, app.profileText, job, (u) =>
        recordUsage(app.db, { jobId: job.id, stage: 'eval', ...u, costUsd: costUsd(app.cfg.pricing, u) }));
      rows.push({ jobId: job.id, label: r.label, predicted: s.eligibility });
    }
    const m = computeEligibilityMetrics(rows);
    console.log(`model=${model} n=${m.n} accuracy=${(m.accuracy * 100).toFixed(1)}%`);
    console.log(`false positives (would waste an application): ${m.falsePositives.join(', ') || 'none'}`);
    console.log(`false negatives (missed eligible jobs): ${m.falseNegatives.join(', ') || 'none'}`);
  }
} else if (cmd === 'draft') {
  const id = Number(process.argv[3]);
  const { getJob, setStatus, runDrafting, resolveApplyTarget, extractQuestions, openBrowser, makePageOpener, renderPdf, latestDraft } = await import('@autoapplier/core');
  const { join } = await import('node:path');
  const { cliDraftRefusal } = await import('./drafts');
  const job = Number.isInteger(id) ? getJob(app.db, id) : null;
  if (!job) { console.log(`job ${process.argv[3]} not found`); process.exitCode = 1; }
  else {
    const refusal = cliDraftRefusal(job.status);
    if (refusal) { console.error(`job ${id} ${refusal}`); process.exitCode = 1; }
    else {
      if (job.status !== 'shortlisted') setStatus(app.db, id, 'shortlisted', 'cli draft');
      let session: Awaited<ReturnType<typeof openBrowser>> | null = null;
      try { session = await openBrowser({ headless: app.cfg.browser.headless, userDataDir: join(app.root, 'data/browser-cli') }); }
      catch (e) { console.warn('browser unavailable, continuing without it:', e instanceof Error ? e.message : e); }
      const opener = session ? makePageOpener(session, app.cfg.browser.timeoutMs) : null;
      try {
        const r = await runDrafting({
          db: app.db, cfg: app.cfg, provider: createProvider(app.cfg.drafting.provider), profile: app.profile, answers: app.answers,
          cvDir: join(app.root, 'data/cv'), onlyJobId: id,
          resolve: (j) => resolveApplyTarget(j, opener), questions: (t) => extractQuestions(t, opener),
          renderPdf: async (html, out) => { if (!session) throw new Error('no browser'); await renderPdf(session, html, out); },
        });
        console.log(r);
        const d = latestDraft(app.db, id);
        if (d) console.log(JSON.stringify({ kind: getJob(app.db, id)?.resolvedKind, flags: d.flags, cv: d.cvPdfPath, coverLetter: d.coverLetter, answers: d.answers }, null, 2));
      } finally { await session?.close().catch(() => {}); }
    }
  }
} else if (cmd === 'fill') {
  // Fills the form for one ready_to_apply job and stops: never submits (there is no `cli submit`).
  const id = Number(process.argv[3]);
  const { getJob, runFill, openBrowser, latestSubmission } = await import('@autoapplier/core');
  const { join } = await import('node:path');
  const { AUTO_FILL_KINDS } = await import('./submissions');
  const job = Number.isInteger(id) ? getJob(app.db, id) : null;
  if (!job) { console.log(`job ${process.argv[3]} not found`); process.exitCode = 1; }
  else if (job.status !== 'ready_to_apply') { console.error(`job ${id} is ${job.status}; cli fill only works for ready_to_apply (approve the draft first)`); process.exitCode = 1; }
  else if (!AUTO_FILL_KINDS.includes(job.resolvedKind ?? '')) { console.error(`job ${id} applies via ${job.resolvedKind ?? 'unknown'}; cli fill supports ${AUTO_FILL_KINDS.join(', ')}`); process.exitCode = 1; }
  else {
    const session = await openBrowser({ headless: app.cfg.browser.headless, userDataDir: join(app.root, 'data/browser-cli') });
    try {
      const r = await runFill({
        db: app.db, cfg: app.cfg, provider: createProvider(app.cfg.drafting.provider), profile: app.profile, answers: app.answers,
        shotsDir: join(app.root, 'data/screenshots'), pages: { newPage: () => session.context.newPage() }, onlyJobId: id,
      });
      console.log(r);
      const sub = latestSubmission(app.db, id);
      console.log(`status: ${getJob(app.db, id)?.status}`);
      if (sub) {
        console.log('plan:');
        for (const e of sub.plan.entries) console.log(`  [${e.source}] ${e.label} (${e.kind}${e.required ? ', required' : ''}): ${e.value.replace(/\s+/g, ' ').slice(0, 120)}`);
        for (const m of sub.plan.missingRequired) console.log(`  [missing] ${m.label}`);
        console.log(`result: ${sub.result}${sub.evidence ? ` — ${sub.evidence}` : ''}`);
        console.log(`screenshot: ${sub.fillShot ?? '(none)'}`);
      }
      console.log('Not submitted. Submit from Telegram (🚀 Submit) or the dashboard.');
    } finally { await session.close().catch(() => {}); }
  }
} else {
  console.log('usage: pnpm --filter @autoapplier/worker cli <once|export-eval [n]|eval [model]|draft <jobId>|fill <jobId>>');
  process.exitCode = 1;
}
