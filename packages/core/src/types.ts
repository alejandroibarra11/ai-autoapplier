export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workable';
export type CompPeriod = 'hour' | 'month' | 'year';

export const JOB_STATUSES = [
  'discovered', 'filtered_out', 'passed_rules', 'score_failed',
  'ineligible', 'low_score', 'awaiting_review', 'shortlisted', 'skipped',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface NormalizedJob {
  source: string;
  sourceJobId: string;
  company: string;
  title: string;
  locationText: string;
  description: string; // plain text
  applyUrl: string;
  ats: Ats | null;
  atsToken: string | null;
  compMin: number | null;
  compMax: number | null;
  compCurrency: string | null;
  compPeriod: CompPeriod | null;
  postedAt: Date;
}
