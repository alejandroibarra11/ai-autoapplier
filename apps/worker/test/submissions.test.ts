import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, insertJobs, listJobsByStatus, setStatus, insertDraft, getJob, setResolved, insertSubmission, latestSubmission, updateSubmission,
  STALE_SUBMIT_NOTE, type FillEntry, type FillPlan, type ResolvedKind,
} from '@autoapplier/core';
import { handleDraftAction } from '../src/drafts';
import { escapeHtml } from '../src/telegram';
import {
  createSubmitTaps, formatFillCard, handleCancel, notifySubmissions, parseSubmitCallback, photoFits, reportSubmitResult,
  sendReadyAfterCancel, sendReadyUnlessAutoFill, submitAndReport, type SubmissionSender,
} from '../src/submissions';

const dir = mkdtempSync(join(tmpdir(), 'aa-subs-'));
let n = 0;
/** Writes a minimal PNG header (signature + IHDR) with the given size. */
function png(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  const p = join(dir, `shot-${n++}.png`);
  writeFileSync(p, b);
  return p;
}

const entry = (fieldId: string, label: string, value: string, source: FillEntry['source'] = 'identity', kind: FillEntry['kind'] = 'text'): FillEntry =>
  ({ fieldId, label, kind, value, source, required: true });
const PLAN: FillPlan = {
  entries: [
    entry('first_name', 'First Name', 'Jane'),
    entry('email', 'Email', 'jane@example.com'),
    entry('resume', 'Resume', '/tmp/cv.pdf', 'identity', 'file'),
    entry('question_1', 'Why <Acme>?', 'Because & so', 'fill_time', 'textarea'),
  ],
  missingRequired: [], manualReasons: [],
};

function setup(opts: { kind?: ResolvedKind; status?: Parameters<typeof setStatus>[2]; result?: 'filled' | 'blocked' | 'failed' | 'dry_run'; shot?: string | null; evidence?: string; plan?: FillPlan } = {}) {
  const db = openDb(':memory:');
  insertJobs(db, [{
    source: 'greenhouse', sourceJobId: '1', company: 'Acme & Co', title: 'Voice <AI> Engineer', locationText: 'Remote', description: 'd',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123', ats: 'greenhouse', atsToken: 'acme', compMin: null, compMax: null, compCurrency: null, compPeriod: null,
    postedAt: new Date('2026-10-02T00:00:00Z'),
  }]);
  const id = listJobsByStatus(db, ['discovered'])[0]!.id;
  setResolved(db, id, 'https://boards.greenhouse.io/acme/jobs/123', opts.kind ?? 'greenhouse');
  insertDraft(db, {
    jobId: id, model: 'm', coverLetter: 'Dear Acme', cvPdfPath: null, flags: [], questions: [], cvSelection: { skillsOrder: [], bulletIds: [] },
    answers: [{ questionId: 'question_1', label: 'Why Acme?', answer: 'Because', source: 'generated' }],
  });
  setStatus(db, id, opts.status ?? 'awaiting_submit');
  const subId = opts.result === undefined && opts.status && !['awaiting_submit', 'needs_manual', 'submit_failed'].includes(opts.status)
    ? null
    : insertSubmission(db, { jobId: id, plan: opts.plan ?? PLAN, fillShot: opts.shot === undefined ? png(800, 2000) : opts.shot, result: opts.result ?? 'filled', evidence: opts.evidence ?? null });
  return { db, id, subId };
}

type Call = { type: 'msg' | 'photo' | 'doc'; text: string; other?: Record<string, unknown> };
function recorder(fail: Partial<Record<Call['type'], boolean>> = {}) {
  const calls: Call[] = [];
  const sender: SubmissionSender = {
    sendMessage: async (_c, text, other) => { if (fail.msg) throw new Error('down'); calls.push({ type: 'msg', text, other }); },
    sendPhoto: async (_c, path, caption, other) => { if (fail.photo) throw new Error('down'); calls.push({ type: 'photo', text: `${path}|${caption}`, other }); },
    sendDocument: async (_c, path, caption, other) => { if (fail.doc) throw new Error('down'); calls.push({ type: 'doc', text: `${path}|${caption}`, other }); },
  };
  return { calls, sender };
}
const kb = (c: Call) => JSON.stringify(c.other?.reply_markup ?? null);
const cfg = (dryRun: boolean) => ({ submit: { dryRun } });

