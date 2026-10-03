import type { Ats } from '../types';

export function detectAts(url: string): { ats: Ats; token: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const first = seg[0]?.toLowerCase();

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (first === 'embed') {
      const forParam = u.searchParams.get('for');
      return forParam ? { ats: 'greenhouse', token: forParam.toLowerCase() } : null;
    }
    return first ? { ats: 'greenhouse', token: first } : null;
  }
  if (host === 'jobs.lever.co' && first) return { ats: 'lever', token: first };
  if (host === 'jobs.ashbyhq.com' && first) return { ats: 'ashby', token: first };
  if (host === 'apply.workable.com' && first && first !== 'api') return { ats: 'workable', token: first };
  return null;
}

export function findAtsInHtml(html: string): { ats: Ats; token: string; url: string } | null {
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const url = (m[1] ?? '').replace(/&amp;/g, '&');
    const hit = detectAts(url);
    if (hit) return { ...hit, url };
  }
  return null;
}
