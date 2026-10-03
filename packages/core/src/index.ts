export const VERSION = '0.1.0';

// Types
export type { Ats, CompPeriod, JobStatus, NormalizedJob } from './types';
export { JOB_STATUSES } from './types';

// Utilities
export { findRoot } from './root';
export { htmlToText, normalizeKey, dedupeKey, normalizeForMatch } from './text';
export { detectAts, findAtsInHtml } from './sources/ats-detect';
