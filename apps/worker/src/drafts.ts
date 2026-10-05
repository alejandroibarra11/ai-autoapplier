import { InlineKeyboard } from 'grammy';
import {
  getJob, isBlockingFlag, latestDraft, listJobsByStatus, listUnnotifiedDraftFailures, listUnnotifiedDrafts, markDraftFailureNotified, markDraftNotified, setStatus,
  type Db, type DraftRow, type JobRow, type JobStatus,
} from '@autoapplier/core';
import { escapeHtml, type MessageSender } from './telegram';

export interface DraftSender extends MessageSender {
  sendDocument(chatId: string, path: string, caption: string, other?: Record<string, unknown>): Promise<unknown>;
}

const LIMIT = 4000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export function formatDraftCard(job: JobRow, draft: DraftRow): string {
  const fixed = draft.answers.filter((a) => a.source === 'answers').length;
  const gen = draft.answers.length - fixed;
  const lines = [
    `📝 <b>${escapeHtml(truncate(job.title, 200))}</b> — ${escapeHtml(truncate(job.company, 200))}`,
    `<i>${escapeHtml(truncate(draft.coverLetter, 400))}</i>`,
    `🧾 ${fixed} fixed · ${gen} generated answers · apply via ${escapeHtml(truncate(job.resolvedKind ?? 'manual', 50))}`,
  ];
  if (draft.flags.length) lines.push(`⚠️ ${escapeHtml(truncate(draft.flags.join('; '), 600))}`);
  lines.push(`✏️ Edit: <code>pnpm web</code> → /jobs/${job.id}`);
  return lines.join('\n');
}

export function draftKeyboard(jobId: number, blocked: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(blocked ? '⚠️ Approve anyway' : '✅ Approve', `${blocked ? 'aa' : 'ap'}:${jobId}`);
  return kb.text('⏭ Skip', `sd:${jobId}`);
}

/** After ⚠️ Approve anyway: a second tap confirms (ao:), ↩ restores the card's buttons (ab:). */
export function confirmOverrideKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard().text('✅ Yes, approve with warnings', `ao:${jobId}`).text('↩ Back', `ab:${jobId}`);
}

const ESC_BUDGET = 3500;

/** Split raw text into pieces whose escaped length is <= budget, preferring whitespace boundaries. */
function splitByEscaped(text: string, budget = ESC_BUDGET): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let len = 0;
    let j = i;
    let lastWs = -1;
    while (j < chars.length) {
      const w = escapeHtml(chars[j]!).length;
      if (len + w > budget) break;
      len += w;
      if (/\s/.test(chars[j]!)) lastWs = j;
      j++;
    }
    if (j < chars.length && lastWs > i) j = lastWs + 1;
    out.push(chars.slice(i, j).join(''));
    i = j;
  }
  return out.length ? out : [''];
}

function pieceBlocks(label: string, text: string, tag: 'pre' | 'code'): string[] {
  const l = escapeHtml(truncate(label, 200));
  return splitByEscaped(text).map((p, i) =>
    `<b>${l}${i > 0 ? ' (cont.)' : ''}</b>\n<${tag}>${escapeHtml(p)}</${tag}>`);
}

/** Telegram's copy_text button holds at most 256 characters. */
const COPY_MAX = 256;
export interface ReadyItem { text: string; copy?: string }

/**
 * The copy-paste messages: the link, then one message per answer and the cover letter, each in a <pre> block (Telegram
 * shows a Copy control on code blocks). Answers short enough also get a 📋 Copy button. Long texts split into (cont.) pieces.
 */
export function formatReadyItems(job: JobRow, draft: DraftRow): ReadyItem[] {
  const url = job.resolvedApplyUrl ?? job.applyUrl;
  const copyOf = (t: string) => (Array.from(t).length <= COPY_MAX && t.trim() ? t : undefined);
  const piece = (label: string, text: string): ReadyItem[] => {
    const blocks = pieceBlocks(label, text, 'pre');
    const copy = blocks.length === 1 ? copyOf(text) : undefined;
    return blocks.map((b) => (copy ? { text: b, copy } : { text: b }));
  };
  const head = `🚀 <b>Ready to apply:</b> ${escapeHtml(truncate(job.title, 200))} — ${escapeHtml(truncate(job.company, 200))}\n${escapeHtml(truncate(url, 1000))}`;
  const link = copyOf(url);
  return [
    link ? { text: head, copy: link } : { text: head },
    ...draft.answers.flatMap((a) => piece(a.label, a.answer)),
    ...piece('Cover letter', draft.coverLetter),
  ];
}

