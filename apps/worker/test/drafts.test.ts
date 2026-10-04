import { describe, it, expect, vi } from 'vitest';
import { openDb, insertJobs, listJobsByStatus, setStatus, insertDraft, getJob, latestDraft, type DraftInput } from '@autoapplier/core';
import { formatDraftCard, formatDraftFailure, formatReadyMessages, handleDraftAction, notifyDraftFailures, notifyDrafts, parseDraftCallback, sendReady } from '../src/drafts';

function setup(flags: string[] = [], coverLetter = 'I build <LLM> tools & agents.') {
  const db = openDb(':memory:');
  insertJobs(db, [{
    source: 'ashby', sourceJobId: '1', company: 'Vapi & Co', title: 'Voice <AI> Engineer', locationText: 'Remote (Mexico)', description: 'd',
    applyUrl: 'https://jobs.ashbyhq.com/vapi/1', ats: 'ashby', atsToken: 'vapi', compMin: null, compMax: null, compCurrency: null, compPeriod: null,
    postedAt: new Date('2026-10-02T00:00:00Z'),
  }]);
  const [job] = listJobsByStatus(db, ['discovered']);
  setStatus(db, job!.id, 'draft_ready');
  const d: DraftInput = {
    jobId: job!.id, model: 'm', coverLetter, cvPdfPath: '/tmp/cv.pdf', flags,
    questions: [], cvSelection: { skillsOrder: [], bulletIds: [] },
    answers: [
      { questionId: 'a', label: 'Authorized to work in the US?', answer: 'No', source: 'answers' },
      { questionId: 'b', label: 'Why <Vapi>?', answer: 'Because & so', source: 'generated' },
    ],
  };
  insertDraft(db, d);
  return { db, id: job!.id };
}

describe('draft card', () => {
  it('escapes and summarizes', () => {
    const { db, id } = setup();
    const card = formatDraftCard(getJob(db, id)!, latestDraft(db, id)!);
    expect(card).toContain('<b>Voice &lt;AI&gt; Engineer</b>');
    expect(card).toContain('I build &lt;LLM&gt; tools &amp; agents.');
    expect(card).toContain('1 fixed · 1 generated');
  });
  it('lists flags', () => {
    const { db, id } = setup(['unverified claim: Go']);
    expect(formatDraftCard(getJob(db, id)!, latestDraft(db, id)!)).toContain('unverified claim: Go');
  });
});

describe('ready messages', () => {
  it('include apply link, cover letter and every answer, escaped', () => {
    const { db, id } = setup();
    const msgs = formatReadyMessages(getJob(db, id)!, latestDraft(db, id)!).join('\n');
    expect(msgs).toContain('https://jobs.ashbyhq.com/vapi/1');
    expect(msgs).toContain('Why &lt;Vapi&gt;?');
    expect(msgs).toContain('<code>Because &amp; so</code>');
  });
  it('split long content into chunks of at most 4000 chars', () => {
    const { db, id } = setup([], 'word '.repeat(1500));
    const msgs = formatReadyMessages(getJob(db, id)!, latestDraft(db, id)!);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => m.length <= 4000)).toBe(true);
  });
});

