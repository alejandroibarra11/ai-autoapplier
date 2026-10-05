import type { NormalizedJob } from '../types';
import type { ApplyTarget } from './types';
import { parseGreenhouse } from '../sources/greenhouse';
import { parseLever } from '../sources/lever';
import { parseAshby } from '../sources/ashby';
import { targetFromUrl } from './resolve';

/**
 * Finds a job on its company's public ATS board (Greenhouse / Lever / Ashby JSON APIs) when the job-board page we
 * discovered it on can't be resolved (Cloudflare challenge, no ATS link). Read-only GETs; never guesses: the title
 * must match exactly one posting across every board tried.
 */

export type BoardAts = 'greenhouse' | 'lever' | 'ashby';
export interface KnownBoard { ats: BoardAts; token: string }
/** The subset of `fetch` the lookup uses; global `fetch` satisfies it. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface BoardLookupOptions { known?: KnownBoard[]; timeoutMs?: number }

const ATSES: BoardAts[] = ['greenhouse', 'lever', 'ashby'];
const DEFAULT_TIMEOUT_MS = 8_000;
const UA = 'ai-autoapplier/0.1 (personal job search)';
const NAME_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'labs', 'technologies', 'technology', 'co', 'io', 'hq', 'corp', 'corporation', 'gmbh']);

/** Words of a title / company name: accents folded, lowercase, `&` → and, anything non-alphanumeric is a separator. */
function words(s: string): string[] {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Board tokens to try for a company name: "Lemon.io" → lemonio, lemon-io, lemon. */
export function boardTokenCandidates(company: string): string[] {
  const w = words(company.replace(/&/g, ' '));
  if (!w.length) return [];
  const core = [...w];
  while (core.length > 1 && NAME_SUFFIXES.has(core[core.length - 1]!)) core.pop();
  return [...new Set([w.join(''), w.join('-'), core.join(''), core.join('-')])];
}

function companyKey(name: string): string {
  const w = words(name);
  while (w.length > 1 && NAME_SUFFIXES.has(w[w.length - 1]!)) w.pop();
  return w.join('');
}

/** Case / punctuation / whitespace-insensitive form of a title. */
export function normalizeTitle(title: string): string {
  return words(title).join(' ');
}

// Words a trailing location / work-mode qualifier is made of ("Remote", "Remote - US", "(Canada)", "| LATAM", "Contract").
const QUALIFIER_WORDS = new Set([
  'remote', 'hybrid', 'onsite', 'on', 'site', 'office', 'anywhere', 'worldwide', 'global', 'international', 'distributed',
  'wfh', 'first', 'friendly', 'only', 'based', 'in', 'and', 'or', 'any', 'location', 'locations', 'region', 'timezone',
  'timezones', 'time', 'zone', 'zones', 'contract', 'contractor', 'freelance', 'full', 'part', 'fulltime', 'parttime',
  'temporary', 'permanent', 'est', 'pst', 'cet', 'utc', 'gmt', 'us', 'usa', 'u', 's', 'uk', 'eu', 'emea', 'apac',
  'latam', 'amer', 'americas', 'america', 'north', 'south', 'central', 'latin', 'europe', 'european', 'asia', 'africa',
  'united', 'states', 'kingdom', 'canada', 'mexico', 'brazil', 'argentina', 'colombia', 'chile', 'peru', 'uruguay',
  'costa', 'rica', 'germany', 'france', 'spain', 'portugal', 'netherlands', 'poland', 'ireland', 'italy', 'romania',
  'india', 'australia', 'new', 'zealand', 'israel', 'japan', 'singapore', 'philippines', 'london', 'berlin', 'nyc',
  'york', 'san', 'francisco', 'sf', 'bay', 'area', 'toronto',
]);

function isQualifier(segment: string): boolean {
  const w = words(segment);
  return w.length > 0 && w.every((x) => QUALIFIER_WORDS.has(x));
}

const TRAILING_GROUP = /^(.*\S)\s*[([]([^()[\]]*)[)\]]\s*$/;
const TRAILING_SEGMENT = /^(.*\S)(?:\s+[-–—]\s+|\s*\|\s*|\s*,\s*)([^,|]+)$/;

/** A normalized title without trailing location / remote qualifiers: "Data Engineer - Remote, US" → "data engineer". */
export function titleCore(title: string): string {
  let t = title.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const re of [TRAILING_GROUP, TRAILING_SEGMENT]) {
      const m = re.exec(t);
      if (m && isQualifier(m[2]!) && normalizeTitle(m[1]!)) { t = m[1]!.trim(); changed = true; break; }
    }
  }
  return normalizeTitle(t);
}

