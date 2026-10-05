import { describe, it, expect } from 'vitest';
import { boardTokenCandidates, lookupCompanyBoard, normalizeTitle, titleCore, type FetchLike } from '../src/apply/board-lookup';
import { targetFromUrl } from '../src/apply/resolve';

const gh = (company: string, jobs: { id: number; title: string; url?: string }[]) => ({
  jobs: jobs.map((j) => ({ id: j.id, title: j.title, absolute_url: j.url ?? `https://job-boards.greenhouse.io/x/jobs/${j.id}`, updated_at: '2026-10-01T00:00:00Z', company_name: company })),
});
const lever = (jobs: { id: string; text: string }[]) => jobs.map((j) => ({ ...j, hostedUrl: `https://jobs.lever.co/x/${j.id}`, createdAt: 0 }));
const ashby = (jobs: { id: string; title: string; isListed?: boolean }[]) => ({
  jobs: jobs.map((j) => ({ ...j, jobUrl: `https://jobs.ashbyhq.com/x/${j.id}`, publishedAt: '2026-10-01T00:00:00Z' })),
});

/** Fake fetch: url → JSON body (200); anything else 404. Records every requested url. */
function fakeFetch(routes: Record<string, unknown>, opts: { throwFor?: RegExp } = {}): FetchLike & { seen: string[] } {
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(url);
    if (opts.throwFor?.test(url)) throw new Error('network down');
    const key = Object.keys(routes).find((k) => url.split('?')[0] === k);
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  }) as FetchLike & { seen: string[] };
  f.seen = seen;
  return f;
}
const GH = (t: string) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`;
const LV = (t: string) => `https://api.lever.co/v0/postings/${t}`;
const AB = (t: string) => `https://api.ashbyhq.com/posting-api/job-board/${t}`;

describe('boardTokenCandidates', () => {
  it('derives alnum, hyphenated and suffix-less slugs', () => {
    expect(boardTokenCandidates('Lemon.io')).toEqual(expect.arrayContaining(['lemonio', 'lemon-io', 'lemon']));
    expect(boardTokenCandidates('Fleetio')).toEqual(['fleetio']);
    expect(boardTokenCandidates('Xperteez Technology')).toEqual(expect.arrayContaining(['xperteeztechnology', 'xperteez-technology', 'xperteez']));
    expect(boardTokenCandidates('Acme Labs, Inc.')).toEqual(expect.arrayContaining(['acmelabsinc', 'acme-labs-inc', 'acme']));
    expect(boardTokenCandidates('Acme HQ')).toContain('acme');
  });
  it('never yields empty or duplicate tokens', () => {
    const c = boardTokenCandidates('Inc.');
    expect(c.every(Boolean)).toBe(true);
    expect(new Set(boardTokenCandidates('Lemon.io')).size).toBe(boardTokenCandidates('Lemon.io').length);
    expect(boardTokenCandidates('🌎 ')).toEqual([]);
  });
});

describe('title normalization', () => {
  it('is case, punctuation and whitespace insensitive', () => {
    expect(normalizeTitle('  Senior   Software Engineer,  Payments ')).toBe(normalizeTitle('senior software engineer - payments'));
    expect(normalizeTitle('🌎 Backend Engineer (Control Plane)')).toBe('backend engineer control plane');
    expect(normalizeTitle('Data & Analytics Engineer')).toBe(normalizeTitle('Data and Analytics Engineer'));
  });
  it('drops trailing location / remote qualifiers only', () => {
    expect(titleCore('Senior Voice AI Engineer (Remote)')).toBe('senior voice ai engineer');
    expect(titleCore('Senior Voice AI Engineer - Remote')).toBe('senior voice ai engineer');
    expect(titleCore('Senior Voice AI Engineer - Remote, US')).toBe('senior voice ai engineer');
    expect(titleCore('Senior Voice AI Engineer | LATAM')).toBe('senior voice ai engineer');
    expect(titleCore('Backend Engineer (Remote - United States)')).toBe('backend engineer');
    expect(titleCore('AI Engineer, Remote - Contract')).toBe('ai engineer');
    // a real part of the title is kept
    expect(titleCore('Software Engineer - Developer Experience')).toBe('software engineer developer experience');
    expect(titleCore('Backend Engineer (Control Plane)')).toBe('backend engineer control plane');
    expect(titleCore('Backend Engineer, Control Plane')).toBe('backend engineer control plane');
  });
});

