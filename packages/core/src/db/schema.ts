import { sqliteTable, integer, text, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import type { Ats, CompPeriod, JobStatus } from '../types';
import type { ScorePayload } from '../score/schema';

export const companies = sqliteTable('companies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ats: text('ats').$type<Ats>().notNull(),
  token: text('token').notNull(),
  source: text('source').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
}, (t) => [uniqueIndex('companies_ats_token').on(t.ats, t.token)]);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  company: text('company').notNull(),
  title: text('title').notNull(),
  locationText: text('location_text').notNull(),
  description: text('description').notNull(),
  applyUrl: text('apply_url').notNull(),
  ats: text('ats').$type<Ats>(),
  atsToken: text('ats_token'),
  compMin: real('comp_min'),
  compMax: real('comp_max'),
  compCurrency: text('comp_currency'),
  compPeriod: text('comp_period').$type<CompPeriod>(),
  postedAt: integer('posted_at', { mode: 'timestamp' }).notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  status: text('status').$type<JobStatus>().notNull().default('discovered'),
  filterReason: text('filter_reason'),
  lowPay: integer('low_pay', { mode: 'boolean' }).notNull().default(false),
  scoreAttempts: integer('score_attempts').notNull().default(0),
  notifiedAt: integer('notified_at', { mode: 'timestamp' }),
}, (t) => [uniqueIndex('jobs_dedupe_key').on(t.dedupeKey), index('jobs_status').on(t.status)]);

export const scores = sqliteTable('scores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  model: text('model').notNull(),
  payload: text('payload', { mode: 'json' }).$type<ScorePayload>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('scores_job').on(t.jobId)]);

export const jobEvents = sqliteTable('job_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  fromStatus: text('from_status').$type<JobStatus>(),
  toStatus: text('to_status').$type<JobStatus>().notNull(),
  note: text('note'),
  at: integer('at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('job_events_job').on(t.jobId)]);

export const llmUsage = sqliteTable('llm_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id'),
  stage: text('stage').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
});