interface Posting { ats: BoardAts; token: string; job: NormalizedJob }

function apiUrl(ats: BoardAts, token: string): string {
  const t = encodeURIComponent(token);
  if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`;
  if (ats === 'lever') return `https://api.lever.co/v0/postings/${t}?mode=json`;
  return `https://api.ashbyhq.com/posting-api/job-board/${t}`;
}

async function fetchBoard(fetchFn: FetchLike, ats: BoardAts, token: string, company: string, timeoutMs: number): Promise<NormalizedJob[]> {
  try {
    const res = await fetchFn(apiUrl(ats, token), { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) return [];
    const raw = await res.json();
    if (ats === 'greenhouse') return parseGreenhouse(token, raw);
    if (ats === 'lever') return parseLever(token, company, raw);
    return parseAshby(token, company, raw);
  } catch {
    return []; // no board, timeout, bad JSON or unexpected shape: this candidate has nothing to offer
  }
}

function postingUrl(p: Posting): string {
  const { token, job } = p;
  const id = job.sourceJobId;
  if (p.ats === 'greenhouse') {
    // A board hosted on Greenhouse keeps its own URL; a custom careers domain gets the always-available embed form.
    const own = targetFromUrl(job.applyUrl);
    if (own?.kind === 'greenhouse' && own.atsToken === token && own.atsJobId === id) return job.applyUrl;
    return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${encodeURIComponent(id)}`;
  }
  if (p.ats === 'lever') return `https://jobs.lever.co/${token}/${encodeURIComponent(id)}`;
  return `https://jobs.ashbyhq.com/${token}/${encodeURIComponent(id)}`;
}

function unique(list: Posting[]): Posting | null {
  const seen = new Map(list.map((p) => [`${p.ats}:${p.token}:${p.job.sourceJobId}`, p]));
  return seen.size === 1 ? [...seen.values()][0]! : null;
}

export async function lookupCompanyBoard(
  company: string, title: string, fetchFn: FetchLike, opts: BoardLookupOptions = {},
): Promise<ApplyTarget | null> {
  const wanted = normalizeTitle(title);
  if (!wanted || !company.trim()) return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Known boards (companies table) are trusted; derived slugs are guesses at a token, so a Greenhouse board that
  // names a different company is skipped.
  const boards = new Map<string, { ats: BoardAts; token: string; known: boolean }>();
  for (const k of opts.known ?? []) boards.set(`${k.ats}:${k.token.toLowerCase()}`, { ats: k.ats, token: k.token.toLowerCase(), known: true });
  for (const token of boardTokenCandidates(company)) {
    for (const ats of ATSES) if (!boards.has(`${ats}:${token}`)) boards.set(`${ats}:${token}`, { ats, token, known: false });
  }
  const key = companyKey(company);
  const results = await Promise.all([...boards.values()].map(async (b) => {
    const list = await fetchBoard(fetchFn, b.ats, b.token, company, timeoutMs);
    // parseGreenhouse falls back to the token when the board has no company_name
    const named = b.ats === 'greenhouse' && list.some((j) => j.company !== b.token);
    if (!b.known && named && !list.some((j) => companyKey(j.company) === key)) return [];
    return list.map((job): Posting => ({ ats: b.ats, token: b.token, job }));
  }));
  const postings = results.flat();

  const exact = postings.filter((p) => normalizeTitle(p.job.title) === wanted);
  const hit = exact.length ? unique(exact) : unique(postings.filter((p) => titleCore(p.job.title) === titleCore(title)));
  if (!hit) return null;
  return targetFromUrl(postingUrl(hit));
}