describe('handleDraftAction', () => {
  it('parses callbacks', () => {
    expect(parseDraftCallback('ap:3')).toEqual({ action: 'approve', jobId: 3 });
    expect(parseDraftCallback('sd:3')).toEqual({ action: 'skip', jobId: 3 });
    expect(parseDraftCallback('ma:3')).toEqual({ action: 'applied', jobId: 3 });
    expect(parseDraftCallback('sl:3')).toBeNull();
  });
  it('approve → ready_to_apply once, then mark applied once', () => {
    const { db, id } = setup();
    expect(handleDraftAction(db, '42', 42, `ap:${id}`)).toMatchObject({ ok: true, next: 'ready', jobId: id });
    expect(getJob(db, id)!.status).toBe('ready_to_apply');
    expect(handleDraftAction(db, '42', 42, `ap:${id}`)).toEqual({ ok: false, text: 'Already ready_to_apply' });
    expect(handleDraftAction(db, '42', 42, `ma:${id}`)).toMatchObject({ ok: true, next: 'applied' });
    expect(getJob(db, id)!.status).toBe('applied');
    expect(handleDraftAction(db, '42', 42, `ma:${id}`)).toEqual({ ok: false, text: 'Already applied' });
  });
  it('refuses approval of drafts with blocking flags, allows non-blocking', () => {
    const blocked = setup(['missing answer: Why?']);
    expect(handleDraftAction(blocked.db, '42', 42, `ap:${blocked.id}`)).toEqual({ ok: false, text: '⚠️ Draft has warnings — review it in the dashboard' });
    expect(getJob(blocked.db, blocked.id)!.status).toBe('draft_ready');
    const fine = setup(['CV not generated']);
    expect(handleDraftAction(fine.db, '42', 42, `ap:${fine.id}`).ok).toBe(true);
  });
  it('skip works from draft_ready; other chats are refused', () => {
    const { db, id } = setup();
    expect(handleDraftAction(db, '42', 7, `sd:${id}`)).toEqual({ ok: false, text: 'Not allowed' });
    expect(handleDraftAction(db, '42', 42, `sd:${id}`).ok).toBe(true);
    expect(getJob(db, id)!.status).toBe('skipped');
  });
  it('skip also works from ready_to_apply, not after applied', () => {
    const { db, id } = setup();
    handleDraftAction(db, '42', 42, `ap:${id}`);
    expect(handleDraftAction(db, '42', 42, `sd:${id}`)).toMatchObject({ ok: true, text: '⏭ Skipped' });
    expect(getJob(db, id)!.status).toBe('skipped');
    const other = setup();
    handleDraftAction(other.db, '42', 42, `ap:${other.id}`);
    handleDraftAction(other.db, '42', 42, `ma:${other.id}`);
    expect(handleDraftAction(other.db, '42', 42, `sd:${other.id}`)).toEqual({ ok: false, text: 'Already applied' });
  });
});

describe('notifyDrafts', () => {
  it('sends card + CV once per draft', async () => {
    const { db } = setup();
    const sent: string[] = [];
    const sender = {
      sendMessage: async (_c: string, t: string) => { sent.push(`msg:${t.slice(0, 10)}`); },
      sendDocument: async (_c: string, p: string) => { sent.push(`doc:${p}`); },
    };
    expect(await notifyDrafts(sender, '42', db, { delay: async () => {} })).toBe(1);
    expect(sent).toEqual([expect.stringMatching(/^msg:/), 'doc:/tmp/cv.pdf']);
    expect(await notifyDrafts(sender, '42', db, { delay: async () => {} })).toBe(0);
  });
  it('marks notified even if the document fails (card already delivered)', async () => {
    const { db } = setup();
    const sender = { sendMessage: async () => {}, sendDocument: async () => { throw new Error('file missing'); } };
    expect(await notifyDrafts(sender, '42', db, { delay: async () => {} })).toBe(1);
    expect(await notifyDrafts(sender, '42', db, { delay: async () => {} })).toBe(0);
  });
});

describe('safe chunking', () => {
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  it('never cuts escaped entities or unbalances <pre>', () => {
    const { db, id } = setup([], '& < > '.repeat(2000));
    const msgs = formatReadyMessages(getJob(db, id)!, latestDraft(db, id)!);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4000);
      expect(count(m, /<pre>/g)).toBe(count(m, /<\/pre>/g));
      const text = m.replace(/<\/?(?:b|code|pre)>/g, '');
      expect(text).toMatch(/^(?:[^&]|&(?:amp|lt|gt|quot);)*$/);
    }
  });
  it('splits one huge answer across balanced <code> blocks', () => {
    const s = setup();
    const long = 'a & b '.repeat(1000);
    insertDraft(s.db, {
      jobId: s.id, model: 'm', coverLetter: 'c', cvPdfPath: null, flags: [], questions: [], cvSelection: { skillsOrder: [], bulletIds: [] },
      answers: [{ questionId: 'x', label: 'Long?', answer: long, source: 'generated' }],
    });
    const msgs = formatReadyMessages(getJob(s.db, s.id)!, latestDraft(s.db, s.id)!);
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.join('\n')).toContain('Long? (cont.)');
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4000);
      expect(count(m, /<code>/g)).toBe(count(m, /<\/code>/g));
      expect(m.replace(/<\/?(?:b|code|pre)>/g, '')).toMatch(/^(?:[^&]|&(?:amp|lt|gt|quot);)*$/);
    }
  });
});

