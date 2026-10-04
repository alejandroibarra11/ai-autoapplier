import { describe, it, expect } from 'vitest';
import { targetFromUrl, resolveApplyTarget } from '../src/apply/resolve';
import { extractQuestions } from '../src/apply/questions';
import { COMMON_QUESTIONS } from '../src/apply/common';
import type { PageOpener } from '../src/browser';

const job = (applyUrl: string, extra = {}) => ({ applyUrl, ats: null, atsToken: null, sourceJobId: 'x', source: 'himalayas', ...extra });
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
  it('falls back to common questions for manual/other or on errors', async () => {
    expect(await extractQuestions({ kind: 'manual', url: 'u' }, null)).toEqual(COMMON_QUESTIONS);
    expect(await extractQuestions({ kind: 'greenhouse', url: 'u', atsToken: 'g', atsJobId: '1' }, null, async () => { throw new Error('500'); })).toEqual(COMMON_QUESTIONS);
  });
});
