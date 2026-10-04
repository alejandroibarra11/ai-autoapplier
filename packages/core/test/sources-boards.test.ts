import { describe, it, expect } from 'vitest';
import { parseRemoteOk } from '../src/sources/remoteok';
import { parseRemotive } from '../src/sources/remotive';
import { parseHimalayas } from '../src/sources/himalayas';
import { parseWwr } from '../src/sources/wwr';

describe('parseRemoteOk', () => {
  const raw = [
    { last_updated: 1, legal: 'terms' },
    {
      id: '1137460', epoch: 1790945581, date: '2026-10-02T12:53:01+00:00', company: 'Acme', position: 'Senior LLM Engineer',
      location: 'LATAM', salary_min: 90000, salary_max: 120000, url: 'https://remoteOK.com/remote-jobs/1137460',
      apply_url: 'https://remoteOK.com/remote-jobs/1137460',
      description: '<p><strong>Application URL</strong><br /><a href="https://jobs.ashbyhq.com/acme/9">apply</a></p><p>Build RAG.</p>',
      tags: ['ai', 'llm'],
    },
    { id: '2', epoch: 1790945581, date: '2026-10-02T12:53:01+00:00', company: 'B', position: 'Dev', location: '', salary_min: 0, salary_max: 0, url: 'https://remoteok.com/2', apply_url: '', description: '', tags: [] },
  ];

  it('skips the legal row, extracts ATS link, maps salary', () => {
    const list = parseRemoteOk(raw);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      source: 'remoteok', sourceJobId: '1137460', company: 'Acme', title: 'Senior LLM Engineer', locationText: 'LATAM',
      applyUrl: 'https://jobs.ashbyhq.com/acme/9', ats: 'ashby', atsToken: 'acme',
      compMin: 90000, compMax: 120000, compCurrency: 'USD', compPeriod: 'year',
    });
    expect(list[0]!.description).toContain('Build RAG.');
    expect(list[0]!.description).toContain('Tags: ai, llm');
    expect(list[1]).toMatchObject({ compMin: null, compMax: null, compPeriod: null, applyUrl: 'https://remoteok.com/2', ats: null });
  });
});

describe('parseRemotive', () => {
  it('normalizes and treats tz-less dates as UTC', () => {
    const [j] = parseRemotive({ jobs: [{
      id: 2091132, url: 'https://remotive.com/remote-jobs/x-2091132', title: 'Senior back-end Engineer', company_name: 'Lemon.io',
      publication_date: '2026-09-30T13:15:26', candidate_required_location: 'USA, Mexico', salary: '$50-70/hr',
      description: '<p>Work remote.</p>',
    }] });
    expect(j).toMatchObject({ source: 'remotive', sourceJobId: '2091132', company: 'Lemon.io', locationText: 'USA, Mexico', ats: null });
    expect(j!.postedAt.toISOString()).toBe('2026-09-30T13:15:26.000Z');
    expect(j!.description).toContain('Salary: $50-70/hr');
    expect(j!.description).toContain('Work remote.');
  });
});

describe('parseHimalayas', () => {
  it('maps restrictions, salary period and unix dates', () => {
    const list = parseHimalayas({ jobs: [
      { guid: 'g1', title: 'AI Engineer', companyName: 'Lingo', locationRestrictions: [], timezoneRestrictions: [], minSalary: 100, maxSalary: 150,
        currency: 'USD', salaryPeriod: 'hourly', pubDate: 1791052678, applicationLink: 'https://himalayas.app/x', description: '<p>LLM work</p>', employmentType: 'Contractor' },
      { guid: 'g2', title: 'ETL', companyName: 'Seq', locationRestrictions: ['Mexico', 'Colombia'], timezoneRestrictions: [], minSalary: null, maxSalary: null,
        currency: null, salaryPeriod: null, pubDate: 1791036915, applicationLink: 'https://himalayas.app/y', description: '', employmentType: 'Full Time' },
    ] });
    expect(list[0]).toMatchObject({ source: 'himalayas', sourceJobId: 'g1', company: 'Lingo', locationText: 'Anywhere',
      compMin: 100, compMax: 150, compCurrency: 'USD', compPeriod: 'hour' });
    expect(list[0]!.description).toContain('Employment type: Contractor');
    expect(list[0]!.postedAt.getTime()).toBe(1791052678 * 1000);
    expect(list[1]).toMatchObject({ locationText: 'Mexico; Colombia', compPeriod: null });
  });
});

describe('parseWwr', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Pinterest: Senior Full Stack Engineer</title><region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/pinterest-sfse</link><guid>https://weworkremotely.com/remote-jobs/pinterest-sfse</guid>
      <pubDate>Thu, 02 Oct 2026 10:00:00 +0000</pubDate>
      <description>&lt;p&gt;Apply at &lt;a href="https://boards.greenhouse.io/pinterest/jobs/1"&gt;here&lt;/a&gt;&lt;/p&gt;</description></item>
  </channel></rss>`;

  it('parses a single-item feed', () => {
    const [j] = parseWwr(xml);
    expect(j).toMatchObject({
      source: 'wwr', company: 'Pinterest', title: 'Senior Full Stack Engineer', locationText: 'Anywhere in the World',
      applyUrl: 'https://boards.greenhouse.io/pinterest/jobs/1', ats: 'greenhouse', atsToken: 'pinterest',
      sourceJobId: 'https://weworkremotely.com/remote-jobs/pinterest-sfse',
    });
    expect(j!.postedAt.toISOString()).toBe('2026-10-02T10:00:00.000Z');
    expect(j!.description).toContain('Apply at here');
  });

  it('returns [] for an empty channel', () => {
    expect(parseWwr('<rss><channel></channel></rss>')).toEqual([]);
  });
});