describe('sendReady resilience', () => {
  it('continues after a failed message and attaches exactly one ma: button', async () => {
    const { db, id } = setup([], 'word '.repeat(1500));
    const sent: { text: string; markup: unknown }[] = [];
    let n = 0;
    const sender = {
      sendMessage: async (_c: string, text: string, o?: { reply_markup?: unknown }) => {
        if (++n === 2) throw new Error('boom');
        sent.push({ text, markup: o?.reply_markup });
      },
      sendDocument: async () => {},
    };
    const total = formatReadyMessages(getJob(db, id)!, latestDraft(db, id)!).length;
    expect(total).toBeGreaterThan(2);
    await sendReady(sender, '42', getJob(db, id)!, latestDraft(db, id)!);
    expect(sent.length).toBe(total - 1);
    expect(sent.filter((s) => s.markup).length).toBe(1);
    expect(sent[sent.length - 1]!.markup).toBeTruthy();
  });
  it('sends a trailing button message if the last send fails', async () => {
    const { db, id } = setup();
    const total = formatReadyMessages(getJob(db, id)!, latestDraft(db, id)!).length;
    const sent: { text: string; markup: unknown }[] = [];
    let n = 0;
    const sender = {
      sendMessage: async (_c: string, text: string, o?: { reply_markup?: unknown }) => {
        if (++n === total) throw new Error('boom');
        sent.push({ text, markup: o?.reply_markup });
      },
      sendDocument: async () => {},
    };
    await sendReady(sender, '42', getJob(db, id)!, latestDraft(db, id)!);
    expect(sent.filter((s) => s.markup).length).toBe(1);
    expect(sent[sent.length - 1]!.text).toContain('Mark applied');
  });
});

describe('sendReady buttons and CV', () => {
  it('offers Skip next to Mark applied', async () => {
    const { db, id } = setup();
    const markups: unknown[] = [];
    const sender = { sendMessage: async (_c: string, _t: string, o?: { reply_markup?: unknown }) => { if (o?.reply_markup) markups.push(o.reply_markup); }, sendDocument: async () => {} };
    await sendReady(sender, '42', getJob(db, id)!, latestDraft(db, id)!);
    const json = JSON.stringify(markups);
    expect(json).toContain(`ma:${id}`);
    expect(json).toContain(`sd:${id}`);
  });
  it('logs a failed CV document instead of swallowing it', async () => {
    const { db, id } = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sender = { sendMessage: async () => {}, sendDocument: async () => { throw new Error('file too big'); } };
    await sendReady(sender, '42', getJob(db, id)!, latestDraft(db, id)!);
    expect(err).toHaveBeenCalledWith(expect.stringContaining(`CV send failed for job #${id}`), 'file too big');
    err.mockRestore();
  });
});

describe('card bounds', () => {
  it('caps flags and total length', () => {
    const flags = Array.from({ length: 30 }, (_, i) => `CV note ${i} ${'x'.repeat(200)}`);
    const { db, id } = setup(flags, '😀'.repeat(500));
    const card = formatDraftCard(getJob(db, id)!, latestDraft(db, id)!);
    expect(card.length).toBeLessThanOrEqual(4000);
    expect(card).toContain('…');
    expect(card).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('draft failure notices', () => {
  it('formats an escaped failure message with the dashboard path', () => {
    const { db, id } = setup();
    expect(formatDraftFailure(getJob(db, id)!, 'model said <nope> & quit')).toBe(
      `⚠️ Draft failed for Voice &lt;AI&gt; Engineer — Vapi &amp; Co: model said &lt;nope&gt; &amp; quit. Retry from the dashboard (/jobs/${id}).`);
  });
  it('truncates long reasons', () => {
    const { db, id } = setup();
    expect(formatDraftFailure(getJob(db, id)!, 'x'.repeat(1000)).length).toBeLessThan(400);
  });
  it('sends one notice per failed job and marks it', async () => {
    const { db, id } = setup();
    setStatus(db, id, 'draft_failed', 'parse error');
    const sent: string[] = [];
    const sender = { sendMessage: async (_c: string, t: string) => { sent.push(t); }, sendDocument: async () => {} };
    expect(await notifyDraftFailures(sender, 'c', db)).toBe(1);
    expect(await notifyDraftFailures(sender, 'c', db)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('parse error');
    expect(getJob(db, id)!.draftFailureNotifiedAt).toBeInstanceOf(Date);
  });
  it('keeps the notice pending when sending fails', async () => {
    const { db, id } = setup();
    setStatus(db, id, 'draft_failed', 'parse error');
    const sender = { sendMessage: async () => { throw new Error('down'); }, sendDocument: async () => {} };
    expect(await notifyDraftFailures(sender, 'c', db)).toBe(0);
    expect(getJob(db, id)!.draftFailureNotifiedAt).toBeNull();
  });
});