describe('formatFillCard', () => {
  it('escapes, counts fields, lists fill-time answers and shows the dry-run banner', () => {
    const { db, id } = setup();
    const card = formatFillCard(getJob(db, id)!, latestSubmission(db, id)!, true);
    expect(card).toContain('Voice &lt;AI&gt; Engineer');
    expect(card).toContain('Acme &amp; Co');
    expect(card).toContain('✍️ 3 filled · CV attached'); // no fill report (older row): plan counts
    expect(card).toContain('⚠️ Why &lt;Acme&gt;?: Because &amp; so');
    expect(card).toContain('🧪 Dry run is ON — Submit will not send anything');
    expect(formatFillCard(getJob(db, id)!, latestSubmission(db, id)!, false)).not.toContain('Dry run');
  });
  it('counts from the stored fill report and lists non-empty identity fields that are not on the form', () => {
    const plan: FillPlan = { ...PLAN, entries: [...PLAN.entries, entry('identity:linkedin', 'LinkedIn', 'https://l'), entry('identity:github', 'GitHub <x>', 'https://g'), entry('identity:portfolio', 'Portfolio', '')] };
    const { db, id, subId } = setup({ plan });
    db.$client.prepare('update submissions set report = ? where id = ?').run(JSON.stringify({
      filled: ['first_name', 'resume', 'question_1'], notFound: ['email', 'identity:linkedin', 'identity:github', 'identity:portfolio'], failed: [], requiredEmpty: [],
    }), subId);
    const card = formatFillCard(getJob(db, id)!, latestSubmission(db, id)!, false);
    expect(card).toContain('✍️ 2 filled · 3 not on form · CV attached');
    expect(card).toContain('Not on this form: Email, LinkedIn, GitHub &lt;x&gt;');
    expect(card).not.toContain('Portfolio');
  });
  it('Ashby cards disclose that the employer already saved the values; other kinds do not', () => {
    const line = "ℹ️ Ashby saves these values on the employer's side while filling — Cancel doesn't remove them.";
    const a = setup({ kind: 'ashby' });
    expect(formatFillCard(getJob(a.db, a.id)!, latestSubmission(a.db, a.id)!, false)).toContain(escapeHtml(line));
    const g = setup({ kind: 'greenhouse' });
    expect(formatFillCard(getJob(g.db, g.id)!, latestSubmission(g.db, g.id)!, false)).not.toContain('Ashby saves');
  });
  it('caps the fill-time answers it lists', () => {
    const many = { ...PLAN, entries: Array.from({ length: 12 }, (_, i) => entry(`q${i}`, `Question ${i}`, 'x'.repeat(500), 'fill_time')) };
    const { db, id } = setup({ plan: many });
    const card = formatFillCard(getJob(db, id)!, latestSubmission(db, id)!, false);
    expect(card.match(/⚠️ Question/g)!.length).toBeLessThanOrEqual(5);
    expect(card).toContain('more fill-time answers');
    expect(card).not.toContain('x'.repeat(301));
  });
});

describe('photoFits', () => {
  it('uses Telegram photo limits: width+height ≤ 10000 and height/width ≤ 20', () => {
    expect(photoFits(png(1000, 8000))).toBe(true);
    expect(photoFits(png(1000, 9500))).toBe(false);
    expect(photoFits(png(100, 2100))).toBe(false);
    expect(photoFits(png(100, 1900))).toBe(true);
    expect(photoFits(join(dir, 'missing.png'))).toBe(false);
  });
});

describe('parseSubmitCallback', () => {
  it('parses su:/ca:', () => {
    expect(parseSubmitCallback('su:4:d')).toEqual({ action: 'submit', jobId: 4, cardDry: true });
    expect(parseSubmitCallback('su:4:r')).toEqual({ action: 'submit', jobId: 4, cardDry: false });
    expect(parseSubmitCallback('su:4')).toEqual({ action: 'submit', jobId: 4, cardDry: null });
    expect(parseSubmitCallback('ca:4')).toEqual({ action: 'cancel', jobId: 4, cardDry: null });
    expect(parseSubmitCallback('su:4:x')).toBeNull();
    expect(parseSubmitCallback('ap:4')).toBeNull();
  });
});

