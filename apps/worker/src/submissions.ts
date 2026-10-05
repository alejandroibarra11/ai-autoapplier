import { existsSync } from 'node:fs';
import { InlineKeyboard } from 'grammy';
import {
  claimStatus, fillSummary, getJob, isFormRejected, latestDraft, latestSubmission, listUnnotifiedSubmissions, pngSize, STALE_SUBMIT_NOTE, updateSubmission,
  type Config, type Db, type JobRow, type SubmissionRow, type SubmitRunResult,
} from '@autoapplier/core';
import { sendReady, type DraftSender } from './drafts';
import { escapeHtml } from './telegram';

export interface SubmissionSender extends DraftSender {
  sendPhoto(chatId: string, path: string, caption: string, other?: Record<string, unknown>): Promise<unknown>;
}

/** Resolved kinds the fill loop handles: approving these sends the screenshot card instead of the copy-paste message. */
export const AUTO_FILL_KINDS: readonly string[] = ['greenhouse', 'lever', 'ashby'];
type SubmitCfg = { submit: Pick<Config['submit'], 'dryRun'> };
const CAPTION_LIMIT = 1024;
const MAX_FILL_TIME_LISTED = 5;
/** Ashby autosaves form values to the employer while filling (see README). */
export const ASHBY_AUTOSAVE_NOTE = "ℹ️ Ashby saves these values on the employer's side while filling — Cancel doesn't remove them.";
const DRY_RUN_BANNER = '🧪 Dry run is ON — Submit will not send anything';
const DRY_RUN_RESULT = '🧪 Dry run — nothing was sent. Turn off submit.dryRun in config.yaml to submit for real.';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const html = (reply_markup?: InlineKeyboard) => ({ parse_mode: 'HTML' as const, ...(reply_markup ? { reply_markup } : {}) });
/** HTML-escapes `text` and cuts it so the ESCAPED result (incl. the trailing …) is at most `max` chars; never splits an entity. */
export function esc(text: string, max: number): string {
  const full = escapeHtml(text);
  if (full.length <= max) return full;
  let out = '';
  for (const ch of Array.from(text)) {
    const e = escapeHtml(ch);
    if (out.length + e.length > max - 1) break;
    out += e;
  }
  return `${out}…`;
}
const jobName = (job: JobRow) => `${esc(job.title, 150)} — ${esc(job.company, 100)}`;

/**
 * 🚀 Submit / ✋ Cancel. The submit data carries the mode the card was rendered under (`su:<id>:d` dry, `su:<id>:r` real)
 * so a card shown in one mode can never submit in the other.
 */
export function submitKeyboard(jobId: number, dryRun: boolean): InlineKeyboard {
  return new InlineKeyboard().text('🚀 Submit', `su:${jobId}:${dryRun ? 'd' : 'r'}`).text('✋ Cancel', `ca:${jobId}`);
}

export function markAppliedKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard().text('📨 Mark applied', `ma:${jobId}`).text('⏭ Skip', `sd:${jobId}`);
}

function fillCardParts(job: JobRow, sub: SubmissionRow, dryRun: boolean): { head: string[]; details: string[] } {
  const entries = sub.plan.entries;
  const sum = fillSummary(sub.plan, sub.report);
  const counts = [`${sum.filled} filled`, ...(sub.report ? [`${sum.notOnForm.length} not on form`] : []), sum.cvAttached ? 'CV attached' : 'no CV'];
  const head = [`🧾 <b>${jobName(job)}</b>`, `✍️ ${counts.join(' · ')}`];
  if (sum.notOnForm.length) head.push(`Not on this form: ${esc(sum.notOnForm.join(', '), 300)}`);
  if (job.resolvedKind === 'ashby') head.push(escapeHtml(ASHBY_AUTOSAVE_NOTE));
  if (dryRun) head.push(DRY_RUN_BANNER);
  const fillTime = entries.filter((e) => e.source === 'fill_time');
  const details = fillTime.slice(0, MAX_FILL_TIME_LISTED)
    .map((e) => `⚠️ ${esc(e.label, 80)}: ${esc(e.value, 300)}`);
  if (fillTime.length > MAX_FILL_TIME_LISTED) details.push(`…and ${fillTime.length - MAX_FILL_TIME_LISTED} more fill-time answers (dashboard /jobs/${job.id})`);
  return { head, details };
}

/** Screenshot card: job, field counts, fill-time answers (⚠️, escaped, capped), dry-run banner when on. */
export function formatFillCard(job: JobRow, sub: SubmissionRow, dryRun: boolean): string {
  const { head, details } = fillCardParts(job, sub, dryRun);
  return [...head, ...details, `<code>#${job.id} · ${escapeHtml(job.resolvedKind ?? '')}</code>`].join('\n');
}

