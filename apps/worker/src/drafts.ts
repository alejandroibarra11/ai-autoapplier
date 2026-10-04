import { InlineKeyboard } from 'grammy';
import {
  getJob, isBlockingFlag, latestDraft, listUnnotifiedDrafts, markDraftNotified, setStatus,
  type Db, type DraftRow, type JobRow,
} from '@autoapplier/core';
import { escapeHtml, type MessageSender } from './telegram';

export interface DraftSender extends MessageSender {
  sendDocument(chatId: string, path: string, caption: string): Promise<unknown>;
}

const LIMIT = 4000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function formatDraftCard(job: JobRow, draft: DraftRow): string {
  const fixed = draft.answers.filter((a) => a.source === 'answers').length;
  const gen = draft.answers.length - fixed;
  const preview = draft.coverLetter.length > 400 ? `${draft.coverLetter.slice(0, 400)}…` : draft.coverLetter;
  const lines = [
    `📝 <b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}`,
    `<i>${escapeHtml(preview)}</i>`,
    `🧾 ${fixed} fixed · ${gen} generated answers · apply via ${escapeHtml(job.resolvedKind ?? 'manual')}`,
  ];
  if (draft.flags.length) lines.push(`⚠️ ${escapeHtml(draft.flags.join('; '))}`);
  lines.push(`✏️ Edit: <code>pnpm web</code> → /jobs/${job.id}`);
  return lines.join('\n');
}

export function draftKeyboard(jobId: number, blocked: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!blocked) kb.text('✅ Approve', `ap:${jobId}`);
  return kb.text('⏭ Skip', `sd:${jobId}`);
}

function chunk(blocks: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const b of blocks) {
    const pieces = b.length > LIMIT ? b.match(new RegExp(`[\\s\\S]{1,${LIMIT - 20}}`, 'g')) ?? [] : [b];
    for (const p of pieces) {
      if (cur && cur.length + p.length + 2 > LIMIT) { out.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function formatReadyMessages(job: JobRow, draft: DraftRow): string[] {
  const url = job.resolvedApplyUrl ?? job.applyUrl;
  const blocks = [
    `🚀 <b>Ready to apply:</b> ${escapeHtml(job.title)} — ${escapeHtml(job.company)}\n${escapeHtml(url)}`,
    ...draft.answers.map((a) => `<b>${escapeHtml(a.label)}</b>\n<code>${escapeHtml(a.answer)}</code>`),
  ];
  const cover = escapeHtml(draft.coverLetter);
  const coverParts = cover.length > LIMIT - 40 ? cover.match(new RegExp(`[\\s\\S]{1,${LIMIT - 40}}`, 'g')) ?? [] : [cover];
  return chunk([...blocks, ...coverParts.map((p, i) => `${i === 0 ? '<b>Cover letter</b>\n' : ''}<pre>${p}</pre>`)]);
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
  if (job.status !== 'draft_ready') return { ok: false, text: `Already ${job.status}` };
  if (p.action === 'skip') {
    setStatus(db, job.id, 'skipped', 'telegram draft', {}, now);
    return { ok: true, text: '⏭ Skipped', jobId: job.id };
  }
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
  for (const [i, m] of msgs.entries()) {
    const last = i === msgs.length - 1;
    await sender.sendMessage(chatId, m, {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(last ? { reply_markup: new InlineKeyboard().text('📨 Mark applied', `ma:${job.id}`) } : {}),
    });
  }
  if (draft.cvPdfPath) await sender.sendDocument(chatId, draft.cvPdfPath, `CV — ${job.company}`).catch(() => {});
}