describe('notifySubmissions', () => {
  it('filled → one photo with the card caption and Submit/Cancel, once', async () => {
    const { db, id } = setup();
    const { calls, sender } = recorder();
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('photo');
    expect(calls[0]!.text).toContain('🧪 Dry run is ON');
    expect(calls[0]!.other?.parse_mode).toBe('HTML');
    expect(kb(calls[0]!)).toContain(`"su:${id}:d"`);
    expect(kb(calls[0]!)).toContain(`ca:${id}`);
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(0);
    expect(calls).toHaveLength(1);
  });
  it('a screenshot too tall for a photo goes as a document', async () => {
    const { db } = setup({ shot: png(800, 17000) });
    const { calls, sender } = recorder();
    await notifySubmissions(sender, '42', db, cfg(false), { delay: async () => {} });
    expect(calls.map((c) => c.type)).toEqual(['doc']);
    expect(kb(calls[0]!)).toMatch(/"su:\d+:r"/);
  });
  it('a long card keeps the caption ≤ 1024 and sends the details as a follow-up', async () => {
    const many = { ...PLAN, entries: Array.from({ length: 6 }, (_, i) => entry(`q${i}`, `Question ${i} ${'l'.repeat(80)}`, 'y'.repeat(300), 'fill_time')) };
    const { db } = setup({ plan: many });
    const { calls, sender } = recorder();
    await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} });
    expect(calls.map((c) => c.type)).toEqual(['photo', 'msg']);
    expect(calls[0]!.text.split('|').slice(1).join('|').length).toBeLessThanOrEqual(1024);
    expect(calls[0]!.text).toContain('🧪 Dry run is ON');
    expect(calls[1]!.text).toContain('⚠️ Question 0');
  });
  it('not marked notified when the main message fails; retried next loop', async () => {
    const { db } = setup({ shot: null });
    const down = recorder({ msg: true, photo: true, doc: true });
    expect(await notifySubmissions(down.sender, '42', db, cfg(true), { delay: async () => {} })).toBe(0);
    const up = recorder();
    expect(await notifySubmissions(up.sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
    expect(up.calls[0]!.type).toBe('msg');
    expect(kb(up.calls[0]!)).toContain('su:');
  });
  it('blocked → finish manually with screenshot + the copy-paste messages, once', async () => {
    const { db, id } = setup({ status: 'needs_manual', result: 'blocked', evidence: 'login required to apply' });
    const { calls, sender } = recorder();
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
    expect(calls[0]!.type).toBe('photo');
    expect(calls[0]!.text).toContain('⚠️ Finish manually — Voice &lt;AI&gt; Engineer');
    expect(calls[0]!.text).toContain('login required to apply');
    expect(calls.some((c) => c.type === 'msg' && c.text.includes('Ready to apply'))).toBe(true);
    expect(calls.some((c) => kb(c).includes(`ma:${id}`))).toBe(true);
    const before = calls.length;
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(0);
    expect(calls).toHaveLength(before);
  });
  it('a long reason is cut by escaped length so it still fits the photo caption', async () => {
    const { db } = setup({ status: 'needs_manual', result: 'blocked', evidence: 'missing answer: ' + '&'.repeat(590) });
    const { calls, sender } = recorder();
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
    expect(calls[0]!.type).toBe('photo');
    const caption = calls[0]!.text.split('|').slice(1).join('|');
    expect(caption).toContain('⚠️ Finish manually');
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toMatch(/&amp;…/);
  });
  it('a stale-sweep submit_failed is notified once with a Mark applied button', async () => {
    const { db, id, subId } = setup({ status: 'submit_failed', result: 'failed', evidence: STALE_SUBMIT_NOTE });
    void subId;
    const { calls, sender } = recorder();
    expect(await notifySubmissions(sender, '42', db, cfg(false), { delay: async () => {} })).toBe(1);
    expect(calls[0]!.text).toContain('⚠️ The worker restarted while submitting Voice &lt;AI&gt; Engineer');
    expect(calls[0]!.text).toContain('check your email');
    expect(kb(calls[0]!)).toContain(`ma:${id}`);
    expect(await notifySubmissions(sender, '42', db, cfg(false), { delay: async () => {} })).toBe(0);
  });
  it('a filled row whose job moved on (e.g. skipped in the dashboard) is marked without sending', async () => {
    const { db, id } = setup();
    setStatus(db, id, 'skipped');
    const { calls, sender } = recorder();
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(0);
    expect(calls).toEqual([]);
    expect(latestSubmission(db, id)!.notifiedAt).not.toBeNull();
  });
});

