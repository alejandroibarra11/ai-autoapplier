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
export * from './answers';
export * from './score/schema';
export * from './apply/types';
export * from './apply/common';
export * from './apply/greenhouse-questions';
export * from './apply/form-fields';
export * from './db/schema';
export * from './db/client';
export * from './db/repo';

// Sources and pipeline
export * from './http';
export * from './sources';
export * from './sources/ats-detect';
export * from './pipeline/discover';
export * from './filter/rules';
export * from './pipeline/filter';

// LLM providers
export * from './llm/provider';
export * from './llm/anthropic';
export * from './llm/openai';
export * from './llm/factory';

export * from './score/prompt';
export * from './score/score';
export * from './pipeline/score';

export * from './eval/metrics';
