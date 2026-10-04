import { describe, it, expect } from 'vitest';
import { parseGreenhouse } from '../src/sources/greenhouse';
import { parseLever } from '../src/sources/lever';
import { parseAshby } from '../src/sources/ashby';

describe('parseGreenhouse', () => {
  const raw = { jobs: [{
    id: 6136160004, title: ' Senior AI Engineer ', absolute_url: 'https://job-boards.greenhouse.io/vercel/jobs/6136160004',
    first_published: '2026-09-30T12:50:10-04:00', updated_at: '2026-10-01T13:34:54-04:00',
    location: { name: 'Remote - Americas' }, company_name: 'Vercel',
    content: '&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Build agents &amp;amp; RAG.&lt;/p&gt;',
  }] };

  it('normalizes jobs and decodes escaped html', () => {
    const [j] = parseGreenhouse('vercel', raw);
    expect(j).toMatchObject({
      source: 'greenhouse', sourceJobId: '6136160004', company: 'Vercel', title: 'Senior AI Engineer',
      locationText: 'Remote - Americas', ats: 'greenhouse', atsToken: 'vercel',
      applyUrl: 'https://job-boards.greenhouse.io/vercel/jobs/6136160004', compMax: null,
    });
    expect(j!.description).toContain('Build agents & RAG.');
    expect(j!.description).not.toContain('&lt;');
    expect(j!.postedAt.toISOString()).toBe('2026-09-30T16:50:10.000Z');
  });

  it('falls back to updated_at and token when fields are missing', () => {
    const [j] = parseGreenhouse('acme', { jobs: [{ id: 1, title: 'X', absolute_url: 'u', updated_at: '2026-10-01T00:00:00Z', content: null, location: null }] });
    expect(j!.company).toBe('acme');
    expect(j!.locationText).toBe('');
    expect(j!.description).toBe('');
    expect(j!.postedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('throws on unexpected shape', () => {
    expect(() => parseGreenhouse('x', { nope: true })).toThrow(/greenhouse/);
  });
});

describe('parseLever', () => {
  const raw = [{
    id: 'abc', text: 'Full Stack Engineer', hostedUrl: 'https://jobs.lever.co/toptal/abc',
    applyUrl: 'https://jobs.lever.co/toptal/abc/apply', createdAt: 1790000000000,
    categories: { location: 'Mexico', allLocations: ['Mexico', 'Brazil'] }, workplaceType: 'remote',
    descriptionPlain: 'Intro text.', lists: [{ text: 'Requirements', content: '<li>TypeScript</li><li>NestJS</li>' }],
    additionalPlain: 'Contractor role.', salaryRange: { min: 50, max: 70, currency: 'USD', interval: 'per-hour-wage' },
  }];

  it('normalizes jobs including lists and salary', () => {
    const [j] = parseLever('toptal', 'Toptal', raw);
    expect(j).toMatchObject({
      source: 'lever', sourceJobId: 'abc', company: 'Toptal', title: 'Full Stack Engineer',
      locationText: 'Mexico; Brazil', applyUrl: 'https://jobs.lever.co/toptal/abc/apply',
      ats: 'lever', atsToken: 'toptal', compMin: 50, compMax: 70, compCurrency: 'USD', compPeriod: 'hour',
    });
    expect(j!.description).toContain('Workplace: remote');
    expect(j!.description).toContain('Requirements');
    expect(j!.description).toContain('NestJS');
    expect(j!.description).toContain('Contractor role.');
    expect(j!.postedAt.getTime()).toBe(1790000000000);
  });

  it('maps yearly salary and missing salary', () => {
    const [a] = parseLever('t', 'T', [{ ...raw[0], salaryRange: { min: 1, max: 2, currency: 'USD', interval: 'per-year-salary' } }]);
    expect(a!.compPeriod).toBe('year');
    const [b] = parseLever('t', 'T', [{ ...raw[0], salaryRange: null }]);
    expect(b!.compMax).toBeNull();
    expect(b!.compPeriod).toBeNull();
  });
});

describe('parseAshby', () => {
  const raw = { jobs: [
    {
      id: 'u1', title: 'Voice AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/vapi/u1', applyUrl: 'https://jobs.ashbyhq.com/vapi/u1/application',
      publishedAt: '2026-10-01T17:12:35.753+00:00', location: 'Remote (US)', secondaryLocations: [{ location: 'Remote (Mexico)' }],
      workplaceType: 'Remote', isRemote: true, isListed: true, descriptionPlain: 'Build voice agents.',
      compensation: { summaryComponents: [
        { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
        { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150000, maxValue: 200000 },
      ] },
    },
    { id: 'u2', title: 'Hidden', jobUrl: 'x', publishedAt: '2026-10-01T00:00:00Z', isListed: false, descriptionPlain: '' },
  ] };

  it('normalizes listed jobs with compensation and secondary locations', () => {
    const list = parseAshby('vapi', 'Vapi', raw);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: 'ashby', sourceJobId: 'u1', company: 'Vapi', locationText: 'Remote (US); Remote (Mexico)',
      applyUrl: 'https://jobs.ashbyhq.com/vapi/u1/application', compMin: 150000, compMax: 200000,
      compCurrency: 'USD', compPeriod: 'year', ats: 'ashby', atsToken: 'vapi',
    });
    expect(list[0]!.description).toContain('Workplace: Remote');
    expect(list[0]!.description).toContain('Build voice agents.');
  });
});