describe('handleCancel', () => {
  it('only from awaiting_submit; other chats refused; press-once', () => {
    const { db, id } = setup();
    expect(handleCancel(db, '42', 7, id)).toEqual({ ok: false, text: 'Not allowed' });
    expect(getJob(db, id)!.status).toBe('awaiting_submit');
    expect(handleCancel(db, '42', 42, id).ok).toBe(true);
    expect(getJob(db, id)!.status).toBe('needs_manual');
    expect(latestSubmission(db, id)!.result).toBe('cancelled');
    expect(handleCancel(db, '42', 42, id)).toEqual({ ok: false, text: 'Already needs_manual' });
  });
  it('refused from ready_to_apply', () => {
    const { db, id } = setup({ status: 'ready_to_apply' });
    expect(handleCancel(db, '42', 42, id)).toEqual({ ok: false, text: 'Already ready_to_apply' });
  });
  it('after a successful cancel the copy-paste messages are sent (with 📨 Mark applied / ⏭ Skip)', async () => {
    const { db, id } = setup();
    expect(handleCancel(db, '42', 42, id).ok).toBe(true);
    const { calls, sender } = recorder();
    await sendReadyAfterCancel(sender, '42', db, id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.type === 'msg')).toBe(true);
    expect(calls.map((c) => c.text).join('\n')).toContain('Dear Acme');
    expect(kb(calls.at(-1)!)).toContain(`ma:${id}`);
  });
  it('sendReadyAfterCancel sends nothing unless the job is in needs_manual after a cancel', async () => {
    const { db, id } = setup();
    const { calls, sender } = recorder();
    await sendReadyAfterCancel(sender, '42', db, id); // still awaiting_submit
    expect(calls).toEqual([]);
  });
});

