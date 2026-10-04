import { describe, it, expect } from 'vitest';
import { openDb, insertJobs, listJobsByStatus, setStatus, insertScore, getJob, listUnnotified, type ScorePayload } from '@autoapplier/core';
import { escapeHtml, formatJobCard, handleDecision, notifyPending, parseCallback } from '../src/telegram';

const score: ScorePayload = {
  eligibility: 'eligible', eligibilityEvidence: 'Remote <LATAM> & Mexico', fitScore: 84, roleCategory: 'voice',
  matched: ['ElevenLabs', 'Vapi', 'TypeScript', 'NestJS', 'RAG'], missing: ['Go'], redFlags: [], compEstimate: '$60/hr',
};

function setup(n = 1) {
  const db = openDb(':memory:');
  insertJobs(db, Array.from({ length: n }, (_, i) => ({
    source: 'ashby', sourceJobId: String(i), company: 'Vapi & Co', title: `Voice <AI> Engineer ${i}`, locationText: 'Remote (Mexico)',
    description: 'd', applyUrl: `https://jobs.ashbyhq.com/vapi/${i}`, ats: 'ashby' as const, atsToken: 'vapi',
    compMin: 50, compMax: 70, compCurrency: 'USD', compPeriod: 'hour' as const, postedAt: new Date('2026-10-02T00:00:00Z'),
  })));
  const rows = listJobsByStatus(db, ['discovered']);
  rows.forEach((j, i) => { setStatus(db, j.id, 'awaiting_review'); insertScore(db, j.id, 'm', { ...score, fitScore: 70 + i }); });
  return { db, rows };
}

describe('formatting', () => {
  it('escapes html', () => expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;'));
  it('renders a card with escaped fields', () => {
    const { db, rows } = setup();
    const card = formatJobCard(getJob(db, rows[0]!.id)!, score);
    expect(card).toContain('<b>Voice &lt;AI&gt; Engineer 0</b>');
    expect(card).toContain('Vapi &amp; Co');
    expect(card).toContain('Fit 84');
    expect(card).toContain('USD 50–70 per hour');
    expect(card).toContain('“Remote &lt;LATAM&gt; &amp; Mexico”');
    expect(card).not.toContain('RAG'); // max 4 matched shown
  });
});

describe('parseCallback', () => {
  it('parses valid data', () => {
    expect(parseCallback('sl:12')).toEqual({ action: 'shortlist', jobId: 12 });
    expect(parseCallback('sk:3')).toEqual({ action: 'skip', jobId: 3 });
  });
  it('rejects junk', () => {
    expect(parseCallback('xx:1')).toBeNull();
    expect(parseCallback('sl:abc')).toBeNull();
    expect(parseCallback('')).toBeNull();
  });
});

describe('handleDecision', () => {
  it('applies a decision exactly once', () => {
    const { db, rows } = setup();
    const id = rows[0]!.id;
    expect(handleDecision(db, '42', 42, `sl:${id}`)).toMatchObject({ ok: true, applyUrl: 'https://jobs.ashbyhq.com/vapi/0' });
    expect(getJob(db, id)!.status).toBe('shortlisted');
    expect(handleDecision(db, '42', 42, `sk:${id}`)).toEqual({ ok: false, text: 'Already shortlisted' });
    expect(getJob(db, id)!.status).toBe('shortlisted');
  });
  it('ignores other chats and unknown jobs', () => {
    const { db, rows } = setup();
    expect(handleDecision(db, '42', 99, `sl:${rows[0]!.id}`)).toEqual({ ok: false, text: 'Not allowed' });
    expect(handleDecision(db, '42', undefined, `sl:${rows[0]!.id}`)).toEqual({ ok: false, text: 'Not allowed' });
    expect(handleDecision(db, '42', 42, 'sl:9999')).toEqual({ ok: false, text: 'Job not found' });
    expect(getJob(db, rows[0]!.id)!.status).toBe('awaiting_review');
  });
});

describe('notifyPending', () => {
  it('sends best-first, marks notified, never re-sends', async () => {
    const { db } = setup(3);
    const sent: string[] = [];
    const sender = { sendMessage: async (_c: string, text: string) => { sent.push(text); } };
    expect(await notifyPending(sender, '42', db, 2)).toBe(2);
    expect(sent[0]).toContain('Fit 72');
    expect(sent[1]).toContain('Fit 71');
    expect(listUnnotified(db, 10)).toHaveLength(1);
    expect(await notifyPending(sender, '42', db, 10)).toBe(1);
    expect(await notifyPending(sender, '42', db, 10)).toBe(0);
  });

  it('leaves a job unnotified if sending fails', async () => {
    const { db } = setup(1);
    const sender = { sendMessage: async () => { throw new Error('network'); } };
    await expect(notifyPending(sender, '42', db)).rejects.toThrow('network');
    expect(listUnnotified(db, 10)).toHaveLength(1);
  });
});
