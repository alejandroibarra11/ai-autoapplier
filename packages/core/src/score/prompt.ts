import type { JobRow } from '../db/repo';

export const MAX_POSTING_CHARS = 24_000;

type ContextJob = Pick<JobRow, 'title' | 'company' | 'locationText' | 'description' | 'compMin' | 'compMax' | 'compCurrency' | 'compPeriod'>;

export function formatComp(j: Pick<JobRow, 'compMin' | 'compMax' | 'compCurrency' | 'compPeriod'>): string | null {
  if (j.compMin === null && j.compMax === null) return null;
  const range = j.compMin !== null && j.compMax !== null && j.compMin !== j.compMax
    ? `${j.compMin}–${j.compMax}` : String(j.compMax ?? j.compMin);
  return `${j.compCurrency ?? ''} ${range}${j.compPeriod ? ` per ${j.compPeriod}` : ''}`.trim();
}

function truncatedDescription(description: string): string {
  return description.length > MAX_POSTING_CHARS ? `${description.slice(0, MAX_POSTING_CHARS)}\n[description truncated]` : description;
}

export const BOARD_METADATA_PREFIX = 'Board metadata:';

function withoutBoardMetadata(description: string): string {
  return description.split('\n').filter((l) => !l.trimStart().startsWith(BOARD_METADATA_PREFIX)).join('\n');
}

/** Text the eligibility quote is checked against: Location line + description, minus synthetic board metadata. */
export function evidenceText(job: Pick<JobRow, 'locationText' | 'description'>): string {
  return `${job.locationText ? `Location: ${job.locationText}\n\n` : ''}${truncatedDescription(withoutBoardMetadata(job.description))}`;
}

export function jobContextText(job: ContextJob): string {
  const comp = formatComp(job);
  const desc = truncatedDescription(job.description);
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.locationText || 'not stated'}`,
    `Compensation: ${comp ?? 'not stated'}`,
    '',
    desc,
  ].join('\n');
}

export function buildScoringSystem(profileText: string): string {
  return `You screen job postings for one candidate. Be strict and literal.

CANDIDATE PROFILE
${profileText}

ELIGIBILITY (most important)
The candidate lives in Mexico, is NOT authorized to work in the US, and can only work remotely as a contractor (own entity or an EOR such as Deel) or for an employer that hires in Mexico/LATAM.
- eligible: the posting explicitly allows Mexico, LATAM, the Americas, worldwide/anywhere, or international contractors.
- likely: fully remote with no stated country restriction and nothing implying US-only.
- unlikely: signals of US-only without saying so (US benefits like 401k/health insurance, US payroll, list of US states) or remote limited to another region (e.g. Europe-only, Canada-only).
- ineligible: explicitly requires US work authorization, residence, citizenship, clearance, W-2, on-site/hybrid work, or a non-Americas region only.
eligibilityEvidence MUST be an exact quote copied character-for-character from the posting text (the Location line counts) that supports the decision. At most ~200 characters. Never paraphrase. For eligible, the quote must explicitly name the allowed region or arrangement (Mexico, LATAM, the Americas, worldwide/anywhere, international contractors). For likely, you may quote the Location line. If no quote supports eligible or likely, answer unlikely.

FIT
fitScore 0-100 = how strong this candidate would look to the hiring manager, using only facts in the profile. 80+ strong match on core stack and seniority; 60-79 solid with gaps; below 60 weak. Penalize hard requirements the candidate lacks (e.g. 8+ years, PhD, specific domain).
roleCategory: ai (LLM/AI/ML engineering), fullstack, voice (voice/conversational AI), other.
matched / missing: short phrases, max 6 each.
redFlags: concerning signals (unpaid trial, commission-only, vague company, crypto trading, extreme hours). Empty if none.
compEstimate: pay exactly as stated in the posting, else null.`;
}

export function buildScoringUser(context: string): string {
  return `JOB POSTING\n<posting>\n${context}\n</posting>`;
}
