import type { CompPeriod, NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface HimJob {
  guid: string; title: string; companyName: string; locationRestrictions?: string[]; timezoneRestrictions?: unknown[];
  minSalary?: number | null; maxSalary?: number | null; currency?: string | null; salaryPeriod?: string | null;
  pubDate: number; applicationLink: string; description?: string; employmentType?: string;
}

const PERIODS: Record<string, CompPeriod> = { annual: 'year', monthly: 'month', hourly: 'hour' };

export function parseHimalayas(raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error('himalayas: unexpected response shape');
  return (list as HimJob[]).map((j) => {
    const html = j.description ?? '';
    const ats = findAtsInHtml(html);
    const period = j.salaryPeriod ? PERIODS[j.salaryPeriod] ?? null : null;
    const hasComp = period !== null && (j.minSalary != null || j.maxSalary != null);
    const restrictions = j.locationRestrictions ?? [];
    return {
      source: 'himalayas',
      sourceJobId: j.guid,
      company: j.companyName.trim(),
      title: j.title.trim(),
      // No restrictions is board metadata, not a statement by the employer: keep it out of locationText
      // (quotable evidence) and mark it so evidenceText() drops it.
      locationText: restrictions.join('; '),
      description: [
        restrictions.length ? '' : 'Board metadata: no location restrictions listed',
        j.employmentType ? `Employment type: ${j.employmentType}` : '',
        htmlToText(html),
      ].filter(Boolean).join('\n\n'),
      applyUrl: ats?.url ?? j.applicationLink,
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: hasComp ? j.minSalary ?? null : null,
      compMax: hasComp ? j.maxSalary ?? null : null,
      compCurrency: hasComp ? j.currency ?? null : null,
      compPeriod: hasComp ? period : null,
      postedAt: new Date(j.pubDate * 1000),
    };
  });
}

export function himalayasSource(query: string, country: string, pages: number): Source {
  return {
    name: `himalayas:${query}`,
    fetchJobs: async () => {
      const out: NormalizedJob[] = [];
      for (let p = 0; p < pages; p++) {
        const url = `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&country=${encodeURIComponent(country)}&sort=recent&offset=${p * 20}`;
        const page = parseHimalayas(await getJson(url));
        out.push(...page);
        if (page.length < 20) break;
      }
      return out;
    },
  };
}