describe('lookupCompanyBoard', () => {
  it('matches exactly one posting on a Greenhouse board and builds the target targetFromUrl would', async () => {
    const f = fakeFetch({ [GH('fleetio')]: gh('Fleetio', [
      { id: 11, title: 'Senior Software Engineer, Payments', url: 'https://job-boards.greenhouse.io/fleetio/jobs/11' },
      { id: 12, title: 'Senior Software Engineer, Platform', url: 'https://job-boards.greenhouse.io/fleetio/jobs/12' },
    ]) });
    const t = await lookupCompanyBoard('Fleetio', 'Senior Software Engineer - Payments', f);
    expect(t).toEqual({ kind: 'greenhouse', url: 'https://job-boards.greenhouse.io/fleetio/jobs/11', atsToken: 'fleetio', atsJobId: '11' });
    expect(targetFromUrl(t!.url)).toEqual(t);
  });
  it('uses the embed form url when the Greenhouse posting lives on a custom careers domain', async () => {
    const f = fakeFetch({ [GH('dremio')]: gh('Dremio', [{ id: 78, title: ' Software Engineer - Developer Experience', url: 'https://www.dremio.com/careers/job-postings/?gh_jid=78' }]) });
    const t = await lookupCompanyBoard('Dremio', 'Software Engineer - Developer Experience', f);
    expect(t).toEqual({ kind: 'greenhouse', url: 'https://job-boards.greenhouse.io/embed/job_app?for=dremio&token=78', atsToken: 'dremio', atsJobId: '78' });
    expect(targetFromUrl(t!.url)).toEqual(t);
  });
  it('matches Ashby and Lever postings', async () => {
    const a = await lookupCompanyBoard('Clera', 'Senior Voice AI Engineer', fakeFetch({ [AB('clera')]: ashby([
      { id: 'u-1', title: 'Senior Voice AI Engineer' }, { id: 'u-2', title: 'Senior Software Engineer, Voice AI / Backend' },
    ]) }));
    expect(a).toEqual({ kind: 'ashby', url: 'https://jobs.ashbyhq.com/clera/u-1', atsToken: 'clera', atsJobId: 'u-1' });
    expect(targetFromUrl(a!.url)).toEqual(a);
    const l = await lookupCompanyBoard('Acme', 'Data Engineer (Remote)', fakeFetch({ [LV('acme')]: lever([{ id: 'p-9', text: 'Data Engineer' }]) }));
    expect(l).toEqual({ kind: 'lever', url: 'https://jobs.lever.co/acme/p-9', atsToken: 'acme', atsJobId: 'p-9' });
    expect(targetFromUrl(l!.url)).toEqual(l);
  });
  it('returns null when the title appears more than once (never guesses)', async () => {
    const f = fakeFetch({ [GH('tailscale')]: gh('Tailscale', [
      { id: 1, title: 'Backend Engineer, Control Plane' }, { id: 2, title: 'Backend Engineer, Control Plane' },
    ]) });
    expect(await lookupCompanyBoard('Tailscale', 'Backend Engineer, Control Plane', f)).toBeNull();
  });
  it('counts matches across all boards: the same title on two ATSes is ambiguous', async () => {
    const f = fakeFetch({
      [GH('acme')]: gh('Acme', [{ id: 1, title: 'Data Engineer', url: 'https://job-boards.greenhouse.io/acme/jobs/1' }]),
      [AB('acme')]: ashby([{ id: 'a', title: 'Data Engineer' }]),
    });
    expect(await lookupCompanyBoard('Acme', 'Data Engineer', f)).toBeNull();
  });
  it('prefers an exact title over a qualifier-stripped one', async () => {
    const f = fakeFetch({ [AB('acme')]: ashby([{ id: 'a', title: 'Data Engineer' }, { id: 'b', title: 'Data Engineer (Remote)' }]) });
    expect((await lookupCompanyBoard('Acme', 'Data Engineer (Remote)', f))?.atsJobId).toBe('b');
    expect((await lookupCompanyBoard('Acme', 'Data Engineer', f))?.atsJobId).toBe('a');
    // nothing exact, two qualifier matches → ambiguous
    expect(await lookupCompanyBoard('Acme', 'Data Engineer - Remote, US', f)).toBeNull();
  });
  it('returns null when no board exists or no title matches', async () => {
    expect(await lookupCompanyBoard('Pavago', 'Full-Stack Developer - Next.js & Python', fakeFetch({}))).toBeNull();
    const f = fakeFetch({ [GH('fleetio')]: gh('Fleetio', [{ id: 1, title: 'Senior Software Engineer, Marketplace Payments' }]) });
    expect(await lookupCompanyBoard('Fleetio', 'Senior Software Engineer, Payments', f)).toBeNull();
  });
  it('ignores unlisted Ashby postings', async () => {
    const f = fakeFetch({ [AB('acme')]: ashby([{ id: 'a', title: 'Data Engineer', isListed: false }]) });
    expect(await lookupCompanyBoard('Acme', 'Data Engineer', f)).toBeNull();
  });
  it('skips a Greenhouse board that belongs to a different company', async () => {
    const f = fakeFetch({ [GH('fueled')]: gh('Fueled Brands Holdings', [{ id: 1, title: 'Senior Full Stack Engineer', url: 'https://job-boards.greenhouse.io/fueled/jobs/1' }]) });
    expect(await lookupCompanyBoard('Fueled', 'Senior Full Stack Engineer', f)).toBeNull();
  });
  it('tries known tokens from the companies table first-class, alongside derived slugs', async () => {
    const f = fakeFetch({ [GH('automatticcareers')]: gh('Automattic', [{ id: 5, title: 'Code Wrangler', url: 'https://job-boards.greenhouse.io/automatticcareers/jobs/5' }]) });
    const t = await lookupCompanyBoard('Automattic', 'Code Wrangler', f, { known: [{ ats: 'greenhouse', token: 'automatticcareers' }] });
    expect(t).toMatchObject({ kind: 'greenhouse', atsToken: 'automatticcareers', atsJobId: '5' });
    expect(f.seen).toContain(GH('automattic'));
  });
  it('survives network errors and bad JSON on some boards', async () => {
    const f = fakeFetch({ [GH('acme')]: { nope: true }, [AB('acme')]: ashby([{ id: 'a', title: 'Data Engineer' }]) }, { throwFor: /lever/ });
    expect((await lookupCompanyBoard('Acme', 'Data Engineer', f))?.atsJobId).toBe('a');
  });
  it('returns null for empty company or title without fetching', async () => {
    const f = fakeFetch({});
    expect(await lookupCompanyBoard('', 'Data Engineer', f)).toBeNull();
    expect(await lookupCompanyBoard('Acme', '  ', f)).toBeNull();
    expect(f.seen).toEqual([]);
  });
});
