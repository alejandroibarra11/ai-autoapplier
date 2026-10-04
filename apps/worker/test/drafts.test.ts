import { describe, it, expect } from 'vitest';
import { openDb, insertJobs, listJobsByStatus, setStatus, insertDraft, getJob, latestDraft, type DraftInput } from '@autoapplier/core';
import { formatDraftCard, formatReadyMessages, handleDraftAction, notifyDrafts, parseDraftCallback } from '../src/drafts';

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