export function formatReadyMessages(job: JobRow, draft: DraftRow): string[] {
  return formatReadyItems(job, draft).map((i) => i.text);
}

const DRAFT_ACTIONS = { ap: 'approve', ao: 'override', sd: 'skip', ma: 'applied' } as const;

export function parseDraftCallback(data: string): { action: (typeof DRAFT_ACTIONS)[keyof typeof DRAFT_ACTIONS]; jobId: number } | null {
  const m = /^(ap|ao|sd|ma):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: DRAFT_ACTIONS[m[1] as keyof typeof DRAFT_ACTIONS], jobId: Number(m[2]) };
}

/** Mark applied: after the copy-paste flow, or after a fill/submit the user finished by hand. */
const MARKABLE_APPLIED: readonly JobStatus[] = ['ready_to_apply', 'needs_manual', 'submit_failed'];
/** Skip: the copy-paste messages (sent for needs_manual / submit_failed too) carry a Skip button. */
const SKIPPABLE: readonly JobStatus[] = ['draft_ready', 'ready_to_apply', 'needs_manual', 'submit_failed'];

export function handleDraftAction(
  db: Db, allowedChatId: string, fromChatId: string | number | undefined, data: string, now = new Date(),
): { ok: boolean; text: string; jobId?: number; next?: 'ready' | 'applied' } {
  if (fromChatId === undefined || String(fromChatId) !== allowedChatId) return { ok: false, text: 'Not allowed' };
  const p = parseDraftCallback(data);
  if (!p) return { ok: false, text: 'Unknown action' };
  const job = getJob(db, p.jobId);
  if (!job) return { ok: false, text: 'Job not found' };
  if (p.action === 'applied') {
    if (!MARKABLE_APPLIED.includes(job.status)) return { ok: false, text: `Already ${job.status}` };
    setStatus(db, job.id, 'applied', 'telegram', {}, now);
    return { ok: true, text: '📨 Marked applied', jobId: job.id, next: 'applied' };
  }
  if (p.action === 'skip') {
    if (!SKIPPABLE.includes(job.status)) return { ok: false, text: `Already ${job.status}` };
    setStatus(db, job.id, 'skipped', `telegram ${job.status === 'draft_ready' ? 'draft' : job.status === 'ready_to_apply' ? 'ready' : job.status}`, {}, now);
    return { ok: true, text: '⏭ Skipped', jobId: job.id };
  }
  if (job.status !== 'draft_ready') return { ok: false, text: `Already ${job.status}` };
  const draft = latestDraft(db, job.id);
  if (!draft) return { ok: false, text: 'No draft' };
  const blocked = draft.flags.some(isBlockingFlag);
  if (blocked && p.action !== 'override') return { ok: false, text: '⚠️ Draft has warnings — review it in the dashboard' };
  setStatus(db, job.id, 'ready_to_apply', blocked ? 'telegram (override)' : 'telegram', {}, now);
  return { ok: true, text: '✅ Approved', jobId: job.id, next: 'ready' };
}

