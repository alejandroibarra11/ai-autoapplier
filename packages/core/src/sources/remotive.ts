import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface RemotiveJob {
  id: number; url: string; title: string; company_name: string; publication_date: string;
  candidate_required_location?: string; salary?: string; description?: string;
}

function parseDate(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

export function parseRemotive(raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error('remotive: unexpected response shape');
  return (list as RemotiveJob[]).map((j) => {
    const html = j.description ?? '';
    const ats = findAtsInHtml(html);
    const salary = j.salary?.trim() ? `Salary: ${j.salary.trim()}\n\n` : '';
    return {
      source: 'remotive',
      sourceJobId: String(j.id),
      company: j.company_name.trim(),
      title: j.title.trim(),
      locationText: j.candidate_required_location?.trim() ?? '',
      description: salary + htmlToText(html),
      applyUrl: ats?.url ?? j.url,
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: null, compMax: null, compCurrency: null, compPeriod: null,
      postedAt: parseDate(j.publication_date),
    };
  });
}

export function remotiveSource(category: string): Source {
  return {
    name: `remotive:${category}`,
    fetchJobs: async () =>
      parseRemotive(await getJson(`https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`)),
  };
}
