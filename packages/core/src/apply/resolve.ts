import type { JobRow } from '../db/repo';
import type { PageOpener } from '../browser';
import type { ApplyTarget } from './types';
import { detectAts } from '../sources/ats-detect';

const MAX_HOPS = 2;
const CHALLENGE = /just a moment|attention required|verify you are human/i;

export function targetFromUrl(url: string): ApplyTarget | null {
  const hit = detectAts(url);
  if (!hit || hit.ats === 'workable') return null;
  const u = new URL(url);
  const seg = u.pathname.split('/').filter(Boolean);
  let atsJobId: string | undefined;
  if (hit.ats === 'greenhouse') {
    const i = seg.indexOf('jobs');
    atsJobId = u.searchParams.get('token') ?? u.searchParams.get('gh_jid') ?? (i >= 0 ? seg[i + 1] : undefined);
  } else atsJobId = seg[1];
  return { kind: hit.ats, url, atsToken: hit.token, ...(atsJobId ? { atsJobId } : {}) };
}

function pickApplyLink(links: { href: string; text: string }[], from: string): string | null {
  const http = links.filter((l) => /^https?:/i.test(l.href) && l.href !== from);
  return http.find((l) => detectAts(l.href))?.href
    ?? http.find((l) => /apply/i.test(l.text))?.href
    ?? null;
}

export async function resolveApplyTarget(
  job: Pick<JobRow, 'applyUrl' | 'ats' | 'atsToken' | 'sourceJobId' | 'source'>, opener: PageOpener | null,
): Promise<ApplyTarget> {
  const direct = targetFromUrl(job.applyUrl);
  if (direct) return direct;
  const manual: ApplyTarget = { kind: 'manual', url: job.applyUrl };
  if (!opener) return manual;
  let url = job.applyUrl;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const v = await opener.visit(url);
      if (CHALLENGE.test(v.title)) return manual;
      const t = targetFromUrl(v.finalUrl);
      if (t) return t;
      const next = hop < MAX_HOPS ? pickApplyLink(v.links, v.finalUrl) : null;
      if (!next) return hop === 0 ? manual : { kind: 'other', url: v.finalUrl };
      const nt = targetFromUrl(next);
      if (nt) return nt;
      url = next;
    }
    return { kind: 'other', url };
  } catch {
    return manual;
  }
}
