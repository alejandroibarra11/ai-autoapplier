import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';

interface GhJob {
  id: number; title: string; absolute_url: string; first_published?: string | null; updated_at: string;
  location?: { name?: string } | null; content?: string | null; company_name?: string | null;
}

export function parseGreenhouse(token: string, raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error(`greenhouse:${token}: unexpected response shape`);
  return (list as GhJob[]).map((j) => ({
    source: 'greenhouse',
    sourceJobId: String(j.id),
    company: j.company_name?.trim() || token,
    title: j.title.trim(),
    locationText: j.location?.name?.trim() ?? '',
    description: htmlToText(j.content ?? ''),
    applyUrl: j.absolute_url,
    ats: 'greenhouse',
    atsToken: token,
    compMin: null, compMax: null, compCurrency: null, compPeriod: null,
    postedAt: new Date(j.first_published ?? j.updated_at),
  }));
}

export function greenhouseSource(c: { id: number; token: string }): Source {
  return {
    name: `greenhouse:${c.token}`,
    companyId: c.id,
    fetchJobs: async () =>
      parseGreenhouse(c.token, await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.token)}/jobs?content=true`)),
  };
}
