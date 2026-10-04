'use server';
import { revalidatePath } from 'next/cache';
import { applyDraftEdits, getJob, isBlockingFlag, latestDraft, setStatus, updateDraftContent } from '@autoapplier/core';
import { getWriteDb } from '../../../lib/db';

function guard(jobId: number, from: string[]) {
  const db = getWriteDb();
  const job = getJob(db, jobId);
  if (!job || !from.includes(job.status)) throw new Error(`Job ${jobId} is ${job?.status ?? 'missing'}`);
  return { db, job };
}
const done = (jobId: number) => revalidatePath(`/jobs/${jobId}`);

export async function shortlistJob(jobId: number) { const { db } = guard(jobId, ['awaiting_review']); setStatus(db, jobId, 'shortlisted', 'dashboard'); done(jobId); }
export async function skipJob(jobId: number) { const { db } = guard(jobId, ['awaiting_review', 'draft_ready']); setStatus(db, jobId, 'skipped', 'dashboard'); done(jobId); }
export async function regenerateDraft(jobId: number) { const { db } = guard(jobId, ['draft_ready', 'draft_failed']); setStatus(db, jobId, 'shortlisted', 'dashboard regenerate', { draftAttempts: 0, draftFailureNotifiedAt: null }); done(jobId); }
export async function markApplied(jobId: number) { const { db } = guard(jobId, ['ready_to_apply']); setStatus(db, jobId, 'applied', 'dashboard'); done(jobId); }

export async function saveDraft(formData: FormData) {
  const jobId = Number(formData.get('jobId'));
  const { db } = guard(jobId, ['draft_ready']);
  const draft = latestDraft(db, jobId);
  if (!draft) throw new Error('No draft');
  const field = (k: string) => { const v = formData.get(k); return v === null ? undefined : String(v); };
  // Server-side rules (fixed answers only accept one of the question's options) live in applyDraftEdits.
  const edited = applyDraftEdits(draft, {
    coverLetter: field('coverLetter'),
    answers: Object.fromEntries(draft.answers.map((a) => [a.questionId, field(`answer:${a.questionId}`)])),
  });
  updateDraftContent(db, draft.id, edited);
  done(jobId);
}

export async function approveDraft(formData: FormData) {
  const jobId = Number(formData.get('jobId'));
  const { db } = guard(jobId, ['draft_ready']);
  const draft = latestDraft(db, jobId);
  if (!draft) throw new Error('No draft');
  if (draft.flags.some(isBlockingFlag) && formData.get('override') !== 'on') throw new Error('Draft has warnings: tick "approve anyway" after reviewing');
  setStatus(db, jobId, 'ready_to_apply', draft.flags.some(isBlockingFlag) ? 'dashboard (override)' : 'dashboard');
  done(jobId);
}
