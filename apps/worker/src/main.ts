import { join } from 'node:path';
import cron from 'node-cron';
import { InputFile } from 'grammy';
import {
  createProvider, extractQuestions, getJob, hasDraftWork, latestDraft, makePageOpener, openBrowser, renderPdf as renderPdfWith,
  resolveApplyTarget, runDrafting, type BrowserSession,
} from '@autoapplier/core';
import { createBrowserHolder, createLogThrottle } from './browser-holder';
import { createDraftLoop, createFailureWatch } from './draft-loop';
import { notifyDraftFailures, notifyDrafts, sendReady, type DraftSender } from './drafts';
import { bootstrap } from './bootstrap';
import { createDailyGate, logSummary, runPipelineOnce } from './pipeline';
import { createBot, type MessageSender } from './telegram';
import { superviseBot } from './bot-supervisor';

const app = bootstrap();
const { telegramToken, chatId } = app.env;
if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing in .env');

const bot = createBot(telegramToken, chatId ?? '', app.db, async (jobId) => {
  const job = getJob(app.db, jobId);
  const d = job && latestDraft(app.db, jobId);
  if (job && d && chatId) await sendReady(draftSender, chatId, job, d);
});
const draftSender: DraftSender = {
  sendMessage: (c, t, o) => bot.api.sendMessage(c, t, o as never),
  sendDocument: (c, p, caption) => bot.api.sendDocument(c, new InputFile(p), { caption }),
};
const sender: MessageSender = { sendMessage: (c, t, o) => bot.api.sendMessage(c, t, o as never) };
const provider = createProvider(app.cfg.scoring.provider);

// Notifications only go out while the bot is up; the pipeline keeps running either way.
let telegramUp = false;
let stopping = false;
let running = false;
async function tick() {
  if (running) { console.log('[pipeline] previous run still in progress, skipping'); return; }
  running = true;
  try {
    if (!telegramUp) console.warn('[pipeline] Telegram unavailable: notifications disabled for this run');
    logSummary(await runPipelineOnce({
      db: app.db, cfg: app.cfg, provider, profileText: app.profileText, sender: telegramUp ? sender : undefined, chatId,
    }));
  } catch (e) {
    console.error('[pipeline] run failed', e);
  } finally {
    running = false;
  }
}

const draftProvider = createProvider(app.cfg.drafting.provider);
const draftCapGate = createDailyGate();
const holder = createBrowserHolder(() => openBrowser({ headless: app.cfg.browser.headless, userDataDir: join(app.root, 'data/browser') }));
const throttleLaunchLog = createLogThrottle(60 * 60_000);
const failureWatch = createFailureWatch();
const draftLoop = createDraftLoop({
  run: async () => {
    // Only launch the browser when there is something to draft (stale `drafting` jobs are swept back first).
    const pending = hasDraftWork(app.db);
    const session = pending
      ? await holder.get().catch((e) => { throttleLaunchLog(() => console.error('[draft] browser unavailable:', e instanceof Error ? e.message : e)); return null; })
      : null;
    const opener = session ? makePageOpener(session, app.cfg.browser.timeoutMs) : null;
    const r = await runDrafting({
      db: app.db, cfg: app.cfg, provider: draftProvider, profile: app.profile, answers: app.answers,
      cvDir: join(app.root, 'data/cv'),
      resolve: (job) => resolveApplyTarget(job, opener),
      questions: (t) => extractQuestions(t, opener),
      renderPdf: async (html, out) => { if (!session) throw new Error('no browser'); await renderPdfWith(session, html, out); },
    });
    if (r.drafted || r.failed || r.capped) console.log(`[draft] drafted=${r.drafted} failed=${r.failed} capped=${r.capped}`);
    const keepsFailing = failureWatch(r, new Date());
    if (keepsFailing) console.error(`[draft] ${keepsFailing}`);
    if (telegramUp && chatId) {
      if (keepsFailing) await draftSender.sendMessage(chatId, keepsFailing).catch((e) => console.error('[draft] failing-loop warning failed', e));
      if (r.capped && draftCapGate(new Date())) {
        await draftSender.sendMessage(chatId, `⚠️ Daily drafting spend cap ($${app.cfg.drafting.dailySpendCapUsd}) reached; drafts paused until tomorrow (UTC).`).catch((e) => console.error('[draft] cap warning failed', e));
      }
      await notifyDrafts(draftSender, chatId, app.db);
      await notifyDraftFailures(draftSender, chatId, app.db);
    }
  },
});
setInterval(() => void draftLoop.tick(), app.cfg.drafting.pollSeconds * 1000);

if (!chatId) console.warn('TELEGRAM_CHAT_ID missing: send /start to the bot to get it; notifications disabled until set.');
cron.schedule(`0 */${app.cfg.pollIntervalHours} * * *`, tick);
// First run waits for the first bot start attempt (success or failure) so it can notify if Telegram is up.
// grammY retries network errors inside start() indefinitely, so don't wait more than 15s for it.
let firstRunStarted = false;
const firstRun = () => { if (!firstRunStarted) { firstRunStarted = true; void tick(); } };
setTimeout(firstRun, 15_000).unref();
void superviseBot({
  start: (onStart) => bot.start({ onStart: (me) => { console.log(`[telegram] @${me.username} polling`); onStart(); } }),
  onStateChange: (up) => { telegramUp = up; firstRun(); },
  shouldStop: () => stopping,
}).then((r) => { if (r === 'unauthorized') console.error('[telegram] fix TELEGRAM_BOT_TOKEN in .env and restart to re-enable notifications'); });

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { stopping = true; void bot.stop(); void Promise.race([holder.peek()?.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]).finally(() => process.exit(0)); });
