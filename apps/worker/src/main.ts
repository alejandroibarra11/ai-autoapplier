import cron from 'node-cron';
import { createProvider } from '@autoapplier/core';
import { bootstrap } from './bootstrap';
import { logSummary, runPipelineOnce } from './pipeline';
import { createBot, type MessageSender } from './telegram';

const app = bootstrap();
const { telegramToken, chatId } = app.env;
if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing in .env');

const bot = createBot(telegramToken, chatId ?? '', app.db);
const sender: MessageSender = { sendMessage: (c, t, o) => bot.api.sendMessage(c, t, o as never) };
const provider = createProvider(app.cfg.scoring.provider);

let running = false;
async function tick() {
  if (running) { console.log('[pipeline] previous run still in progress, skipping'); return; }
  running = true;
  try {
    logSummary(await runPipelineOnce({ db: app.db, cfg: app.cfg, provider, profileText: app.profileText, sender, chatId }));
  } catch (e) {
    console.error('[pipeline] run failed', e);
  } finally {
    running = false;
  }
}

if (!chatId) console.warn('TELEGRAM_CHAT_ID missing: send /start to the bot to get it; notifications disabled until set.');
cron.schedule(`0 */${app.cfg.pollIntervalHours} * * *`, tick);
void bot.start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) });
void tick();

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void bot.stop(); process.exit(0); });