/** Telegram sendPhoto limits: width + height ≤ 10000 and height/width ≤ 20. False for unreadable files. */
export function photoFits(path: string): boolean {
  try {
    const { width, height } = pngSize(path);
    return width > 0 && height > 0 && width + height <= 10_000 && height / width <= 20;
  } catch {
    return false;
  }
}

/**
 * Sends `caption` with the screenshot (photo when it fits Telegram's limits, else document), falling back to a plain
 * message when there is no screenshot or both uploads fail. Throws only if nothing could be delivered.
 */
async function sendWithShot(sender: SubmissionSender, chatId: string, shot: string | null | undefined, caption: string, kb?: InlineKeyboard): Promise<void> {
  if (shot && existsSync(shot) && caption.length > CAPTION_LIMIT) {
    // Too long for a caption (cutting HTML could break an entity): screenshot first, then the text with the buttons.
    await (photoFits(shot) ? sender.sendPhoto(chatId, shot, '') : sender.sendDocument(chatId, shot, ''))
      .catch((e) => console.error('[telegram] screenshot send failed:', errMsg(e)));
    shot = null;
  }
  if (shot && existsSync(shot)) {
    if (photoFits(shot)) {
      try { await sender.sendPhoto(chatId, shot, caption, html(kb)); return; }
      catch (e) { console.error('[telegram] sendPhoto failed, trying as a document:', errMsg(e)); }
    }
    try { await sender.sendDocument(chatId, shot, caption, html(kb)); return; }
    catch (e) { console.error('[telegram] sendDocument failed, sending text only:', errMsg(e)); }
  }
  await sender.sendMessage(chatId, caption, { ...html(kb), link_preview_options: { is_disabled: true } });
}

/** The fill card with Submit/Cancel; details go in a follow-up message when the caption would pass 1024 chars. */
async function sendFillCard(sender: SubmissionSender, chatId: string, job: JobRow, sub: SubmissionRow, dryRun: boolean, shot: string | null): Promise<void> {
  const full = formatFillCard(job, sub, dryRun);
  if (full.length <= CAPTION_LIMIT) { await sendWithShot(sender, chatId, shot, full, submitKeyboard(job.id, dryRun)); return; }
  const { head, details } = fillCardParts(job, sub, dryRun);
  await sendWithShot(sender, chatId, shot, [...head, '(fill-time answers below)'].join('\n'), submitKeyboard(job.id, dryRun));
  await sender.sendMessage(chatId, details.join('\n'), html()).catch((e) => console.error(`[telegram] fill details failed for job #${job.id}:`, errMsg(e)));
}

/** "Finish manually" with the screenshot, then the phase 2 copy-paste messages (with 📨 Mark applied). */
async function sendManual(sender: SubmissionSender, chatId: string, db: Db, job: JobRow, headline: string, shot: string | null): Promise<void> {
  const draft = latestDraft(db, job.id);
  await sendWithShot(sender, chatId, shot, headline, draft ? undefined : markAppliedKeyboard(job.id));
  // The headline is what counts as delivered: a copy-paste failure must not re-send it next loop.
  if (draft) await sendReady(sender, chatId, job, draft).catch((e) => console.error(`[telegram] copy-paste messages failed for job #${job.id}:`, errMsg(e)));
}

/** submit_failed headline: a form-rejected reason already says nothing was sent; otherwise advise checking email. */
const failedHeadline = (job: JobRow, reason: string) => (isFormRejected(reason)
  ? `⚠️ ${esc(reason, 600)} — ${jobName(job)}`
  : `⚠️ ${esc(reason, 600)} — finish manually (check your email first: it may have been sent) — ${jobName(job)}`);

const staleText = (job: JobRow) =>
  `⚠️ The worker restarted while submitting ${jobName(job)} — check your email; if it went through tap 📨 Mark applied.`;

/** Sends one notification for a submission row; false when the row needs no message (the job moved on). Also used by /pending. */
export async function notifyOne(sender: SubmissionSender, chatId: string, db: Db, cfg: SubmitCfg, job: JobRow, sub: SubmissionRow): Promise<boolean> {
  if ((sub.result === 'filled' || sub.result === 'dry_run') && job.status === 'awaiting_submit') {
    await sendFillCard(sender, chatId, job, sub, cfg.submit.dryRun, sub.submitShot ?? sub.fillShot);
    return true;
  }
  if (sub.result === 'blocked' && job.status === 'needs_manual') {
    await sendManual(sender, chatId, db, job, `⚠️ Finish manually — ${jobName(job)}: ${esc(sub.evidence ?? 'unknown reason', 600)}`, sub.submitShot ?? sub.fillShot);
    return true;
  }
  if (sub.result === 'failed' && job.status === 'submit_failed') {
    if (sub.evidence === STALE_SUBMIT_NOTE) {
      await sender.sendMessage(chatId, staleText(job), { ...html(markAppliedKeyboard(job.id)), link_preview_options: { is_disabled: true } });
    } else {
      await sendManual(sender, chatId, db, job, failedHeadline(job, sub.evidence ?? 'submit failed'), sub.submitShot ?? sub.fillShot);
    }
    return true;
  }
  if (sub.result === 'submitted' && job.status === 'applied') {
    await sendWithShot(sender, chatId, sub.submitShot, `✅ Applied — ${esc(job.company, 200)}`);
    return true;
  }
  return false;
}

