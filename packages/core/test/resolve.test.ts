import { describe, it, expect } from 'vitest';
import { targetFromUrl, resolveApplyTarget } from '../src/apply/resolve';
import { extractQuestions } from '../src/apply/questions';
import { COMMON_QUESTIONS } from '../src/apply/common';
import type { PageOpener } from '../src/browser';

const job = (applyUrl: string, extra = {}) => ({ applyUrl, ats: null, atsToken: null, sourceJobId: 'x', source: 'himalayas', company: 'Clera', title: 'Senior Voice AI Engineer', ...extra });
const opener = (pages: Record<string, { title?: string; finalUrl?: string; links?: { href: string; text: string }[] }>, fail = false): PageOpener => ({
  async visit(url) {
    if (fail) throw new Error('timeout');
    const p = pages[url] ?? {};
    return { finalUrl: p.finalUrl ?? url, title: p.title ?? 'Job', links: p.links ?? [] };
  },
  async readForm() { return [{ name: 'why', label: 'Why us?', tag: 'textarea', required: true }]; },
});

describe('targetFromUrl', () => {
  it('parses ATS urls with job ids', () => {
    expect(targetFromUrl('https://job-boards.greenhouse.io/gitlab/jobs/123')).toEqual({ kind: 'greenhouse', url: 'https://job-boards.greenhouse.io/gitlab/jobs/123', atsToken: 'gitlab', atsJobId: '123' });
    expect(targetFromUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=55')).toMatchObject({ kind: 'greenhouse', atsToken: 'acme', atsJobId: '55' });
    expect(targetFromUrl('https://jobs.lever.co/toptal/abc-1/apply')).toMatchObject({ kind: 'lever', atsToken: 'toptal', atsJobId: 'abc-1' });
    expect(targetFromUrl('https://jobs.ashbyhq.com/vapi/u-1/application')).toMatchObject({ kind: 'ashby', atsToken: 'vapi', atsJobId: 'u-1' });
    expect(targetFromUrl('https://himalayas.app/x')).toBeNull();
  });
  it('does not invent job ids', () => {
    expect(targetFromUrl('https://boards.greenhouse.io/gitlab')?.atsJobId).toBeUndefined();
    expect(targetFromUrl('https://boards.greenhouse.io/embed/job_board?for=acme')?.atsJobId).toBeUndefined();
    expect(targetFromUrl('https://jobs.lever.co/toptal')?.atsJobId).toBeUndefined();
  });
});

describe('resolveApplyTarget', () => {
  it('uses direct ATS links without a browser', async () => {
    expect((await resolveApplyTarget(job('https://jobs.lever.co/t/1'), null)).kind).toBe('lever');
  });
  it('follows an apply link from a board page', async () => {
    const t = await resolveApplyTarget(job('https://himalayas.app/j'), opener({
      'https://himalayas.app/j': { links: [{ href: 'https://himalayas.app/about', text: 'About' }, { href: 'https://jobs.ashbyhq.com/acme/9', text: 'Apply on company site' }] },
    }));
    expect(t).toMatchObject({ kind: 'ashby', atsToken: 'acme', atsJobId: '9' });
  });
  it('returns manual on a Cloudflare challenge', async () => {
    expect((await resolveApplyTarget(job('https://himalayas.app/j'), opener({ 'https://himalayas.app/j': { title: 'Just a moment...' } }))).kind).toBe('manual');
  });
  it('returns manual on browser errors and when no browser is available', async () => {
    expect((await resolveApplyTarget(job('https://himalayas.app/j'), opener({}, true))).kind).toBe('manual');
    expect((await resolveApplyTarget(job('https://himalayas.app/j'), null)).kind).toBe('manual');
  });
  it('returns other with the followed url for non-ATS sites', async () => {
    const t = await resolveApplyTarget(job('https://himalayas.app/j'), opener({
      'https://himalayas.app/j': { links: [{ href: 'https://careers.acme.com/apply/1', text: 'Apply' }] },
      'https://careers.acme.com/apply/1': {},
    }));
    expect(t).toEqual({ kind: 'other', url: 'https://careers.acme.com/apply/1' });
  });
});

describe('resolveApplyTarget board fallback', () => {
  const hit = { kind: 'ashby' as const, url: 'https://jobs.ashbyhq.com/clera/u-1', atsToken: 'clera', atsJobId: 'u-1' };
  const lookup = (r: typeof hit | null | Error) => {
    const calls: { company: string; title: string }[] = [];
    const fn = async (j: { company: string; title: string }) => { calls.push({ company: j.company, title: j.title }); if (r instanceof Error) throw r; return r; };
    return Object.assign(fn, { calls });
  };
  it('falls back to the company board on a Cloudflare challenge', async () => {
    const l = lookup(hit);
    const t = await resolveApplyTarget(job('https://himalayas.app/j'), opener({ 'https://himalayas.app/j': { title: 'Just a moment...' } }), l);
    expect(t).toEqual(hit);
    expect(l.calls).toEqual([{ company: 'Clera', title: 'Senior Voice AI Engineer' }]);
  });
  it('falls back without a browser, on browser errors, and for other (non-ATS) sites', async () => {
    expect(await resolveApplyTarget(job('https://himalayas.app/j'), null, lookup(hit))).toEqual(hit);
    expect(await resolveApplyTarget(job('https://himalayas.app/j'), opener({}, true), lookup(hit))).toEqual(hit);
    expect(await resolveApplyTarget(job('https://himalayas.app/j'), opener({
      'https://himalayas.app/j': { links: [{ href: 'https://careers.acme.com/apply/1', text: 'Apply' }] },
    }), lookup(hit))).toEqual(hit);
  });
  it('keeps manual/other when the board has no unique match or the lookup throws', async () => {
    expect(await resolveApplyTarget(job('https://himalayas.app/j'), null, lookup(null))).toEqual({ kind: 'manual', url: 'https://himalayas.app/j' });
    expect(await resolveApplyTarget(job('https://himalayas.app/j'), null, lookup(new Error('boom')))).toEqual({ kind: 'manual', url: 'https://himalayas.app/j' });
    const t = await resolveApplyTarget(job('https://himalayas.app/j'), opener({
      'https://himalayas.app/j': { links: [{ href: 'https://careers.acme.com/apply/1', text: 'Apply' }] },
    }), lookup(null));
    expect(t).toEqual({ kind: 'other', url: 'https://careers.acme.com/apply/1' });
  });
  it('does not consult the board when the direct/hop logic finds an ATS', async () => {
    const l = lookup(hit);
    expect((await resolveApplyTarget(job('https://jobs.lever.co/t/1'), null, l)).kind).toBe('lever');
    expect(l.calls).toEqual([]);
  });
});

describe('extractQuestions', () => {
  it('uses the Greenhouse API for greenhouse targets', async () => {
    const qs = await extractQuestions({ kind: 'greenhouse', url: 'u', atsToken: 'g', atsJobId: '1' }, null,
      async () => [{ id: 'q', label: 'Q', type: 'text', required: true }]);
    expect(qs).toEqual([{ id: 'q', label: 'Q', type: 'text', required: true }]);
  });
  it('reads the form for lever/ashby', async () => {
    const qs = await extractQuestions({ kind: 'lever', url: 'https://jobs.lever.co/t/1', atsToken: 't', atsJobId: '1' }, opener({}));
    expect(qs).toEqual([{ id: 'why', label: 'Why us?', type: 'textarea', required: true }]);
  });
  it('builds the lever form url from token and id, ignoring query strings', async () => {
    const seen: string[] = [];
    const o = opener({}); const rf = o.readForm;
    o.readForm = async (u) => { seen.push(u); return rf(u); };
    await extractQuestions({ kind: 'lever', url: 'https://jobs.lever.co/t/1?lever-source=x', atsToken: 't', atsJobId: '1' }, o);
    expect(seen).toEqual(['https://jobs.lever.co/t/1/apply']);
    expect(await extractQuestions({ kind: 'ashby', url: 'https://jobs.ashbyhq.com/t', atsToken: 't' }, o)).toEqual(COMMON_QUESTIONS);
    expect(seen).toHaveLength(1);
  });
  it('falls back to common questions for manual/other or on errors', async () => {
    expect(await extractQuestions({ kind: 'manual', url: 'u' }, null)).toEqual(COMMON_QUESTIONS);
    expect(await extractQuestions({ kind: 'greenhouse', url: 'u', atsToken: 'g', atsJobId: '1' }, null, async () => { throw new Error('500'); })).toEqual(COMMON_QUESTIONS);
  });
});
