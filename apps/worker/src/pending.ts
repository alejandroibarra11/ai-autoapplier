import { latestDraft, latestScore, latestSubmission, listJobsByStatus, type Db } from '@autoapplier/core';
import { resendDraftCards, sendReady } from './drafts';
import { AUTO_FILL_KINDS, notifyOne, type SubmissionSender } from './submissions';
import { formatJobCard, jobKeyboard } from './telegram';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface PendingCounts { review: number; drafts: number; submit: number; manual: number }

/**
 * /pending: re-sends every message still waiting on the user, from the database (the chat may have been cleared).
 * Job cards (awaiting_review, best fit first), draft cards (draft_ready), fill cards with Submit/Cancel (awaiting_submit),
 * and finish-manually / copy-paste messages (needs_manual, submit_failed, ready_to_apply on sites the bot can't fill).
 * Nothing changes state: it only sends. A failed send is logged and skipped.
 */
export async function resendPending(
  sender: SubmissionSender, chatId: string, db: Db, cfg: { submit: { dryRun: boolean } }, opts: { delay?: (ms: number) => Promise<void> } = {},
): Promise<PendingCounts> {
  const delay = opts.delay ?? sleep;
  const counts: PendingCounts = { review: 0, drafts: 0, submit: 0, manual: 0 };
  const send = async (what: string, f: () => Promise<unknown>): Promise<boolean> => {
    try { await f(); await delay(1000); return true; } catch (e) { console.error(`[telegram] /pending ${what} failed:`, errMsg(e)); return false; }
  };

  const review = listJobsByStatus(db, ['awaiting_review'], 200)
    .map((job) => ({ job, score: latestScore(db, job.id) }))
    .filter((r) => r.score !== undefined)
    .sort((a, b) => b.score!.fitScore - a.score!.fitScore);
  for (const { job, score } of review) {
    if (await send(`job #${job.id}`, () => sender.sendMessage(chatId, formatJobCard(job, score!), {
      parse_mode: 'HTML', reply_markup: jobKeyboard(job.id, job.applyUrl), link_preview_options: { is_disabled: true },
    }))) counts.review++;
  }

  counts.drafts = await resendDraftCards(sender, chatId, db, { delay });

  for (const job of listJobsByStatus(db, ['awaiting_submit', 'needs_manual', 'submit_failed', 'ready_to_apply'], 200)) {
    const sub = latestSubmission(db, job.id);
    const draft = latestDraft(db, job.id);
    if (job.status === 'ready_to_apply') {
      // Auto-fill sites are being filled by the loop (their card comes on its own); others got the copy-paste messages.
      if (AUTO_FILL_KINDS.includes(job.resolvedKind ?? '') || !draft) continue;
      if (await send(`ready #${job.id}`, () => sendReady(sender, chatId, job, draft))) counts.manual++;
      continue;
    }
    let delivered = false;
    const ok = await send(`submission #${job.id}`, async () => {
      delivered = sub ? await notifyOne(sender, chatId, db, cfg, job, sub) : false;
      // needs_manual without a fill (e.g. cancelled before one existed): the copy-paste messages.
      if (!delivered && job.status !== 'awaiting_submit' && draft) { await sendReady(sender, chatId, job, draft); delivered = true; }
    });
    if (ok && delivered) job.status === 'awaiting_submit' ? counts.submit++ : counts.manual++;
  }
  return counts;
}
