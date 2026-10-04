import { InlineKeyboard } from 'grammy';
import {
  getJob, isBlockingFlag, latestDraft, listUnnotifiedDraftFailures, listUnnotifiedDrafts, markDraftFailureNotified, markDraftNotified, setStatus,
  type Db, type DraftRow, type JobRow,
} from '@autoapplier/core';
import { escapeHtml, type MessageSender } from './telegram';

export interface DraftSender extends MessageSender {
  sendDocument(chatId: string, path: string, caption: string): Promise<unknown>;
}

const LIMIT = 4000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function truncate(text: string, max: number): string {
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
  if (!blocked) kb.text('✅ Approve', `ap:${jobId}`);
  return kb.text('⏭ Skip', `sd:${jobId}`);
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

function pack(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > LIMIT) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out;
}

function pieceBlocks(label: string, text: string, tag: 'pre' | 'code'): string[] {
  const l = escapeHtml(truncate(label, 200));
  return splitByEscaped(text).map((p, i) =>
    `<b>${l}${i > 0 ? ' (cont.)' : ''}</b>\n<${tag}>${escapeHtml(p)}</${tag}>`);
}

export function formatReadyMessages(job: JobRow, draft: DraftRow): string[] {
  const url = job.resolvedApplyUrl ?? job.applyUrl;
  const blocks = [
    `🚀 <b>Ready to apply:</b> ${escapeHtml(truncate(job.title, 200))} — ${escapeHtml(truncate(job.company, 200))}\n${escapeHtml(truncate(url, 1000))}`,
    ...draft.answers.flatMap((a) => pieceBlocks(a.label, a.answer, 'code')),
    ...pieceBlocks('Cover letter', draft.coverLetter, 'pre'),
  ];
  return pack(blocks);
}

export function parseDraftCallback(data: string): { action: 'approve' | 'skip' | 'applied'; jobId: number } | null {
  const m = /^(ap|sd|ma):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] === 'ap' ? 'approve' : m[1] === 'sd' ? 'skip' : 'applied', jobId: Number(m[2]) };
}

export function handleDraftAction(
  db: Db, allowedChatId: string, fromChatId: string | number | undefined, data: string, now = new Date(),
): { ok: boolean; text: string; jobId?: number; next?: 'ready' | 'applied' } {
  if (fromChatId === undefined || String(fromChatId) !== allowedChatId) return { ok: false, text: 'Not allowed' };
  const p = parseDraftCallback(data);
  if (!p) return { ok: false, text: 'Unknown action' };
  const job = getJob(db, p.jobId);
  if (!job) return { ok: false, text: 'Job not found' };
  if (p.action === 'applied') {
    if (job.status !== 'ready_to_apply') return { ok: false, text: `Already ${job.status}` };
    setStatus(db, job.id, 'applied', 'telegram', {}, now);
    return { ok: true, text: '📨 Marked applied', jobId: job.id, next: 'applied' };
  }
  if (p.action === 'skip') {
    if (job.status !== 'draft_ready' && job.status !== 'ready_to_apply') return { ok: false, text: `Already ${job.status}` };
    setStatus(db, job.id, 'skipped', `telegram ${job.status === 'draft_ready' ? 'draft' : 'ready'}`, {}, now);
    return { ok: true, text: '⏭ Skipped', jobId: job.id };
  }
  if (job.status !== 'draft_ready') return { ok: false, text: `Already ${job.status}` };
  const draft = latestDraft(db, job.id);
  if (!draft) return { ok: false, text: 'No draft' };
  if (draft.flags.some(isBlockingFlag)) return { ok: false, text: '⚠️ Draft has warnings — review it in the dashboard' };
  setStatus(db, job.id, 'ready_to_apply', 'telegram', {}, now);
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

export async function sendReady(sender: DraftSender, chatId: string, job: JobRow, draft: DraftRow): Promise<void> {
  const msgs = formatReadyMessages(job, draft);
  const button = () => ({ parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, reply_markup: new InlineKeyboard().text('📨 Mark applied', `ma:${job.id}`).text('⏭ Skip', `sd:${job.id}`) });
  const plain = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
  let lastDelivered = -1;
  for (const [i, m] of msgs.entries()) {
    const last = i === msgs.length - 1;
    try {
      await sender.sendMessage(chatId, m, last ? button() : plain);
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