export async function notifyDrafts(sender: DraftSender, chatId: string, db: Db, opts: { delay?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const delay = opts.delay ?? sleep;
  let sent = 0;
  for (const [i, { job, draft }] of listUnnotifiedDrafts(db, 10).entries()) {
    if (i > 0) await delay(1000);
    try {
      await sender.sendMessage(chatId, formatDraftCard(job, draft), {
        parse_mode: 'HTML', reply_markup: draftKeyboard(job.id, draft.flags.some(isBlockingFlag)), link_preview_options: { is_disabled: true },
      });
      sent++;
    } catch (e) {
      console.error(`[telegram] draft card failed for job #${job.id}; will retry next loop:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (draft.cvPdfPath) {
      try { await sender.sendDocument(chatId, draft.cvPdfPath, `CV — ${job.company}`); }
      catch (e) { console.error(`[telegram] CV send failed for job #${job.id}:`, e instanceof Error ? e.message : e); }
    }
    markDraftNotified(db, draft.id);
  }
  return sent;
}

/** /drafts: re-send the card of every draft waiting for a decision, with today's buttons (no CV: it was sent with the first card). */
export async function resendDraftCards(sender: MessageSender, chatId: string, db: Db, opts: { delay?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const delay = opts.delay ?? sleep;
  let sent = 0;
  for (const job of listJobsByStatus(db, ['draft_ready'], 50)) {
    const draft = latestDraft(db, job.id);
    if (!draft) continue;
    if (sent > 0) await delay(1000);
    try {
      await sender.sendMessage(chatId, formatDraftCard(job, draft), {
        parse_mode: 'HTML', reply_markup: draftKeyboard(job.id, draft.flags.some(isBlockingFlag)), link_preview_options: { is_disabled: true },
      });
      sent++;
    } catch (e) {
      console.error(`[telegram] draft card resend failed for job #${job.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

export async function sendReady(sender: DraftSender, chatId: string, job: JobRow, draft: DraftRow): Promise<void> {
  const msgs = formatReadyItems(job, draft);
  const opts = (kb?: InlineKeyboard) => ({ parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });
  const doneRow = (kb: InlineKeyboard) => kb.text('📨 Mark applied', `ma:${job.id}`).text('⏭ Skip', `sd:${job.id}`);
  const button = () => opts(doneRow(new InlineKeyboard()));
  let lastDelivered = -1;
  for (const [i, m] of msgs.entries()) {
    const last = i === msgs.length - 1;
    const copy = m.copy ? new InlineKeyboard().copyText('📋 Copy', m.copy) : undefined;
    try {
      await sender.sendMessage(chatId, m.text, opts(last ? doneRow(copy ? copy.row() : new InlineKeyboard()) : copy));
      lastDelivered = i;
    } catch (e) {
      console.error(`[telegram] ready message ${i + 1}/${msgs.length} failed for job #${job.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (lastDelivered !== msgs.length - 1) {
    await sender.sendMessage(chatId, '📨 Mark applied when done', button()).catch((e) =>
      console.error(`[telegram] mark-applied prompt failed for job #${job.id}:`, e instanceof Error ? e.message : e));
  }
  if (draft.cvPdfPath) {
    await sender.sendDocument(chatId, draft.cvPdfPath, `CV — ${job.company}`).catch((e) =>
      console.error(`[telegram] CV send failed for job #${job.id}:`, e instanceof Error ? e.message : e));
  }
}

export function formatDraftFailure(job: JobRow, reason: string): string {
  const why = truncate(reason.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, ''), 160);
  return `⚠️ Draft failed for ${escapeHtml(truncate(job.title, 100))} — ${escapeHtml(truncate(job.company, 80))}: ${escapeHtml(why)}. Retry from the dashboard (/jobs/${job.id}).`;
}

/** One Telegram notice per job that entered draft_failed; unsent notices are retried next loop. */
export async function notifyDraftFailures(sender: MessageSender, chatId: string, db: Db, now = new Date()): Promise<number> {
  let sent = 0;
  for (const { job, reason } of listUnnotifiedDraftFailures(db, 10)) {
    try {
      await sender.sendMessage(chatId, formatDraftFailure(job, reason), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.error(`[telegram] draft-failure notice failed for job #${job.id}; will retry next loop:`, e instanceof Error ? e.message : e);
      continue;
    }
    markDraftFailureNotified(db, job.id, now);
    sent++;
  }
  return sent;
}

const CLI_DRAFTABLE: readonly JobStatus[] = ['awaiting_review', 'shortlisted', 'draft_ready', 'draft_failed'];

/** Why `cli draft` must not (re)draft a job in this status, or null when it may. */
export function cliDraftRefusal(status: JobStatus): string | null {
  if (status === 'drafting') return 'is currently being drafted; try again in a few minutes';
  if (CLI_DRAFTABLE.includes(status)) return null;
  return `is ${status}; cli draft only works for ${CLI_DRAFTABLE.slice(0, -1).join(', ')} or ${CLI_DRAFTABLE.at(-1)}`;
}

