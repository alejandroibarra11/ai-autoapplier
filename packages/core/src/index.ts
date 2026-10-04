export const VERSION = '0.1.0';

// Types
export type { Ats, CompPeriod, JobStatus, NormalizedJob } from './types';
export { JOB_STATUSES } from './types';

// Utilities
export { findRoot } from './root';
export { htmlToText, normalizeKey, dedupeKey, normalizeForMatch } from './text';
export { detectAts, findAtsInHtml } from './sources/ats-detect';

// Config, profile, scoring, database
export * from './config';
export * from './profile';
export * from './score/schema';
export * from './db/schema';
export * from './db/client';
export * from './db/repo';
