import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface RokJob {
  id?: string; date: string; company: string; position: string; location?: string;
  salary_min?: number; salary_max?: number; url: string; apply_url?: string; description?: string; tags?: string[];
}

export function parseRemoteOk(raw: unknown): NormalizedJob[] {
  if (!Array.isArray(raw)) throw new Error('remoteok: unexpected response shape');
  return (raw as RokJob[]).filter((j) => j && j.id && j.position).map((j) => {
    const html = j.description ?? '';
    const ats = findAtsInHtml(html);
    const hasSalary = (j.salary_max ?? 0) > 0 || (j.salary_min ?? 0) > 0;
    const tags = j.tags?.length ? `\n\nTags: ${j.tags.join(', ')}` : '';
    return {
      source: 'remoteok',
      sourceJobId: String(j.id),
      company: j.company.trim(),
      title: j.position.trim(),
      locationText: j.location?.trim() ?? '',
      description: htmlToText(html) + tags,
      applyUrl: ats?.url ?? (j.apply_url || j.url),
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: hasSalary ? (j.salary_min || null) : null,
      compMax: hasSalary ? (j.salary_max || null) : null,
      compCurrency: hasSalary ? 'USD' : null,
      compPeriod: hasSalary ? 'year' : null,
      postedAt: new Date(j.date),
    };
  });
}

export function remoteOkSource(): Source {
  return { name: 'remoteok', fetchJobs: async () => parseRemoteOk(await getJson('https://remoteok.com/api')) };
}
