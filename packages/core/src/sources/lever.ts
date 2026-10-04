import type { CompPeriod, NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';

interface LeverJob {
  id: string; text: string; hostedUrl: string; applyUrl?: string; createdAt: number;
  categories?: { location?: string; allLocations?: string[] };
  workplaceType?: string; descriptionPlain?: string; additionalPlain?: string;
  lists?: { text: string; content: string }[];
  salaryRange?: { min: number; max: number; currency: string; interval: string } | null;
}

function leverPeriod(interval: string): CompPeriod {
  if (interval.includes('hour')) return 'hour';
  if (interval.includes('month')) return 'month';
  return 'year';
}

export function parseLever(token: string, company: string, raw: unknown): NormalizedJob[] {
  if (!Array.isArray(raw)) throw new Error(`lever:${token}: unexpected response shape`);
  return (raw as LeverJob[]).map((j) => {
    const locs = j.categories?.allLocations?.length ? j.categories.allLocations : [j.categories?.location ?? ''];
    const parts = [
      j.workplaceType ? `Workplace: ${j.workplaceType}` : '',
      j.descriptionPlain ?? '',
      ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`),
      j.additionalPlain ?? '',
    ].filter(Boolean);
    const s = j.salaryRange;
    return {
      source: 'lever',
      sourceJobId: j.id,
      company,
      title: j.text.trim(),
      locationText: locs.filter(Boolean).join('; '),
      description: parts.join('\n\n').trim(),
      applyUrl: j.applyUrl ?? j.hostedUrl,
      ats: 'lever',
      atsToken: token,
      compMin: s?.min ?? null,
      compMax: s?.max ?? null,
      compCurrency: s?.currency ?? null,
      compPeriod: s ? leverPeriod(s.interval) : null,
      postedAt: new Date(j.createdAt),
    };
  });
}

export function leverSource(c: { id: number; token: string; name: string }): Source {
  return {
    name: `lever:${c.token}`,
    companyId: c.id,
    fetchJobs: async () =>
      parseLever(c.token, c.name, await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(c.token)}?mode=json`)),
  };
}
