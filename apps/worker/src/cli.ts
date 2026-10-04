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
} else {
  console.log('usage: pnpm --filter @autoapplier/worker cli <once>');
  process.exitCode = 1;
}
