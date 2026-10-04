import { Bot, InlineKeyboard } from 'grammy';
import {
  formatComp, getJob, latestScore, listUnnotified, markNotified, setStatus,
  type Db, type JobRow, type ScorePayload,
} from '@autoapplier/core';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatJobCard(job: JobRow, score: ScorePayload): string {
  const comp = formatComp(job) ?? 'pay not listed';
  const lines = [
    `<b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}`,
    `📍 ${escapeHtml(job.locationText || 'not stated')} · 💰 ${escapeHtml(comp)}${job.lowPay ? ' (low)' : ''}`,
    `🎯 Fit ${score.fitScore} · ${score.roleCategory} · ${score.eligibility}`,
    `<i>“${escapeHtml(score.eligibilityEvidence)}”</i>`,
  ];
  if (score.matched.length) lines.push(`✅ ${escapeHtml(score.matched.slice(0, 4).join(', '))}`);
  if (score.missing.length) lines.push(`⚠️ ${escapeHtml(score.missing.slice(0, 3).join(', '))}`);
  if (score.redFlags.length) lines.push(`🚩 ${escapeHtml(score.redFlags.join('; '))}`);
  lines.push(`<code>#${job.id} · ${escapeHtml(job.source)}</code>`);
  return lines.join('\n');
}

export function jobKeyboard(jobId: number, applyUrl: string): InlineKeyboard {
  return new InlineKeyboard().text('👍 Shortlist', `sl:${jobId}`).text('⏭ Skip', `sk:${jobId}`).row().url('🔗 Open posting', applyUrl);
}

export function parseCallback(data: string): { action: 'shortlist' | 'skip'; jobId: number } | null {
  const m = /^(sl|sk):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] === 'sl' ? 'shortlist' : 'skip', jobId: Number(m[2]) };
}

export function handleDecision(
  db: Db, allowedChatId: string, fromChatId: string | number | undefined, data: string, now = new Date(),
): { ok: boolean; text: string; applyUrl?: string } {
  if (fromChatId === undefined || String(fromChatId) !== allowedChatId) return { ok: false, text: 'Not allowed' };
  const parsed = parseCallback(data);
  if (!parsed) return { ok: false, text: 'Unknown action' };
  const job = getJob(db, parsed.jobId);
  if (!job) return { ok: false, text: 'Job not found' };
  if (job.status !== 'awaiting_review') return { ok: false, text: `Already ${job.status}` };
  const to = parsed.action === 'shortlist' ? 'shortlisted' : 'skipped';
  setStatus(db, job.id, to, 'telegram', {}, now);
  return { ok: true, text: to === 'shortlisted' ? '👍 Shortlisted' : '⏭ Skipped', applyUrl: job.applyUrl };
}

export interface MessageSender {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export async function notifyPending(sender: MessageSender, chatId: string, db: Db, limit = 20, now = new Date()): Promise<number> {
  const rows = listUnnotified(db, 500)
    .map((job) => ({ job, score: latestScore(db, job.id) }))
    .filter((r): r is { job: JobRow; score: ScorePayload } => r.score !== undefined)
    .sort((a, b) => b.score.fitScore - a.score.fitScore)
    .slice(0, limit);
  for (const { job, score } of rows) {
    await sender.sendMessage(chatId, formatJobCard(job, score), {
      parse_mode: 'HTML',
      reply_markup: jobKeyboard(job.id, job.applyUrl),
      link_preview_options: { is_disabled: true },
    });
    markNotified(db, job.id, now);
  }
  return rows.length;
}

export function createBot(token: string, chatId: string, db: Db): Bot {
  const bot = new Bot(token);
  bot.command('start', (ctx) => ctx.reply(`Chat id: ${ctx.chat.id}\nPut it in .env as TELEGRAM_CHAT_ID.`));
  bot.on('callback_query:data', async (ctx) => {
    const r = handleDecision(db, chatId, ctx.chat?.id, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: r.text });
    if (r.ok && r.applyUrl) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().url(`${r.text} · 🔗 Open posting`, r.applyUrl) });
    }
  });
  bot.catch((err) => console.error('[telegram]', err.error));
  return bot;
}
