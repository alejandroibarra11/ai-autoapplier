import cron from 'node-cron';
import { createProvider } from '@autoapplier/core';
import { bootstrap } from './bootstrap';
import { logSummary, runPipelineOnce } from './pipeline';
import { createBot, type MessageSender } from './telegram';
import { superviseBot } from './bot-supervisor';

const app = bootstrap();
const { telegramToken, chatId } = app.env;
if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing in .env');

const bot = createBot(telegramToken, chatId ?? '', app.db);
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

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { stopping = true; void bot.stop(); process.exit(0); });