/**
 * One Telegram message per unnotified latest submission: the fill card (photo + Submit/Cancel), "finish manually"
 * (+ copy-paste), or the stale-submit warning. Marked notified once the main message is delivered; otherwise retried
 * next loop. Rows whose job moved on (skipped, applied from the dashboard…) are marked without sending.
 */
export async function notifySubmissions(
  sender: SubmissionSender, chatId: string, db: Db, cfg: SubmitCfg, opts: { delay?: (ms: number) => Promise<void>; now?: Date } = {},
): Promise<number> {
  const delay = opts.delay ?? sleep;
  let sent = 0;
  for (const { job, sub } of listUnnotifiedSubmissions(db, 10)) {
    if (sent > 0) await delay(1000);
    let delivered: boolean;
    try {
      delivered = await notifyOne(sender, chatId, db, cfg, job, sub);
    } catch (e) {
      console.error(`[telegram] submission notice failed for job #${job.id}; will retry next loop:`, errMsg(e));
      continue;
    }
    updateSubmission(db, sub.id, { notifiedAt: opts.now ?? new Date() });
    if (delivered) sent++;
  }
  return sent;
}

/** `cardDry`: the mode the card was rendered under; null for cancel and for a legacy `su:<id>` (unknown mode). */
export function parseSubmitCallback(data: string): { action: 'submit' | 'cancel'; jobId: number; cardDry: boolean | null } | null {
  const m = /^(?:su:(\d+)(?::([dr]))?|ca:(\d+))$/.exec(data);
  if (!m) return null;
  if (m[3] !== undefined) return { action: 'cancel', jobId: Number(m[3]), cardDry: null };
  return { action: 'submit', jobId: Number(m[1]), cardDry: m[2] === undefined ? null : m[2] === 'd' };
}

const allowed = (allowedChatId: string, fromChatId: string | number | undefined) =>
  fromChatId !== undefined && allowedChatId !== '' && String(fromChatId) === allowedChatId;

/** ✋ Cancel: only from awaiting_submit (atomic), → needs_manual and the submission `cancelled`. */
export function handleCancel(
  db: Db, allowedChatId: string, fromChatId: string | number | undefined, jobId: number, now = new Date(),
): { ok: boolean; text: string } {
  if (!allowed(allowedChatId, fromChatId)) return { ok: false, text: 'Not allowed' };
  const job = getJob(db, jobId);
  if (!job) return { ok: false, text: 'Job not found' };
  if (job.status !== 'awaiting_submit' || !claimStatus(db, jobId, 'awaiting_submit', 'needs_manual', 'cancelled by user', now)) {
    return { ok: false, text: `Already ${getJob(db, jobId)?.status ?? job.status}` };
  }
  const sub = latestSubmission(db, jobId);
  if (sub) updateSubmission(db, sub.id, { result: 'cancelled', evidence: 'cancelled by user' });
  return { ok: true, text: '✋ Cancelled — nothing was sent' };
}

/** After ✋ Cancel: the phase 2 copy-paste messages for the job (📨 Mark applied / ⏭ Skip), so it can be finished by hand. */
export async function sendReadyAfterCancel(sender: DraftSender, chatId: string, db: Db, jobId: number): Promise<void> {
  const job = getJob(db, jobId);
  const draft = latestDraft(db, jobId);
  if (!job || job.status !== 'needs_manual' || !draft) return;
  await sendReady(sender, chatId, job, draft);
}

export interface SubmitTapResult { ok: boolean; text: string; start?: () => Promise<void> }

/**
 * 🚀 Submit taps: chat gate, status check, and press-once while a submit for the job is queued or running. `start`
 * runs `run(jobId)` (the caller wraps runSubmit in the browser mutex and reports the result); the caller answers the
 * callback and removes the keyboard before starting it. runSubmit's atomic claim is the final guard.
 */
