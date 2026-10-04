import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from './client';
import { companies, drafts, jobEvents, jobs, llmUsage, scores, submissions } from './schema';
import type { FillPlan, SubmissionResult } from '../submit/types';
import type { DraftAnswer, FormQuestion, CvSelection, ResolvedKind } from '../apply/types';
import type { Ats, JobStatus, NormalizedJob } from '../types';
import type { ScorePayload } from '../score/schema';
import { dedupeKey } from '../text';

export type JobRow = typeof jobs.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;

export interface StatusPatch { filterReason?: string | null; lowPay?: boolean; scoreAttempts?: number; draftAttempts?: number; draftFailureNotifiedAt?: Date | null }
export interface UsageInput {
  jobId: number | null; stage: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number;
}

export interface InsertResult { inserted: number; skipped: number }

/**
 * Inserts new jobs. Identity is (source, sourceJobId); a row is also dropped when the same
 * company|title|location already came from a different source. Rows with an invalid postedAt
 * are skipped (counted) instead of failing the whole batch.
 */
export function insertJobs(db: Db, list: NormalizedJob[], now = new Date()): InsertResult {
  return db.transaction((tx) => {
    let n = 0;
    let skipped = 0;
    for (const j of list) {
      if (!(j.postedAt instanceof Date) || !Number.isFinite(j.postedAt.getTime())) { skipped += 1; continue; }
      const key = dedupeKey(j.company, j.title, j.locationText);
      const crossSource = tx.select({ id: jobs.id }).from(jobs)
        .where(and(eq(jobs.dedupeKey, key), ne(jobs.source, j.source))).limit(1).get();
      if (crossSource) continue;
      const r = tx.insert(jobs)
        .values({ ...j, dedupeKey: key, fetchedAt: now, updatedAt: now })
        .onConflictDoNothing({ target: [jobs.source, jobs.sourceJobId] })
        .run();
      n += r.changes;
    }
    return { inserted: n, skipped };
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

export function spendSince(db: Db, since: Date, stage?: string): number {
  const where = stage ? and(gte(llmUsage.at, since), eq(llmUsage.stage, stage)) : gte(llmUsage.at, since);
  const r = db.select({ total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` }).from(llmUsage).where(where).get();
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

export type DraftRow = typeof drafts.$inferSelect;
export interface DraftInput {
  jobId: number; model: string; coverLetter: string; answers: DraftAnswer[]; questions: FormQuestion[];
  cvSelection: CvSelection; cvPdfPath: string | null; flags: string[];
}

export function insertDraft(db: Db, d: DraftInput, now = new Date()): number {
  const r = db.insert(drafts).values({ ...d, createdAt: now, updatedAt: now }).returning({ id: drafts.id }).get();
  return r.id;
}

export function latestDraft(db: Db, jobId: number): DraftRow | undefined {
  return db.select().from(drafts).where(eq(drafts.jobId, jobId)).orderBy(desc(drafts.id)).limit(1).get();
}

export function updateDraftContent(db: Db, draftId: number, c: { coverLetter: string; answers: DraftAnswer[]; flags?: string[] }, now = new Date()): void {
  db.update(drafts).set({ ...c, editedByUser: true, updatedAt: now }).where(eq(drafts.id, draftId)).run();
}

/**
 * Saves fill-time answers into the draft (replacing any answer to the same question) so a re-fill reuses them instead
 * of calling the LLM again. Not a user edit: `editedByUser` is left alone.
 */
export function appendDraftAnswers(db: Db, draftId: number, add: DraftAnswer[], now = new Date()): void {
  if (add.length === 0) return;
  db.transaction((tx) => {
    const cur = tx.select({ answers: drafts.answers }).from(drafts).where(eq(drafts.id, draftId)).get();
    if (!cur) throw new Error(`draft ${draftId} not found`);
    const ids = new Set(add.map((a) => a.questionId));
    tx.update(drafts).set({ answers: [...cur.answers.filter((a) => !ids.has(a.questionId)), ...add], updatedAt: now }).where(eq(drafts.id, draftId)).run();
  });
}

export function markDraftNotified(db: Db, draftId: number, now = new Date()): void {
  db.update(drafts).set({ notifiedAt: now }).where(eq(drafts.id, draftId)).run();
}

export function listUnnotifiedDrafts(db: Db, limit: number): { job: JobRow; draft: DraftRow }[] {
  const out: { job: JobRow; draft: DraftRow }[] = [];
  for (const job of listJobsByStatus(db, ['draft_ready'], 1000)) {
    const draft = latestDraft(db, job.id);
    if (draft && !draft.notifiedAt) out.push({ job, draft });
    if (out.length >= limit) break;
  }
  return out;
}

export function listJobsForDrafting(db: Db, limit: number): JobRow[] {
  return db.select().from(jobs).where(eq(jobs.status, 'shortlisted')).orderBy(asc(jobs.updatedAt), asc(jobs.id)).limit(limit).all();
}

export function setResolved(db: Db, jobId: number, url: string, kind: ResolvedKind): void {
  db.update(jobs).set({ resolvedApplyUrl: url, resolvedKind: kind }).where(eq(jobs.id, jobId)).run();
}

export function resetStaleDrafting(db: Db, olderThan: Date, now = new Date()): number {
  const stale = db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.status, 'drafting'), lt(jobs.updatedAt, olderThan))).all();
  for (const s of stale) setStatus(db, s.id, 'shortlisted', 'stale drafting reset', {}, now);
  return stale.length;
}

/** draft_failed jobs whose failure has not been sent to Telegram yet, with the note of the transition into draft_failed. */
export function listUnnotifiedDraftFailures(db: Db, limit: number): { job: JobRow; reason: string }[] {
  const rows = db.select().from(jobs).where(and(eq(jobs.status, 'draft_failed'), isNull(jobs.draftFailureNotifiedAt)))
    .orderBy(asc(jobs.updatedAt), asc(jobs.id)).limit(limit).all();
  return rows.map((job) => {
    const ev = db.select({ note: jobEvents.note }).from(jobEvents)
      .where(and(eq(jobEvents.jobId, job.id), eq(jobEvents.toStatus, 'draft_failed'))).orderBy(desc(jobEvents.id)).limit(1).get();
    return { job, reason: ev?.note ?? 'unknown error' };
  });
}

export function markDraftFailureNotified(db: Db, jobId: number, now = new Date()): void {
  db.update(jobs).set({ draftFailureNotifiedAt: now }).where(eq(jobs.id, jobId)).run();
}

export type SubmissionRow = typeof submissions.$inferSelect;

export function insertSubmission(
  db: Db,
  s: { jobId: number; plan: FillPlan; fillShot: string | null; result: SubmissionResult; evidence?: string | null },
  now = new Date(),
): number {
  return db.insert(submissions).values({
    jobId: s.jobId, plan: s.plan, fillShot: s.fillShot, result: s.result, evidence: s.evidence ?? null, createdAt: now,
  }).returning({ id: submissions.id }).get().id;
}

export function latestSubmission(db: Db, jobId: number): SubmissionRow | undefined {
  return db.select().from(submissions).where(eq(submissions.jobId, jobId)).orderBy(desc(submissions.id)).limit(1).get();
}

export function getSubmission(db: Db, id: number): SubmissionRow | undefined {
  return db.select().from(submissions).where(eq(submissions.id, id)).get();
}

export function updateSubmission(
  db: Db,
  id: number,
  patch: Partial<{ submitShot: string | null; result: SubmissionResult; evidence: string | null; dryRun: boolean; submittedAt: Date | null; notifiedAt: Date | null }>,
): void {
  if (Object.keys(patch).length === 0) return;
  db.update(submissions).set(patch).where(eq(submissions.id, id)).run();
}

const realSubmission = and(eq(submissions.dryRun, false), isNotNull(submissions.submittedAt));

export function countRealSubmissionsSince(db: Db, since: Date): number {
  return db.select({ n: sql<number>`count(*)` }).from(submissions)
    .where(and(realSubmission, gte(submissions.submittedAt, since))).get()?.n ?? 0;
}

export function lastRealSubmissionAt(db: Db): Date | null {
  const row = db.select({ at: submissions.submittedAt }).from(submissions)
    .where(realSubmission).orderBy(desc(submissions.submittedAt)).limit(1).get();
  return row?.at ?? null;
}

export function listUnnotifiedSubmissions(db: Db, limit: number): { job: JobRow; sub: SubmissionRow }[] {
  const out: { job: JobRow; sub: SubmissionRow }[] = [];
  const ids = db.selectDistinct({ jobId: submissions.jobId }).from(submissions).orderBy(asc(submissions.jobId)).all();
  for (const { jobId } of ids) {
    const sub = latestSubmission(db, jobId);
    const job = getJob(db, jobId);
    if (sub && job && !sub.notifiedAt) out.push({ job, sub });
    if (out.length >= limit) break;
  }
  return out;
}

export function listJobsForFilling(db: Db, limit: number): JobRow[] {
  return db.select().from(jobs)
    .where(and(eq(jobs.status, 'ready_to_apply'), inArray(jobs.resolvedKind, ['greenhouse', 'lever', 'ashby'])))
    .orderBy(asc(jobs.updatedAt), asc(jobs.id)).limit(limit).all();
}

/** Jobs that have sat in `status` since before `olderThan`. */
export function listStaleByStatus(db: Db, status: JobStatus, olderThan: Date): JobRow[] {
  return db.select().from(jobs).where(and(eq(jobs.status, status), lt(jobs.updatedAt, olderThan))).orderBy(asc(jobs.id)).all();
}

/**
 * Atomic status transition: moves the job from `from` to `to` only if it is still in `from` (conditional UPDATE in an
 * immediate transaction). Returns false when another caller got there first.
 */
export function claimStatus(db: Db, jobId: number, from: JobStatus, to: JobStatus, note: string | null = null, now = new Date()): boolean {
  return db.transaction((tx) => {
    const r = tx.update(jobs).set({ status: to, updatedAt: now }).where(and(eq(jobs.id, jobId), eq(jobs.status, from))).run();
    if (r.changes !== 1) return false;
    tx.insert(jobEvents).values({ jobId, fromStatus: from, toStatus: to, note, at: now }).run();
    return true;
  }, { behavior: 'immediate' });
}
