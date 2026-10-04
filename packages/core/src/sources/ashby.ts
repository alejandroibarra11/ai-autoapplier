import type { CompPeriod, NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';

interface AshbyComp { compensationType: string; interval: string; currencyCode: string | null; minValue: number | null; maxValue: number | null }
interface AshbyJob {
  id: string; title: string; jobUrl: string; applyUrl?: string; publishedAt: string;
  location?: string; secondaryLocations?: { location: string }[]; workplaceType?: string | null;
  isListed?: boolean; descriptionPlain?: string;
  compensation?: { summaryComponents?: AshbyComp[] } | null;
}

const PERIODS: Record<string, CompPeriod> = { '1 YEAR': 'year', '1 MONTH': 'month', '1 HOUR': 'hour' };

export function parseAshby(token: string, company: string, raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error(`ashby:${token}: unexpected response shape`);
  return (list as AshbyJob[]).filter((j) => j.isListed !== false).map((j) => {
    const salary = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary' && PERIODS[c.interval]);
    const locs = [j.location ?? '', ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean);
    return {
      source: 'ashby',
      sourceJobId: j.id,
      company,
      title: j.title.trim(),
      locationText: locs.join('; '),
      description: [j.workplaceType ? `Workplace: ${j.workplaceType}` : '', j.descriptionPlain ?? ''].filter(Boolean).join('\n\n').trim(),
      applyUrl: j.applyUrl ?? j.jobUrl,
      ats: 'ashby',
      atsToken: token,
      compMin: salary?.minValue ?? null,
      compMax: salary?.maxValue ?? null,
      compCurrency: salary?.currencyCode ?? null,
      compPeriod: salary ? PERIODS[salary.interval]! : null,
      postedAt: new Date(j.publishedAt),
    };
  });
}

export function ashbySource(c: { id: number; token: string; name: string }): Source {
  return {
    name: `ashby:${c.token}`,
    companyId: c.id,
    fetchJobs: async () =>
      parseAshby(c.token, c.name, await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.token)}?includeCompensation=true`)),
  };
}
