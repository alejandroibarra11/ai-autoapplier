'use server';
import { revalidatePath } from 'next/cache';
import { getJob, isBlockingFlag, latestDraft, setStatus, updateDraftContent, type DraftAnswer } from '@autoapplier/core';
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
  const answers: DraftAnswer[] = draft.answers.map((a) => (a.source === 'answers' ? a : { ...a, answer: String(formData.get(`answer:${a.questionId}`) ?? a.answer) }));
  updateDraftContent(db, draft.id, { coverLetter: String(formData.get('coverLetter') ?? draft.coverLetter), answers });
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
