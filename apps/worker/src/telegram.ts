import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { handleDraftAction } from './drafts';
import { handleCancel, markAppliedKeyboard, parseSubmitCallback, type SubmitTapResult } from './submissions';
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

export interface NotifyOptions { delay?: (ms: number) => Promise<void> }

const CARD_PAUSE_MS = 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryAfterSeconds = (e: unknown): number | null =>
  e instanceof GrammyError && e.error_code === 429 ? e.parameters.retry_after ?? 1 : null;

/**
 * Sends one card per unnotified awaiting_review job, best fit first. Returns the number sent.
 * A 429 is retried once after retry_after; a second 429 leaves the card for the next run and stops.
 * Any other error is logged and the job is marked notified so one bad card cannot block the queue
 * (the job stays awaiting_review and visible in the dashboard).
 */
export async function notifyPending(
  sender: MessageSender, chatId: string, db: Db, limit = 20, now = new Date(), opts: NotifyOptions = {},
): Promise<number> {
  const delay = opts.delay ?? sleep;
  const rows = listUnnotified(db, 500)
    .map((job) => ({ job, score: latestScore(db, job.id) }))
    .filter((r): r is { job: JobRow; score: ScorePayload } => r.score !== undefined)
    .sort((a, b) => b.score.fitScore - a.score.fitScore)
    .slice(0, limit);
  let sent = 0;
  for (const [i, { job, score }] of rows.entries()) {
    if (i > 0) await delay(CARD_PAUSE_MS);
    const send = () => sender.sendMessage(chatId, formatJobCard(job, score), {
      parse_mode: 'HTML',
      reply_markup: jobKeyboard(job.id, job.applyUrl),
      link_preview_options: { is_disabled: true },
    });
    try {
      try {
        await send();
      } catch (e) {
        const wait = retryAfterSeconds(e);
        if (wait === null) throw e;
        await delay(wait * 1000);
        await send();
      }
      sent += 1;
    } catch (e) {
      if (retryAfterSeconds(e) !== null) {
        console.error(`[telegram] still rate limited on job #${job.id}; leaving the rest for the next run`);
        break;
      }
      console.error(`[telegram] failed to send job #${job.id}; marking notified (still awaiting_review in dashboard):`, e instanceof Error ? e.message : e);
    }
    markNotified(db, job.id, now);
  }
  return sent;
}

export interface BotOptions {
  /** 🚀 Submit tap handler (see createSubmitTaps). Without it Submit taps are refused. */
  submitTap?: (fromChatId: string | number | undefined, jobId: number, cardDry: boolean | null) => SubmitTapResult;
}

export function createBot(token: string, chatId: string, db: Db, onReady?: (jobId: number) => Promise<void>, opts: BotOptions = {}): Bot {
  const bot = new Bot(token);
  bot.command('start', (ctx) => ctx.reply(`Chat id: ${ctx.chat.id}\nPut it in .env as TELEGRAM_CHAT_ID.`));
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const sc = parseSubmitCallback(data);
    if (sc?.action === 'cancel') {
      const r = handleCancel(db, chatId, ctx.chat?.id, sc.jobId);
      await ctx.answerCallbackQuery({ text: r.text });
      if (r.ok) await ctx.editMessageReplyMarkup({ reply_markup: markAppliedKeyboard(sc.jobId) }).catch(() => {});
      return;
    }
    if (sc?.action === 'submit') {
      const r = opts.submitTap ? opts.submitTap(ctx.chat?.id, sc.jobId, sc.cardDry) : { ok: false, text: 'Submitting is not available' };
      // Answer first (Telegram expects it quickly), drop the buttons (press-once), then queue the submit behind the
      // browser mutex without blocking the bot's update loop; the result arrives as a new message.
      await ctx.answerCallbackQuery({ text: r.text }).catch(() => {});
      if (!r.ok) return;
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      // No start = the card's dry-run mode is stale: the job went back to ready_to_apply and the fill loop re-fills it.
      if (r.start) void r.start();
      return;
    }
    if (/^(ap|sd|ma):/.test(data)) {
      const r = handleDraftAction(db, chatId, ctx.chat?.id, data);
      await ctx.answerCallbackQuery({ text: r.text });
      if (r.ok) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      if (r.ok && r.next === 'ready' && r.jobId !== undefined && onReady) await onReady(r.jobId).catch((e) => console.error('[telegram] ready message failed', e));
      return;
    }
    const r = handleDecision(db, chatId, ctx.chat?.id, data);
    await ctx.answerCallbackQuery({ text: r.ok && r.text.startsWith('👍') ? '👍 Shortlisted — drafting…' : r.text });
    if (r.ok && r.applyUrl) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().url(`${r.text} · 🔗 Open posting`, r.applyUrl) });
    }
  });
  bot.catch((err) => console.error('[telegram]', err.error));
  return bot;
}
