import { join } from 'node:path';
import cron from 'node-cron';
import { InputFile } from 'grammy';
import {
  createProvider, extractQuestions, hasDraftWork, listJobsForFilling, makePageOpener, openBrowser, renderPdf as renderPdfWith,
  resetStaleFillSubmit, resolveApplyTarget, runDrafting, runFill, runSubmit, type PageFactory,
} from '@autoapplier/core';
import { createBrowserHolder, createLogThrottle } from './browser-holder';
import { createDraftLoop, createFailureWatch } from './draft-loop';
import { notifyDraftFailures, notifyDrafts } from './drafts';
import { resendPending } from './pending';
import { createMutex } from './mutex';
import { createSubmitTaps, notifySubmissions, sendReadyAfterCancel, sendReadyUnlessAutoFill, submitAndReport, type SubmissionSender } from './submissions';
import { bootstrap } from './bootstrap';
import { createDailyGate, logSummary, runPipelineOnce } from './pipeline';
import { createBot, type MessageSender } from './telegram';
import { superviseBot } from './bot-supervisor';

const app = bootstrap();
const { telegramToken, chatId } = app.env;
if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing in .env');

// One browser action at a time: the draft/fill loop and 🚀 Submit taps all run under this lock.
const browserLock = createMutex();
const shotsDir = join(app.root, 'data/screenshots');
const holder = createBrowserHolder(() => openBrowser({ headless: app.cfg.browser.headless, userDataDir: join(app.root, 'data/browser') }));
const pages: PageFactory = { newPage: async () => (await holder.get()).context.newPage() };

// The ONLY production path to runSubmit in the worker: the user's chat-gated 🚀 Submit tap.
const submitTap = createSubmitTaps(app.db, chatId ?? '', app.cfg.submit.dryRun, (jobId) => submitAndReport({
  sender: draftSender, chatId, db: app.db, cfg: app.cfg, jobId,
  submit: () => browserLock(() => runSubmit({ db: app.db, cfg: app.cfg, profile: app.profile, answers: app.answers, shotsDir, pages }, jobId)),
}));
const bot = createBot(telegramToken, chatId ?? '', app.db, async (jobId) => {
  if (chatId) await sendReadyUnlessAutoFill(draftSender, chatId, app.db, jobId);
}, {
  submitTap,
  onCancelled: async (jobId) => { if (chatId) await sendReadyAfterCancel(draftSender, chatId, app.db, jobId); },
  pending: async () => {
    const c = await resendPending(draftSender, chatId ?? '', app.db, app.cfg);
    return `✅ Re-sent: ${c.review} new jobs · ${c.drafts} drafts · ${c.submit} ready to submit · ${c.manual} to finish manually`;
  },
});
const draftSender: SubmissionSender = {
  sendMessage: (c, t, o) => bot.api.sendMessage(c, t, o as never),
  sendDocument: (c, p, caption, o) => bot.api.sendDocument(c, new InputFile(p), { caption, ...(o as object) }),
  sendPhoto: (c, p, caption, o) => bot.api.sendPhoto(c, new InputFile(p), { caption, ...(o as object) }),
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
const STALE_FILL_SUBMIT_MS = 15 * 60_000;
const draftCapGate = createDailyGate();
const throttleLaunchLog = createLogThrottle(60 * 60_000);
const failureWatch = createFailureWatch();
const draftLoop = createDraftLoop({
  run: () => browserLock(async () => {
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
    }

    // Fill (never submits): approved Greenhouse/Lever/Ashby jobs → awaiting_submit with a screenshot, or needs_manual.
    try {
      resetStaleFillSubmit(app.db, new Date(Date.now() - STALE_FILL_SUBMIT_MS));
      // Launch the browser first: if it is unavailable the jobs stay ready_to_apply for the next tick.
      const browserUp = listJobsForFilling(app.db, 1).length > 0 && await holder.get().then(() => true, (e) => {
        throttleLaunchLog(() => console.error('[fill] browser unavailable:', e instanceof Error ? e.message : e));
        return false;
      });
      if (browserUp) {
        const f = await runFill({
          db: app.db, cfg: app.cfg, provider: draftProvider, profile: app.profile, answers: app.answers, shotsDir, pages,
        });
        if (f.filled || f.manual) console.log(`[fill] filled=${f.filled} manual=${f.manual}`);
      }
    } catch (e) {
      console.error('[fill] loop error', e);
    }

    if (telegramUp && chatId) {
      await notifyDrafts(draftSender, chatId, app.db);
      await notifyDraftFailures(draftSender, chatId, app.db);
      await notifySubmissions(draftSender, chatId, app.db, app.cfg);
    }
  }),
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