export function createSubmitTaps(db: Db, allowedChatId: string, dryRun: boolean, run: (jobId: number) => Promise<void>) {
  const inFlight = new Set<number>();
  return (fromChatId: string | number | undefined, jobId: number, cardDry: boolean | null): SubmitTapResult => {
    if (!allowed(allowedChatId, fromChatId)) return { ok: false, text: 'Not allowed' };
    const job = getJob(db, jobId);
    if (!job) return { ok: false, text: 'Job not found' };
    if (inFlight.has(jobId)) return { ok: false, text: '⏳ Already submitting' };
    if (job.status !== 'awaiting_submit') return { ok: false, text: `Already ${job.status}` };
    if (cardDry !== dryRun) {
      // The card was shown under another dry-run setting (or its mode is unknown): never submit from it. Re-fill so
      // the fill loop sends a fresh card under the current mode.
      if (!claimStatus(db, jobId, 'awaiting_submit', 'ready_to_apply', 'mode changed: re-fill')) {
        return { ok: false, text: `Already ${getJob(db, jobId)?.status ?? job.status}` };
      }
      return { ok: true, text: 'Mode changed — sending a fresh screenshot' };
    }
    inFlight.add(jobId);
    let started: Promise<void> | null = null;
    return {
      ok: true,
      text: '🚀 Submitting…',
      start: () => {
        started ??= (async () => {
          try { await run(jobId); }
          catch (e) { console.error(`[submit] job #${jobId} failed:`, errMsg(e)); }
          finally { inFlight.delete(jobId); }
        })();
        return started;
      },
    };
  };
}

/** Tells the user what a 🚀 Submit tap did. */
export async function reportSubmitResult(
  sender: SubmissionSender, chatId: string, db: Db, cfg: SubmitCfg, jobId: number, r: SubmitRunResult, now = new Date(),
): Promise<void> {
  const job = getJob(db, jobId);
  if (!job) return;
  if (r.status === 'refused') {
    const stillWaiting = job.status === 'awaiting_submit';
    await sender.sendMessage(chatId, `⛔ ${esc(r.reason, 1000)} — ${jobName(job)}`, html(stillWaiting ? submitKeyboard(jobId, cfg.submit.dryRun) : undefined));
  } else if (r.status === 'applied') {
    await sendWithShot(sender, chatId, r.shot, `✅ Applied — ${esc(job.company, 200)}`);
  } else if (r.status === 'dry_run') {
    await sendWithShot(sender, chatId, r.shot, `${DRY_RUN_RESULT}\n${jobName(job)}`, submitKeyboard(jobId, true));
  } else if (r.status === 'submit_failed') {
    await sendManual(sender, chatId, db, job, failedHeadline(job, r.reason ?? 'submit failed'), r.shot);
  } else {
    await sendManual(sender, chatId, db, job, `⚠️ ${esc(r.reason ?? 'needs manual', 600)} — finish manually — ${jobName(job)}`, r.shot);
  }
  const sub = latestSubmission(db, jobId);
  if (sub && !sub.notifiedAt) updateSubmission(db, sub.id, { notifiedAt: now });
}

/**
 * Runs one submit (the caller wraps runSubmit in the browser mutex) and reports it. If the run throws or the result
 * message can't be delivered, the latest submission's notifiedAt is cleared so notifySubmissions re-sends the right
 * message (fill card, finish manually, applied…) on the next loop.
 */
export async function submitAndReport(a: {
  sender: SubmissionSender; chatId: string | undefined; db: Db; cfg: SubmitCfg; jobId: number; submit: () => Promise<SubmitRunResult>;
}): Promise<void> {
  const clearNotified = () => {
    const sub = latestSubmission(a.db, a.jobId);
    if (sub) updateSubmission(a.db, sub.id, { notifiedAt: null });
  };
  let r: SubmitRunResult;
  try {
    r = await a.submit();
  } catch (e) {
    console.error(`[submit] job #${a.jobId} failed:`, errMsg(e));
    clearNotified();
    return;
  }
  console.log(`[submit] job #${a.jobId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
  if (!a.chatId) { clearNotified(); return; }
  try {
    await reportSubmitResult(a.sender, a.chatId, a.db, a.cfg, a.jobId, r);
  } catch (e) {
    console.error(`[submit] result message failed for job #${a.jobId}; the loop will re-send it:`, errMsg(e));
    clearNotified();
  }
}

/** Approve: sends the copy-paste ready message unless the fill loop will handle the job (it sends the screenshot card). */
export async function sendReadyUnlessAutoFill(sender: DraftSender, chatId: string, db: Db, jobId: number): Promise<'ready' | 'autofill' | 'none'> {
  const job = getJob(db, jobId);
  if (!job) return 'none';
  if (AUTO_FILL_KINDS.includes(job.resolvedKind ?? '')) return 'autofill';
  const d = latestDraft(db, jobId);
  if (!d) return 'none';
  await sendReady(sender, chatId, job, d);
  return 'ready';
}
