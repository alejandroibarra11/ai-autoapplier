import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { companies, jobEvents, jobs, llmUsage, scores } from './schema';
import type { Ats, JobStatus, NormalizedJob } from '../types';
import type { ScorePayload } from '../score/schema';
import { dedupeKey } from '../text';

export type JobRow = typeof jobs.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;

export interface StatusPatch { filterReason?: string | null; lowPay?: boolean; scoreAttempts?: number }
export interface UsageInput {
  jobId: number | null; stage: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number;
}

export function insertJobs(db: Db, list: NormalizedJob[], now = new Date()): number {
  return db.transaction((tx) => {
    let n = 0;
    for (const j of list) {
      const r = tx.insert(jobs)
        .values({ ...j, dedupeKey: dedupeKey(j.company, j.title), fetchedAt: now, updatedAt: now })
        .onConflictDoNothing({ target: jobs.dedupeKey })
        .run();
      n += r.changes;
    }
    return n;
  });
}

export function getJob(db: Db, id: number): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobsByStatus(db: Db, statuses: JobStatus[], limit = 500): JobRow[] {
  return db.select().from(jobs).where(inArray(jobs.status, statuses))
    .orderBy(desc(jobs.postedAt), asc(jobs.id)).limit(limit).all();
}

export function listJobsForScoring(db: Db, maxAttempts: number, limit: number): JobRow[] {
  return db.select().from(jobs)
    .where(and(inArray(jobs.status, ['passed_rules', 'score_failed']), lt(jobs.scoreAttempts, maxAttempts)))
    .orderBy(desc(jobs.postedAt), asc(jobs.id)).limit(limit).all();
}

export function listUnnotified(db: Db, limit: number): JobRow[] {
  return db.select().from(jobs)
    .where(and(eq(jobs.status, 'awaiting_review'), isNull(jobs.notifiedAt)))
    .orderBy(desc(jobs.postedAt), asc(jobs.id)).limit(limit).all();
}

export function setStatus(
  db: Db, jobId: number, to: JobStatus, note: string | null = null, patch: StatusPatch = {}, now = new Date(),
): void {
  db.transaction((tx) => {
    const cur = tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (!cur) throw new Error(`job ${jobId} not found`);
    tx.update(jobs).set({ status: to, updatedAt: now, ...patch }).where(eq(jobs.id, jobId)).run();
    tx.insert(jobEvents).values({ jobId, fromStatus: cur.status, toStatus: to, note, at: now }).run();
  });
}

export function markNotified(db: Db, jobId: number, now = new Date()): void {
  db.update(jobs).set({ notifiedAt: now }).where(eq(jobs.id, jobId)).run();
}

export function insertScore(db: Db, jobId: number, model: string, payload: ScorePayload, now = new Date()): void {
  db.insert(scores).values({ jobId, model, payload, createdAt: now }).run();
}

export function latestScore(db: Db, jobId: number): ScorePayload | undefined {
  return db.select({ payload: scores.payload }).from(scores).where(eq(scores.jobId, jobId))
    .orderBy(desc(scores.id)).limit(1).get()?.payload;
}

export function recordUsage(db: Db, u: UsageInput, now = new Date()): void {
  db.insert(llmUsage).values({ ...u, at: now }).run();
}

export function spendSince(db: Db, since: Date): number {
  const r = db.select({ total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage).where(gte(llmUsage.at, since)).get();
  return r?.total ?? 0;
}

export function upsertCompany(db: Db, c: { ats: Ats; token: string; name: string; source: string }): void {
  db.insert(companies).values({ ...c, token: c.token.toLowerCase() })
    .onConflictDoNothing({ target: [companies.ats, companies.token] }).run();
}

export function listActiveCompanies(db: Db): CompanyRow[] {
  return db.select().from(companies).where(eq(companies.active, true)).orderBy(asc(companies.id)).all();
}

export function deactivateCompany(db: Db, id: number): void {
  db.update(companies).set({ active: false }).where(eq(companies.id, id)).run();
}

export function markPolled(db: Db, id: number, now = new Date()): void {
  db.update(companies).set({ lastPolledAt: now }).where(eq(companies.id, id)).run();
}

export function listEvents(db: Db, jobId: number): JobEventRow[] {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(asc(jobEvents.id)).all();
}

export function countByStatus(db: Db): { status: JobStatus; count: number }[] {
  return db.select({ status: jobs.status, count: sql<number>`count(*)` }).from(jobs)
    .groupBy(jobs.status).orderBy(asc(jobs.status)).all();
}

export function countBySource(db: Db): { source: string; count: number }[] {
  return db.select({ source: jobs.source, count: sql<number>`count(*)` }).from(jobs)
    .groupBy(jobs.source).orderBy(desc(sql`count(*)`)).all();
}

export function spendByDay(db: Db, days = 14): { day: string; costUsd: number }[] {
  const day = sql<string>`date(${llmUsage.at}, 'unixepoch')`;
  return db.select({ day, costUsd: sql<number>`sum(${llmUsage.costUsd})` }).from(llmUsage)
    .groupBy(day).orderBy(desc(day)).limit(days).all();
}
