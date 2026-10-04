'use server';
import { revalidatePath } from 'next/cache';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyDraftEdits, checkSubmitMode, claimStatus, findRoot, getJob, isBlockingFlag, latestDraft, latestSubmission, loadAnswers, loadConfig,
  loadProfile, openBrowser, parseRenderedDry, runSubmit, setStatus, skipFromDashboard, updateDraftContent, updateSubmission, type PageFactory,
} from '@autoapplier/core';
import { getWriteDb } from '../../../lib/db';

function guard(jobId: number, from: string[]) {
  const db = getWriteDb();
  const job = getJob(db, jobId);
  if (!job || !from.includes(job.status)) throw new Error(`Job ${jobId} is ${job?.status ?? 'missing'}`);
  return { db, job };
}
const done = (jobId: number) => revalidatePath(`/jobs/${jobId}`);

export async function shortlistJob(jobId: number) { const { db } = guard(jobId, ['awaiting_review']); setStatus(db, jobId, 'shortlisted', 'dashboard'); done(jobId); }
/** ⏭ Skip (also from awaiting_submit — cancels the pending submission — needs_manual and submit_failed). */
export async function skipJob(jobId: number) {
  const ok = skipFromDashboard(getWriteDb(), jobId);
  done(jobId);
  if (!ok) throw new Error(`Job ${jobId} can't be skipped from ${getJob(getWriteDb(), jobId)?.status ?? 'missing'}`);
}
export async function regenerateDraft(jobId: number) { const { db } = guard(jobId, ['draft_ready', 'draft_failed']); setStatus(db, jobId, 'shortlisted', 'dashboard regenerate', { draftAttempts: 0, draftFailureNotifiedAt: null }); done(jobId); }
export async function markApplied(jobId: number) { const { db } = guard(jobId, ['ready_to_apply', 'needs_manual', 'submit_failed']); setStatus(db, jobId, 'applied', 'dashboard'); done(jobId); }

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

/** ✋ Cancel: awaiting_submit → needs_manual (atomic), the latest submission becomes 'cancelled'. */
export async function cancelSubmission(jobId: number) {
  const db = getWriteDb();
  if (claimStatus(db, jobId, 'awaiting_submit', 'needs_manual', 'cancelled by user (dashboard)')) {
    const sub = latestSubmission(db, jobId);
    if (sub) updateSubmission(db, sub.id, { result: 'cancelled', evidence: 'cancelled by user' });
  }
  done(jobId);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Dashboard 🚀 Submit — the second (and last) caller of runSubmit. Applies the same mode rule as the Telegram buttons:
 * the form carries the dry-run mode the panel was rendered under; if it differs from the current config nothing is submitted.
 * Returns the message shown to the user.
 */
export async function submitApplication(_prev: string | null, formData: FormData): Promise<string> {
  const jobId = Number(formData.get('jobId'));
  const renderedDry = parseRenderedDry(formData.get('renderedDry'));
  if (!Number.isSafeInteger(jobId)) return 'Bad job id';
  if (renderedDry === null) return 'Bad request: page mode unknown — reload the page';
  try {
    const root = findRoot();
    const cfg = loadConfig(join(root, 'config.yaml'));
    const db = getWriteDb();
    const mode = checkSubmitMode(db, jobId, renderedDry, cfg.submit.dryRun);
    done(jobId);
    if (!mode.proceed) return mode.message;
    const profilePath = join(root, 'profile/profile.yaml');
    const answersPath = join(root, 'profile/answers.yaml');
    if (!existsSync(profilePath)) return `Missing ${profilePath} — copy profile/profile.example.yaml and fill it in`;
    if (!existsSync(answersPath)) return `Missing ${answersPath} — copy profile/answers.example.yaml and fill it in`;
    const profile = loadProfile(profilePath);
    const answers = loadAnswers(answersPath);
    const session = await openBrowser({ headless: cfg.browser.headless, userDataDir: join(root, 'data/browser-dashboard') });
    try {
      const pages: PageFactory = { newPage: () => session.context.newPage() };
      const r = await runSubmit({ db, cfg, profile, answers, shotsDir: join(root, 'data/screenshots'), pages }, jobId);
      done(jobId);
      switch (r.status) {
        case 'refused': return `Refused: ${r.reason}`;
        case 'dry_run': return 'Dry run: nothing was sent. Set submit.dryRun to false in config.yaml to submit for real.';
        case 'applied': return 'Applied: the confirmation was seen.';
        case 'submit_failed': return `Submit failed: ${r.reason ?? 'unknown'}. Check your email first: it may have been sent.`;
        default: return `Finish manually: ${r.reason ?? 'unknown'}`;
      }
    } finally {
      await session.close().catch(() => {});
    }
  } catch (e) {
    done(jobId);
    return `Submit error: ${errMsg(e)}`;
  }
}