describe('submit taps', () => {
  it('chat gate, press-once while in flight, refused after the job moved on', async () => {
    const { db, id } = setup();
    let release!: () => void;
    const ran: number[] = [];
    const tap = createSubmitTaps(db, '42', true, async (jobId) => {
      ran.push(jobId);
      await new Promise<void>((r) => { release = r; });
      setStatus(db, jobId, 'applied');
    });
    expect(tap(7, id, true)).toEqual({ ok: false, text: 'Not allowed' });
    const first = tap(42, id, true);
    expect(first).toMatchObject({ ok: true, text: '🚀 Submitting…' });
    const done = first.start!();
    expect(tap(42, id, true)).toEqual({ ok: false, text: '⏳ Already submitting' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await done;
    expect(ran).toEqual([id]);
    expect(tap(42, id, true)).toEqual({ ok: false, text: 'Already applied' });
  });
  it('a failing run is logged and frees the job for another tap', async () => {
    const { db, id } = setup();
    const tap = createSubmitTaps(db, '42', false, async () => { throw new Error('boom'); });
    await tap(42, id, false).start!();
    expect(tap(42, id, false).ok).toBe(true);
  });
  it('matching mode → run called once', async () => {
    for (const dry of [true, false]) {
      const { db, id } = setup();
      const ran: number[] = [];
      const tap = createSubmitTaps(db, '42', dry, async (j) => { ran.push(j); });
      const r = tap(42, id, dry);
      expect(r.ok).toBe(true);
      await r.start!();
      expect(ran).toEqual([id]);
    }
  });
  it('mode changed (dry card + dry run off, real card + dry run on, legacy card) → no run, re-fill', () => {
    for (const [cardDry, dryRun] of [[true, false], [false, true], [null, false], [null, true]] as const) {
      const { db, id } = setup();
      const ran: number[] = [];
      const tap = createSubmitTaps(db, '42', dryRun, async (j) => { ran.push(j); });
      const r = tap(42, id, cardDry);
      expect(r).toEqual({ ok: true, text: 'Mode changed — sending a fresh screenshot' });
      expect(r.start).toBeUndefined();
      expect(ran).toEqual([]);
      expect(getJob(db, id)!.status).toBe('ready_to_apply');
      expect(tap(42, id, dryRun)).toEqual({ ok: false, text: 'Already ready_to_apply' });
    }
  });
});

describe('mark applied after a manual finish', () => {
  it('ma: works from needs_manual and submit_failed', () => {
    for (const status of ['needs_manual', 'submit_failed'] as const) {
      const { db, id } = setup({ status, result: status === 'needs_manual' ? 'blocked' : 'failed' });
      expect(handleDraftAction(db, '42', 42, `ma:${id}`)).toMatchObject({ ok: true, next: 'applied' });
      expect(getJob(db, id)!.status).toBe('applied');
    }
  });
  it('sd: (Skip on the copy-paste messages) works from needs_manual and submit_failed', () => {
    for (const status of ['needs_manual', 'submit_failed'] as const) {
      const { db, id } = setup({ status, result: status === 'needs_manual' ? 'blocked' : 'failed' });
      expect(handleDraftAction(db, '42', 42, `sd:${id}`)).toMatchObject({ ok: true, text: '⏭ Skipped' });
      expect(getJob(db, id)!.status).toBe('skipped');
    }
  });
  it('ma: still refused from awaiting_submit (use Submit or Cancel)', () => {
    const { db, id } = setup();
    expect(handleDraftAction(db, '42', 42, `ma:${id}`)).toEqual({ ok: false, text: 'Already awaiting_submit' });
  });
});

describe('reportSubmitResult', () => {
  it('dry run: unambiguous text, screenshot, Submit/Cancel again', async () => {
    const { db, id } = setup();
    const { calls, sender } = recorder();
    await reportSubmitResult(sender, '42', db, cfg(true), id, { status: 'dry_run', shot: png(800, 1600) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('photo');
    expect(calls[0]!.text).toContain('🧪 Dry run — nothing was sent.');
    expect(calls[0]!.text).toContain('submit.dryRun');
    expect(kb(calls[0]!)).toContain(`"su:${id}:d"`);
    expect(kb(calls[0]!)).toContain(`ca:${id}`);
  });
  it('applied: ✅ Applied — <company> with the screenshot', async () => {
    const { db, id } = setup({ status: 'applied', result: 'filled' });
    const { calls, sender } = recorder();
    await reportSubmitResult(sender, '42', db, cfg(true), id, { status: 'applied', shot: png(800, 1600) });
    expect(calls[0]!.text).toContain('✅ Applied — Acme &amp; Co');
  });
  it('refused: the reason, with the keyboard back while still awaiting_submit', async () => {
    const { db, id } = setup();
    const { calls, sender } = recorder();
    await reportSubmitResult(sender, '42', db, cfg(true), id, { status: 'refused', reason: 'Daily limit <15> reached' });
    expect(calls[0]!.type).toBe('msg');
    expect(calls[0]!.text).toContain('Daily limit &lt;15&gt; reached');
    expect(kb(calls[0]!)).toContain(`"su:${id}:d"`);
    setStatus(db, id, 'applied');
    const r2 = recorder();
    await reportSubmitResult(r2.sender, '42', db, cfg(true), id, { status: 'refused', reason: 'Not awaiting submit (status applied)' });
    expect(kb(r2.calls[0]!)).not.toContain('su:');
  });
  it('submit_failed / needs_manual: finish manually + screenshot + copy-paste + Mark applied', async () => {
    for (const status of ['submit_failed', 'needs_manual'] as const) {
      const { db, id } = setup({ status, result: status === 'needs_manual' ? 'blocked' : 'failed' });
      const { calls, sender } = recorder();
      await reportSubmitResult(sender, '42', db, cfg(true), id, { status, reason: 'unknown: no confirmation', shot: png(800, 1600) });
      expect(calls[0]!.text).toContain('⚠️ unknown: no confirmation — finish manually');
      expect(calls.some((c) => c.text.includes('Ready to apply'))).toBe(true);
      expect(calls.some((c) => kb(c).includes(`ma:${id}`))).toBe(true);
    }
  });
  it('marks the latest submission notified so the loop does not repeat it', async () => {
    const { db, id, subId } = setup();
    updateSubmission(db, subId!, { result: 'dry_run' });
    const { sender } = recorder();
    await reportSubmitResult(sender, '42', db, cfg(true), id, { status: 'dry_run', shot: png(800, 1600) });
    const r2 = recorder();
    expect(await notifySubmissions(r2.sender, '42', db, cfg(true), { delay: async () => {} })).toBe(0);
  });
});

describe('approve → ready message', () => {
  it('greenhouse/lever/ashby: no copy-paste message (the fill loop sends the screenshot)', async () => {
    for (const kind of ['greenhouse', 'lever', 'ashby'] as const) {
      const { db, id } = setup({ kind, status: 'ready_to_apply' });
      const { calls, sender } = recorder();
      expect(await sendReadyUnlessAutoFill(sender, '42', db, id)).toBe('autofill');
      expect(calls).toEqual([]);
    }
  });
  it('other kinds: the phase 2 ready message as before', async () => {
    const { db, id } = setup({ kind: 'manual', status: 'ready_to_apply' });
    const { calls, sender } = recorder();
    expect(await sendReadyUnlessAutoFill(sender, '42', db, id)).toBe('ready');
    expect(calls.some((c) => c.text.includes('Ready to apply'))).toBe(true);
  });
});

describe('lost results are re-sent by the loop', () => {
  it('result message fails once → notifiedAt cleared → notifySubmissions sends the right message', async () => {
    const { db, id, subId } = setup();
    updateSubmission(db, subId!, { notifiedAt: new Date() });
    const down = recorder({ msg: true, photo: true, doc: true });
    await submitAndReport({ sender: down.sender, chatId: '42', db, cfg: cfg(true), jobId: id, submit: async () => {
      updateSubmission(db, subId!, { result: 'dry_run', submitShot: png(800, 1600) });
      return { status: 'dry_run', shot: png(800, 1600) };
    } });
    expect(latestSubmission(db, id)!.notifiedAt).toBeNull();
    const up = recorder();
    expect(await notifySubmissions(up.sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
    expect(kb(up.calls[0]!)).toContain(`"su:${id}:d"`);
  });
  it('the run throws (e.g. before the claim) → notifiedAt cleared, the card comes back', async () => {
    const { db, id, subId } = setup();
    updateSubmission(db, subId!, { notifiedAt: new Date() });
    const { calls, sender } = recorder();
    await submitAndReport({ sender, chatId: '42', db, cfg: cfg(true), jobId: id, submit: async () => { throw new Error('browser gone'); } });
    expect(calls).toEqual([]);
    expect(latestSubmission(db, id)!.notifiedAt).toBeNull();
    expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
  });
  it('a delivered result keeps notifiedAt set', async () => {
    const { db, id, subId } = setup();
    updateSubmission(db, subId!, { notifiedAt: new Date() });
    const { calls, sender } = recorder();
    await submitAndReport({ sender, chatId: '42', db, cfg: cfg(true), jobId: id, submit: async () => ({ status: 'refused', reason: 'Daily limit reached' }) });
    expect(calls).toHaveLength(1);
    expect(latestSubmission(db, id)!.notifiedAt).not.toBeNull();
  });
});

describe('copy-paste failures after the headline', () => {
  it('headline delivered, copy-paste throws → marked notified, no duplicate headline', async () => {
    const { db } = setup({ status: 'needs_manual', result: 'blocked', evidence: 'login required to apply' });
    const calls: string[] = [];
    let photos = 0;
    const sender: SubmissionSender = {
      sendPhoto: async () => { photos++; calls.push('photo'); },
      sendDocument: async () => { throw new Error('down'); },
      sendMessage: async () => { throw new Error('down'); },
    };
    const readyBoom = { ...sender, sendMessage: async () => { throw new Error('down'); } };
    expect(await notifySubmissions(readyBoom, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
    expect(await notifySubmissions(readyBoom, '42', db, cfg(true), { delay: async () => {} })).toBe(0);
    expect(photos).toBe(1);
  });
});

describe('escaped lengths stay within Telegram limits', () => {
  it("'&'-heavy title, reasons and fill-time answers: messages ≤ 4096, captions ≤ 1024", async () => {
    const amp = (n: number) => '&'.repeat(n);
    const heavy = { ...PLAN, entries: Array.from({ length: 8 }, (_, i) => entry(`q${i}`, `${i}${amp(1000)}`, amp(3000), 'fill_time')) };
    const all: Call[] = [];
    const check = () => {
      for (const c of all) {
        if (c.type === 'msg') expect(c.text.length).toBeLessThanOrEqual(4096);
        else expect(c.text.split('|').slice(1).join('|').length).toBeLessThanOrEqual(1024);
      }
    };
    for (const opts of [
      { plan: heavy },
      { status: 'needs_manual' as const, result: 'blocked' as const, evidence: amp(5000) },
      { status: 'submit_failed' as const, result: 'failed' as const, evidence: amp(5000) },
    ]) {
      const { db, id } = setup(opts);
      db.$client.prepare('update jobs set title = ?, company = ? where id = ?').run(amp(2000), amp(2000), id);
      const { calls, sender } = recorder();
      expect(await notifySubmissions(sender, '42', db, cfg(true), { delay: async () => {} })).toBe(1);
      all.push(...calls);
      const r2 = recorder();
      await reportSubmitResult(r2.sender, '42', db, cfg(true), id, { status: 'refused', reason: amp(6000) });
      await reportSubmitResult(r2.sender, '42', db, cfg(true), id, { status: 'needs_manual', reason: amp(6000), shot: png(800, 1600) });
      all.push(...r2.calls);
    }
    expect(all.length).toBeGreaterThan(5);
    check();
  });
});
