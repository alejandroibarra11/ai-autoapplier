import { describe, it, expect } from 'vitest';
import { detectAts, findAtsInHtml } from '../src/sources/ats-detect';

describe('detectAts', () => {
  it.each([
    ['https://job-boards.greenhouse.io/vercel/jobs/123', { ats: 'greenhouse', token: 'vercel' }],
    ['https://boards.greenhouse.io/gitlab/jobs/1', { ats: 'greenhouse', token: 'gitlab' }],
    ['https://boards.greenhouse.io/embed/job_app?for=GitLab&token=1', { ats: 'greenhouse', token: 'gitlab' }],
    ['https://jobs.lever.co/toptal/abc/apply', { ats: 'lever', token: 'toptal' }],
    ['https://jobs.ashbyhq.com/elevenlabs/uuid', { ats: 'ashby', token: 'elevenlabs' }],
    ['https://apply.workable.com/huggingface/j/ABC/', { ats: 'workable', token: 'huggingface' }],
  ])('%s', (url, expected) => expect(detectAts(url)).toEqual(expected));

  it('returns null for non-ATS or invalid urls', () => {
    expect(detectAts('https://remoteok.com/remote-jobs/1')).toBeNull();
    expect(detectAts('not a url')).toBeNull();
    expect(detectAts('https://apply.workable.com/api/v3/x')).toBeNull();
  });
});

describe('findAtsInHtml', () => {
  it('finds the first ATS link', () => {
    const html = '<a href="https://remoteok.com">x</a> <a href="https://jobs.lever.co/acme/1">apply</a>';
    expect(findAtsInHtml(html)).toEqual({ ats: 'lever', token: 'acme', url: 'https://jobs.lever.co/acme/1' });
  });
  it('handles &amp; inside hrefs', () => {
    expect(findAtsInHtml('<a href="https://boards.greenhouse.io/embed/job_app?for=foo&amp;token=2">a</a>'))
      .toEqual({ ats: 'greenhouse', token: 'foo', url: 'https://boards.greenhouse.io/embed/job_app?for=foo&token=2' });
  });
  it('returns null when none', () => expect(findAtsInHtml('<p>no links</p>')).toBeNull());
});
