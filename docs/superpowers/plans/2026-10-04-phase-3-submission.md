# Phase 3 — Form Filling & Submission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the user approves a draft, fill the real Greenhouse/Lever/Ashby form in a headless browser, send a screenshot with 🚀 Submit / ✋ Cancel, and submit only on the user's tap (dry run by default), with rate limits and a confirmation check.

**Architecture:** New core module `submit/` (types, fill plan, demographic decline, form verification, confirmation/captcha detection, rate limiting, three ATS fillers built on shared Playwright helpers) and two stages `pipeline/fill.ts`, `pipeline/submit.ts`. A `submissions` table stores each plan, screenshots and result. The worker runs `runFill` in its existing 60 s loop and `runSubmit` on the user's tap, serialised on one browser via a mutex. Telegram and the dashboard get Submit/Cancel/Mark-applied controls.

**Tech Stack:** existing (Node 22/mise, pnpm 11, TS, Vitest, Drizzle/SQLite, Zod 4, grammY, Next 16, Playwright 1.63 Chromium).

**Spec:** `docs/superpowers/specs/2026-10-04-phase-3-submission-design.md`

## Global Constraints

- The final submit click happens only inside `runSubmit`, which is only invoked from the user's 🚀 Submit (Telegram, chat-gated, press-once) or the dashboard Submit button. No loop, cron or CLI default path calls it. The CLI gets `fill` (never submits) only.
- `submit.dryRun` default `true`: `runSubmit` does everything except the click and records result `dry_run`.
- Rate limits: ≤ 1 submission per `submit.minSecondsBetween` (default 120) and ≤ `submit.dailyLimit` (default 15) per UTC day, counting only real (non-dry-run) clicks; over limit → refused, nothing clicked.
- `runSubmit` re-fills from the saved plan; any planned field not found, any required field left empty, or any choice option missing → `needs_manual`, no click.
- Demographic/EEOC questions: never answered substantively; if required choose an explicit decline option, else `needs_manual`; if optional leave blank.
- Unknown post-click result → `submit_failed` (never assume success).
- New statuses (exact strings): `filling`, `awaiting_submit`, `submitting`, `needs_manual`, `submit_failed`.
- Screenshots under `data/screenshots/` (git-ignored); nothing personal committed. Never touch the employer code folder (see agent memory).
- No real submissions in automated tests: Playwright request interception (`page.route`) answers every form POST locally.
- Live checks against real employer pages may only run `fill` (no click).
- Run node/pnpm only via `mise exec -- ...`. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019HoNfyA6FzHek4ALzhrbCV
  ```

## Review Focus

1. **Double tap / stale tap on 🚀 Submit** (two taps, a tap after Cancel, a tap after the job was applied): exactly one click at most; later taps refused. Pinned in Task 6.
2. **Form changed between screenshot and submit** (field removed, new required field, option renamed): no click, `needs_manual`. Pinned in Task 5.
3. **Captcha challenge appearing only after clicking Submit** (Greenhouse invisible reCAPTCHA escalates): detected → `submit_failed` with screenshot, never `applied`. Pinned in Task 2 + Task 5.
4. **Worker restarts mid-fill or mid-submit**: stale `filling` → `ready_to_apply`, stale `submitting` → `submit_failed` (never re-click automatically, since a click may already have happened). Pinned in Task 5.
5. **Dry run left on and the user thinks they applied**: dry-run results say so in Telegram and the job returns to `awaiting_submit`, never `applied`. Pinned in Task 5/6.

---

## File Structure

```
packages/core/src/
  types.ts                         + 5 statuses
  db/schema.ts, db/repo.ts         + submissions table + queries
  config.ts, config.yaml           + submit section
  submit/types.ts                  FillEntry, FillPlan, FilledReport, SubmitOutcome, AtsFiller, IdentityKey
  submit/plan.ts                   buildFillPlan, isDemographic, pickDecline
  submit/verify.ts                 verifyFill
  submit/detect.ts                 detectConfirmation, detectCaptchaChallenge, detectLoginWall
  submit/rate.ts                   checkSubmitAllowed
  submit/dom.ts                    Playwright helpers (fillText, chooseCombobox, chooseNative, clickChoiceButton, setFile, requiredEmpty)
  submit/fillers/greenhouse.ts | lever.ts | ashby.ts | index.ts (fillerFor)
  submit/screenshot.ts             takeShot, pngSize
  pipeline/fill.ts                 runFill
  pipeline/submit.ts               runSubmit
packages/core/test/
  submit-plan.test.ts, submit-detect.test.ts, submit-rate.test.ts, repo-submissions.test.ts
  fillers.test.ts (Chromium, synthetic pages), fill-stage.test.ts, submit-stage.test.ts
apps/worker/src/
  submissions.ts                   fill card, submit/cancel handlers, result messages
  mutex.ts                         createMutex
  main.ts / telegram.ts / drafts.ts / cli.ts  wiring
apps/web/
  app/jobs/[id]/submit-panel.tsx, app/jobs/[id]/actions.ts (+submit/cancel/applied), app/shot/[id]/route.ts
```

---

### Task 1: Statuses, submissions table, config

**Files:** Modify `packages/core/src/types.ts`, `src/db/schema.ts`, `src/db/repo.ts`, `src/config.ts`, `config.yaml`, `src/index.ts`; create `src/submit/types.ts`; new migration `drizzle/0004_*`; Test `test/repo-submissions.test.ts`, `test/config.test.ts`.

**Interfaces — Produces:**
- `JOB_STATUSES` + `'filling','awaiting_submit','submitting','needs_manual','submit_failed'`.
- `submit/types.ts`:
```ts
import type { Page } from 'playwright';
import type { ApplyTarget } from '../apply/types';
export type IdentityKey = 'firstName' | 'lastName' | 'fullName' | 'email' | 'phone' | 'country' | 'location' | 'linkedin' | 'github' | 'portfolio' | 'currentCompany' | 'resume' | 'coverLetter';
export type EntryKind = 'text' | 'textarea' | 'select' | 'multiselect' | 'choice' | 'checkbox' | 'file';
export type EntrySource = 'identity' | 'answers' | 'draft' | 'fill_time' | 'decline';
export interface FillEntry { fieldId: string; label: string; kind: EntryKind; value: string; source: EntrySource; required: boolean; options?: string[] }
export interface FillPlan { entries: FillEntry[]; missingRequired: { fieldId: string; label: string }[]; manualReasons: string[] }
export interface FilledReport { filled: string[]; notFound: string[]; failed: string[]; requiredEmpty: string[] }
export interface SubmitOutcome { kind: 'confirmed' | 'captcha' | 'error' | 'unknown'; evidence: string }
export interface AtsFiller {
  kind: 'greenhouse' | 'lever' | 'ashby';
  formUrl(target: ApplyTarget): string;
  fill(page: Page, plan: FillPlan): Promise<FilledReport>;
  submit(page: Page, timeoutMs: number): Promise<SubmitOutcome>;
}
export type SubmissionResult = 'filled' | 'blocked' | 'dry_run' | 'submitted' | 'failed' | 'cancelled';
```
- schema `submissions`: `id, jobId, plan (json FillPlan), fillShot text null, submitShot text null, dryRun bool default true, result text $type<SubmissionResult>, evidence text null, createdAt, submittedAt null, notifiedAt null`.
- repo: `insertSubmission(db, s: { jobId; plan; fillShot: string|null; result: SubmissionResult; evidence?: string|null }, now?): number`; `latestSubmission(db, jobId): SubmissionRow|undefined`; `updateSubmission(db, id, patch: Partial<{ submitShot: string|null; result: SubmissionResult; evidence: string|null; dryRun: boolean; submittedAt: Date|null; notifiedAt: Date|null }>): void`; `countRealSubmissionsSince(db, since: Date): number` (result `submitted` or `failed` with `dryRun = false` and `submittedAt >= since`); `lastRealSubmissionAt(db): Date|null`; `listUnnotifiedSubmissions(db, limit): { job: JobRow; sub: SubmissionRow }[]` (latest submission per job, `notifiedAt` null); `listJobsForFilling(db, limit): JobRow[]` (status `ready_to_apply` and resolvedKind in greenhouse/lever/ashby); `type SubmissionRow`.
- config: `submit: { dryRun: boolean; dailyLimit: number(int ≥1); minSecondsBetween: number(int ≥0); fillTimeoutMs: number(int>0) }`; config.yaml values `dryRun: true, dailyLimit: 15, minSecondsBetween: 120, fillTimeoutMs: 60000`.

- [ ] **Step 1: Failing tests** — `test/repo-submissions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import {
  insertJobs, listJobsByStatus, setStatus, setResolved, insertSubmission, latestSubmission, updateSubmission,
  countRealSubmissionsSince, lastRealSubmissionAt, listUnnotifiedSubmissions, listJobsForFilling,
} from '../src/db/repo';
import type { FillPlan } from '../src/submit/types';

const plan: FillPlan = { entries: [{ fieldId: 'identity:email', label: 'Email', kind: 'text', value: 'a@b.c', source: 'identity', required: true }], missingRequired: [], manualReasons: [] };
function seed(n = 1) { const db = testDb(); insertJobs(db, Array.from({ length: n }, () => makeJob())); return { db, jobs: listJobsByStatus(db, ['discovered']) }; }

describe('submissions repo', () => {
  it('lists ready_to_apply jobs on supported ATS only', () => {
    const { db, jobs } = seed(3);
    for (const j of jobs) setStatus(db, j.id, 'ready_to_apply');
    setResolved(db, jobs[0]!.id, 'https://job-boards.greenhouse.io/x/jobs/1', 'greenhouse');
    setResolved(db, jobs[1]!.id, 'https://himalayas.app/x', 'manual');
    setResolved(db, jobs[2]!.id, 'https://jobs.lever.co/x/1', 'lever');
    expect(listJobsForFilling(db, 10).map((j) => j.id).sort()).toEqual([jobs[0]!.id, jobs[2]!.id].sort());
  });
  it('round-trips plan json and returns the latest', () => {
    const { db, jobs } = seed();
    insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: '/a.png', result: 'filled' });
    const id = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: '/b.png', result: 'filled' });
    const s = latestSubmission(db, jobs[0]!.id)!;
    expect(s.id).toBe(id);
    expect(s.plan.entries[0]!.value).toBe('a@b.c');
    expect(s.dryRun).toBe(true);
  });
  it('counts only real submissions for rate limits', () => {
    const { db, jobs } = seed();
    const t = new Date('2026-10-04T12:00:00Z');
    const a = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, a, { result: 'dry_run', dryRun: true, submittedAt: t });
    const b = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, b, { result: 'submitted', dryRun: false, submittedAt: t });
    const c = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    updateSubmission(db, c, { result: 'failed', dryRun: false, submittedAt: new Date('2026-10-04T12:05:00Z') });
    expect(countRealSubmissionsSince(db, new Date('2026-10-04T00:00:00Z'))).toBe(2);
    expect(lastRealSubmissionAt(db)?.toISOString()).toBe('2026-10-04T12:05:00.000Z');
  });
  it('lists unnotified latest submissions', () => {
    const { db, jobs } = seed();
    const id = insertSubmission(db, { jobId: jobs[0]!.id, plan, fillShot: null, result: 'filled' });
    expect(listUnnotifiedSubmissions(db, 10).map((r) => r.sub.id)).toEqual([id]);
    updateSubmission(db, id, { notifiedAt: new Date() });
    expect(listUnnotifiedSubmissions(db, 10)).toEqual([]);
  });
});
```
Append to `test/config.test.ts`: `expect(cfg.submit).toEqual({ dryRun: true, dailyLimit: 15, minSecondsBetween: 120, fillTimeoutMs: 60000 })`.
Run → FAIL.

- [ ] **Step 2: Implement** schema/repo/config exactly per Interfaces (use `inArray(jobs.resolvedKind, ['greenhouse','lever','ashby'])`, `and(eq(submissions.dryRun,false), inArray(submissions.result,['submitted','failed']), gte(submissions.submittedAt, since))`; `listUnnotifiedSubmissions` iterates jobs having submissions via `latestSubmission`, similar to `listUnnotifiedDrafts`). `pnpm db:generate` → commit `0004_*`; verify on a scratch copy of the live DB (copy only). Export `./submit/types` from index. Add `data/screenshots/` is covered by `data/` ignore (verify).
- [ ] **Step 3: Run** all tests + typecheck + web build → PASS. **Step 4: Commit** — `feat(core): submission statuses, table and config`

---

### Task 2: Fill plan, demographic decline, verification, detection, rate limit (pure logic)

**Files:** Create `src/submit/plan.ts`, `src/submit/verify.ts`, `src/submit/detect.ts`, `src/submit/rate.ts`; Test `test/submit-plan.test.ts`, `test/submit-detect.test.ts`, `test/submit-rate.test.ts`.

**Interfaces — Consumes:** `FormQuestion`, `DraftRow`, `Answers`, `Profile`, `pickOption`, `FillEntry/FillPlan/FilledReport/SubmitOutcome`, `Config`, `countRealSubmissionsSince`, `lastRealSubmissionAt`.
**Produces:**
- `DEMOGRAPHIC = /gender|sex\b|race|ethnic|hispanic|latin[oa]|veteran|disabilit|sexual orientation|pronoun|transgender/i`; `isDemographic(label: string): boolean`; `pickDecline(options: string[]): string | null` (first option matching `/decline|prefer not|don'?t wish|do not wish|not to (say|answer|disclose)|choose not/i`).
- `buildFillPlan(input: { questions: FormQuestion[]; draft: Pick<DraftRow,'answers'|'coverLetter'|'cvPdfPath'>; answers: Answers; profile: Profile }): FillPlan`:
  - Always adds identity entries with ids `identity:<key>` for firstName, lastName, fullName, email, phone, country, location, linkedin, github, (portfolio if set), currentCompany (= `profile.experience[0].company`), resume (= `draft.cvPdfPath`, kind `file`; if null → `manualReasons.push('no CV PDF')`), coverLetter (kind `textarea`, value draft cover letter). `required` false for these (fillers decide per form).
  - For each non-identity question: draft answer by `questionId` → entry (source from the draft answer: `answers`→'answers', `generated`→'draft'); kind map: text/textarea as is, select→'select', multiselect→'multiselect', boolean→'choice', file→'file'.
  - Demographic question (by label): if required → `pickDecline(options)`; found → entry source 'decline'; not found → `manualReasons.push('required demographic question without a decline option: <label>')`; if optional → skipped (no entry).
  - Required non-identity question without a draft answer → `missingRequired.push({ fieldId, label })`.
  - File questions other than resume/cover letter: if required → `manualReasons.push('required file upload: <label>')`, else skipped.
- `verifyFill(plan: FillPlan, report: FilledReport): string[]` → mismatch reasons: each `notFound` entry that is required or non-identity (`"field not found: <label>"`), each `failed` (`"could not set: <label>"`), each `requiredEmpty` (`"required field empty: <label>"`). Optional identity entries not found are fine.
- `detectConfirmation(url: string, text: string): boolean` — `/(\/confirmation|\/thanks|thank-you|application-submitted)/i` on url OR `/thank you for (applying|your application|your interest)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application/i` on text.
- `detectCaptchaChallenge(page: Page): Promise<boolean>` — true if a visible (bounding box ≥ 100×100) iframe whose src matches `/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*(challenge|hcaptcha-challenge)/` exists, or a visible `iframe[title*="challenge" i]`.
- `detectLoginWall(url: string, text: string): boolean` — `/\/(login|signin|sign_in|auth)\b/i` on url OR `/sign in to (continue|apply)|log in to apply|create an account to apply/i` on text.
- `checkSubmitAllowed(db, cfg, now): { ok: true } | { ok: false; reason: string }` — daily count ≥ limit → `"Daily submission limit (N) reached"`; last real < minSecondsBetween ago → `"Please wait Ns before the next submission"`.

- [ ] **Step 1: Failing tests** (`test/submit-plan.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFillPlan, isDemographic, pickDecline } from '../src/submit/plan';
import { verifyFill } from '../src/submit/verify';
import { parseAnswers } from '../src/answers';
import { loadProfile } from '../src/profile';
import { findRoot } from '../src/root';
import type { FormQuestion } from '../src/apply/types';

const root = findRoot();
const answers = parseAnswers(readFileSync(join(root, 'profile/answers.example.yaml'), 'utf8'));
const profile = loadProfile(join(root, 'profile/profile.example.yaml'));
const draft = {
  coverLetter: 'Hello Acme', cvPdfPath: '/tmp/cv.pdf',
  answers: [
    { questionId: 'q_auth', label: 'Authorized in the US?', answer: 'No', source: 'answers' as const },
    { questionId: 'q_why', label: 'Why us?', answer: 'Because', source: 'generated' as const },
  ],
};
const qs: FormQuestion[] = [
  { id: 'first_name', label: 'First Name', type: 'identity', required: true },
  { id: 'q_auth', label: 'Authorized in the US?', type: 'select', required: true, options: ['Yes', 'No'] },
  { id: 'q_why', label: 'Why us?', type: 'textarea', required: true },
  { id: 'q_years', label: 'Years of Rust?', type: 'text', required: true },
  { id: 'q_opt', label: 'Anything else?', type: 'textarea', required: false },
  { id: 'gender', label: 'Gender', type: 'select', required: true, options: ['Male', 'Female', 'Decline to self-identify'] },
  { id: 'veteran', label: 'Veteran status', type: 'select', required: false, options: ['Yes', 'No', 'I don\'t wish to answer'] },
  { id: 'q_port', label: 'Portfolio PDF', type: 'file', required: false },
];

describe('buildFillPlan', () => {
  const plan = buildFillPlan({ questions: qs, draft, answers, profile });
  const by = (id: string) => plan.entries.find((e) => e.fieldId === id);
  it('adds identity entries from answers and profile', () => {
    expect(by('identity:firstName')?.value).toBe('Jane');
    expect(by('identity:lastName')?.value).toBe('Doe');
    expect(by('identity:email')?.value).toBe('jane@example.com');
    expect(by('identity:resume')).toMatchObject({ kind: 'file', value: '/tmp/cv.pdf' });
    expect(by('identity:coverLetter')?.value).toBe('Hello Acme');
    expect(by('identity:currentCompany')?.value).toBe('Example Co');
  });
  it('maps draft answers with sources and kinds', () => {
    expect(by('q_auth')).toMatchObject({ value: 'No', source: 'answers', kind: 'select', required: true });
    expect(by('q_why')).toMatchObject({ value: 'Because', source: 'draft', kind: 'textarea' });
  });
  it('reports missing required answers but not optional ones', () => {
    expect(plan.missingRequired).toEqual([{ fieldId: 'q_years', label: 'Years of Rust?' }]);
    expect(by('q_opt')).toBeUndefined();
  });
  it('declines required demographic questions and skips optional ones', () => {
    expect(by('gender')).toMatchObject({ value: 'Decline to self-identify', source: 'decline' });
    expect(by('veteran')).toBeUndefined();
  });
  it('sends required demographic questions without a decline option to manual', () => {
    const p = buildFillPlan({ questions: [{ id: 'g', label: 'Gender', type: 'select', required: true, options: ['Male', 'Female'] }], draft, answers, profile });
    expect(p.manualReasons).toEqual(['required demographic question without a decline option: Gender']);
  });
  it('sends required extra file uploads and missing CV to manual', () => {
    const p = buildFillPlan({ questions: [{ id: 'f', label: 'Writing sample', type: 'file', required: true }], draft: { ...draft, cvPdfPath: null }, answers, profile });
    expect(p.manualReasons).toEqual(['no CV PDF', 'required file upload: Writing sample']);
  });
});

describe('demographic helpers', () => {
  it.each(['Gender', 'Are you Hispanic/Latino?', 'Veteran Status', 'Disability status', 'Race'])('%s is demographic', (l) => expect(isDemographic(l)).toBe(true));
  it('is not fooled by ordinary questions', () => expect(isDemographic('Years of experience')).toBe(false));
  it('picks decline options', () => {
    expect(pickDecline(['Yes', 'No', 'I don\'t wish to answer'])).toBe('I don\'t wish to answer');
    expect(pickDecline(['Male', 'Prefer not to say'])).toBe('Prefer not to say');
    expect(pickDecline(['Yes', 'No'])).toBeNull();
  });
});

describe('verifyFill', () => {
  const plan = buildFillPlan({ questions: qs.slice(0, 3), draft, answers, profile });
  it('accepts a clean report', () => expect(verifyFill(plan, { filled: ['q_auth', 'q_why'], notFound: ['identity:github'], failed: [], requiredEmpty: [] })).toEqual([]));
  it('flags missing planned questions, failures and empty required fields', () => {
    expect(verifyFill(plan, { filled: [], notFound: ['q_why'], failed: ['q_auth'], requiredEmpty: ['Location (City)'] })).toEqual([
      'field not found: Why us?', 'could not set: Authorized in the US?', 'required field empty: Location (City)',
    ]);
  });
});
```
`test/submit-detect.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { detectConfirmation, detectLoginWall } from '../src/submit/detect';
describe('detectConfirmation', () => {
  it.each([
    ['https://job-boards.greenhouse.io/acme/jobs/1/confirmation', ''],
    ['https://jobs.lever.co/acme/1/thanks', ''],
    ['https://x', 'Thank you for applying to Acme!'],
    ['https://x', 'Your application was successfully submitted.'],
    ['https://x', "We've received your application"],
  ])('%s %s', (u, t) => expect(detectConfirmation(u, t)).toBe(true));
  it('is false for the form itself or an error', () => {
    expect(detectConfirmation('https://jobs.lever.co/acme/1/apply', 'Submit application')).toBe(false);
    expect(detectConfirmation('https://x', 'This field is required')).toBe(false);
  });
});
describe('detectLoginWall', () => {
  it('detects login urls and texts', () => {
    expect(detectLoginWall('https://acme.myworkdayjobs.com/login', '')).toBe(true);
    expect(detectLoginWall('https://x', 'Sign in to apply')).toBe(true);
    expect(detectLoginWall('https://jobs.ashbyhq.com/a/1/application', 'Apply')).toBe(false);
  });
});
```
`test/submit-rate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { checkSubmitAllowed } from '../src/submit/rate';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import { makeJob, testDb } from './helpers';
import { insertJobs, listJobsByStatus, insertSubmission, updateSubmission } from '../src/db/repo';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const plan = { entries: [], missingRequired: [], manualReasons: [] };
function real(db: ReturnType<typeof testDb>, jobId: number, at: Date) {
  const id = insertSubmission(db, { jobId, plan, fillShot: null, result: 'filled' });
  updateSubmission(db, id, { result: 'submitted', dryRun: false, submittedAt: at });
}
describe('checkSubmitAllowed', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('allows when idle', () => { expect(checkSubmitAllowed(testDb(), cfg, now)).toEqual({ ok: true }); });
  it('enforces the minimum gap', () => {
    const db = testDb(); insertJobs(db, [makeJob()]); const [j] = listJobsByStatus(db, ['discovered']);
    real(db, j!.id, new Date(now.getTime() - 30_000));
    expect(checkSubmitAllowed(db, cfg, now)).toEqual({ ok: false, reason: 'Please wait 90s before the next submission' });
  });
  it('enforces the daily limit', () => {
    const db = testDb(); insertJobs(db, [makeJob()]); const [j] = listJobsByStatus(db, ['discovered']);
    for (let i = 0; i < cfg.submit.dailyLimit; i++) real(db, j!.id, new Date(now.getTime() - (i + 3) * 300_000));
    expect(checkSubmitAllowed(db, cfg, now)).toEqual({ ok: false, reason: `Daily submission limit (${cfg.submit.dailyLimit}) reached` });
  });
});
```
(The daily-limit test spaces submissions 15 min apart starting 15 min ago, all on the same UTC day.)

- [ ] **Step 2: Implement** per Interfaces. `buildFillPlan`: `[first, ...rest] = answers.fullName.trim().split(/\s+/)`, lastName = `rest.join(' ')`. Kind map as stated. Order: identity entries first, then questions in form order.
- [ ] **Step 3: Run** core tests → PASS. **Step 4: Commit** — `feat(core): fill plan, verification, detection and rate limits`

---

### Task 3: DOM helpers + Greenhouse filler (synthetic pages, Chromium)

**Files:** Create `src/submit/dom.ts`, `src/submit/screenshot.ts`, `src/submit/fillers/greenhouse.ts`, `src/submit/fillers/index.ts`; Test `test/fillers.test.ts`, fixture `test/fixtures/greenhouse-form.html`.

**Live facts (probed 2026-10-04 on job-boards.greenhouse.io/fleetio/jobs/5253664007):** inputs are addressed by `id`: `first_name`, `last_name`, `email`, `phone` (type tel, intl-tel widget), `country` (role=combobox, required), `candidate-location` (role=combobox autocomplete, "Location (City)", required), `resume` and `cover_letter` (type=file, inside "Attach" buttons), custom questions `question_<n>` (text, textarea, or role=combobox for selects — the id equals the Greenhouse API field name), demographic comboboxes `gender`, `hispanic_ethnicity`, `veteran_status` (optional). Combobox options appear as `[role="option"]` in a `[role="listbox"]` after clicking/typing. Submit: `button[type=submit]` "Submit application". An invisible reCAPTCHA iframe is present on load (not a blocker by itself). Form POSTs to the job URL path.

**Interfaces — Produces:**
- `dom.ts`: `fillText(page, selector, value): Promise<boolean>`; `chooseCombobox(page, inputSelector, value): Promise<boolean>` (click, type value, wait ≤ 3 s for `[role=option]`, click the option whose trimmed text equals value case-insensitively, else the first option containing it; press Escape on failure; return whether an option was clicked); `chooseNative(page, selector, value)` (native `<select>`: selectOption by label); `clickChoiceButton(container: Locator, value)` (button/label whose text equals value); `setFile(page, selector, path)`; `requiredEmpty(page): Promise<string[]>` (labels of visible `[required], [aria-required=true]` inputs/textarea/select whose value is empty, ignoring hidden/captcha/search inputs).
- `screenshot.ts`: `takeShot(page, outPath): Promise<string>` (full page PNG, mkdir -p, returns path); `pngSize(path): { width: number; height: number }` (PNG IHDR bytes 16–23).
- `greenhouse.ts`: `greenhouseFiller: AtsFiller` — `formUrl(t) = t.url`; `fill(page, plan)` maps identity keys → `#first_name, #last_name, #email, #phone` (fillText), `#country` (chooseCombobox with `country`), `#candidate-location` (chooseCombobox typing the city part of `location` (text before the first comma); succeed if an option containing the country is clicked), `#resume` (setFile), `#cover_letter` file input is skipped when a cover letter text field `#cover_letter_text` exists → fillText it, otherwise skipped (optional); custom entries `#<fieldId>`: text/textarea → fillText, select/choice → chooseCombobox, multiselect → chooseCombobox for each `; `-separated value; then `requiredEmpty(page)`; returns `FilledReport`.
- `submit(page, timeoutMs)`: click `button[type=submit]`; then race up to timeoutMs: confirmation (`detectConfirmation(page.url(), bodyText)`) → `confirmed`; `detectCaptchaChallenge` → `captcha`; visible error (`[role=alert]`, `.error`, text `/is required|there was an error|please (fix|correct)/i`) → `error` with the text; timeout → `unknown`.
- `fillers/index.ts`: `fillerFor(kind): AtsFiller | null`.

- [ ] **Step 1: Synthetic fixture** — `test/fixtures/greenhouse-form.html`: a static page reproducing the live structure (ids/roles above) with a tiny inline script implementing comboboxes: clicking or typing in an `input[role=combobox]` renders a `[role=listbox]` with `[role=option]` items from a `data-options="A|B|C"` attribute filtered by the typed text; clicking an option sets the input value and removes the listbox. Include: first_name/last_name/email/phone (required), country (required, options include Mexico), candidate-location (required, options `Mazatlán, Sinaloa, Mexico|Mazatlán, Mexico|Mazatenango, Guatemala`), resume file, cover_letter file, question_1 text (LinkedIn, required), question_2 combobox Yes/No (required), question_3 textarea (required), gender combobox (optional, options include "Decline To Self Identify"), a `<form action="/apply" method="post">` and `button[type=submit]`. Submit handler: inline script does `fetch('/apply', {method:'POST', body: new FormData(form)})` then replaces body with `<h1>Thank you for applying</h1>` and `history.pushState({}, '', '/acme/jobs/1/confirmation')`.

- [ ] **Step 2: Failing tests** — `test/fillers.test.ts` (serve the fixture through `page.route('https://boards.test/**', …)` so relative URLs work and the POST is intercepted):
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { greenhouseFiller } from '../src/submit/fillers/greenhouse';
import type { FillPlan } from '../src/submit/types';

let browser: Browser;
const dir = mkdtempSync(join(tmpdir(), 'aa-fill-'));
const cv = join(dir, 'cv.pdf'); writeFileSync(cv, '%PDF-1.4 test');
const posted: string[] = [];

async function open(fixture: string, base = 'https://boards.test'): Promise<Page> {
  const page = await browser.newPage();
  await page.route(`${base}/**`, async (route) => {
    if (route.request().method() === 'POST') { posted.push(route.request().postData() ?? ''); return route.fulfill({ status: 200, body: '{}' }); }
    return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(__dirname, 'fixtures', fixture), 'utf8') });
  });
  await page.goto(`${base}/acme/jobs/1`);
  return page;
}
const e = (fieldId: string, value: string, kind: FillPlan['entries'][number]['kind'] = 'text', required = true, source: FillPlan['entries'][number]['source'] = 'identity') =>
  ({ fieldId, label: fieldId, kind, value, source, required });

const plan: FillPlan = { missingRequired: [], manualReasons: [], entries: [
  e('identity:firstName', 'Jane'), e('identity:lastName', 'Doe'), e('identity:email', 'jane@example.com'), e('identity:phone', '+52 000 000 0000'),
  e('identity:country', 'Mexico'), e('identity:location', 'Mazatlán, Mexico'), e('identity:resume', cv, 'file'),
  e('identity:coverLetter', 'Hello', 'textarea', false), e('identity:github', 'https://github.com/x', 'text', false),
  e('question_1', 'https://linkedin.com/in/x', 'text', true, 'answers'), e('question_2', 'No', 'select', true, 'answers'),
  e('question_3', 'Because I like it', 'textarea', true, 'draft'),
] };

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe('greenhouseFiller', () => {
  it('fills every field including comboboxes and the resume', async () => {
    const page = await open('greenhouse-form.html');
    const r = await greenhouseFiller.fill(page, plan);
    expect(r.failed).toEqual([]);
    expect(r.requiredEmpty).toEqual([]);
    expect(await page.inputValue('#first_name')).toBe('Jane');
    expect(await page.inputValue('#country')).toBe('Mexico');
    expect(await page.inputValue('#candidate-location')).toBe('Mazatlán, Sinaloa, Mexico');
    expect(await page.inputValue('#question_2')).toBe('No');
    expect(await page.inputValue('#question_3')).toBe('Because I like it');
    expect(await page.$eval('#resume', (i) => (i as HTMLInputElement).files?.[0]?.name)).toBe('cv.pdf');
    expect(r.notFound).toContain('identity:github');
    expect(posted).toEqual([]); // fill never submits
  }, 60_000);

  it('reports a missing planned field and empty required fields', async () => {
    const page = await open('greenhouse-form.html');
    const r = await greenhouseFiller.fill(page, { ...plan, entries: plan.entries.filter((x) => x.fieldId !== 'question_3').concat(e('question_99', 'x', 'text', true, 'draft')) });
    expect(r.notFound).toContain('question_99');
    expect(r.requiredEmpty.length).toBeGreaterThan(0);
  }, 60_000);

  it('submits and detects the confirmation; the POST is intercepted locally', async () => {
    const page = await open('greenhouse-form.html');
    await greenhouseFiller.fill(page, plan);
    const out = await greenhouseFiller.submit(page, 10_000);
    expect(out.kind).toBe('confirmed');
    expect(posted.length).toBe(1);
  }, 60_000);
});
```
- [ ] **Step 3: Implement** per Interfaces. **Step 4:** run the filler tests + core suite → PASS; typecheck.
- [ ] **Step 5: Live fill-only smoke (no click)** — add `packages/core/scripts/fill-smoke.ts` that takes a Greenhouse job URL, builds a plan from `profile/answers.example.yaml` + example profile + a dummy CV in the scratchpad, opens the page with the real browser, calls `greenhouseFiller.fill` ONLY (never `submit`), saves a screenshot to the scratchpad, prints the `FilledReport`. Run it on `https://job-boards.greenhouse.io/fleetio/jobs/5253664007` (or another open GH posting) and put the report + screenshot path in the task report. If a field type behaves differently live (e.g. location autocomplete needs a delay), fix the filler and extend the fixture to reproduce it.
- [ ] **Step 6: Commit** — `feat(core): greenhouse form filler with combobox support`

---

### Task 4: Lever and Ashby fillers

**Files:** Create `src/submit/fillers/lever.ts`, `src/submit/fillers/ashby.ts`; Modify `fillers/index.ts`; Test `test/fillers.test.ts` (extend), synthetic fixtures `test/fixtures/lever-form.html`, `test/fixtures/ashby-form.html` derived from the real saved `lever-application.html` / `ashby-application.html` structure (keep their field names/ids; add the same intercepting submit script with a Lever-style `/thanks` URL and an Ashby "Thank you for applying" message).

**Facts:** Lever (server-rendered): `name="name"` (full name), `email`, `phone`, `location`, `org` (current company), `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `resume` (file), `comments` ("Additional information" → cover letter text), custom `cards[<uuid>][fieldN]` as text/textarea/radio/checkbox/`select`; submit `#btn-submit`; optional EEO selects `eeo[gender]`, `eeo[race]`, `eeo[veteran]`. Ashby: `_systemfield_name`, `_systemfield_email`, `_systemfield_phone` (when present), `_systemfield_resume` (file), `_systemfield_location` (when present); custom questions by uuid `name`; yes/no questions are two buttons inside the question's container; submit button text "Submit Application". Inspect the saved fixtures and use their exact attributes.

**Interfaces — Produces:** `leverFiller: AtsFiller` (`formUrl` → `https://jobs.lever.co/<token>/<jobId>/apply`), `ashbyFiller: AtsFiller` (`formUrl` → `https://jobs.ashbyhq.com/<token>/<jobId>/application`); `fillerFor('lever'|'ashby')` returns them. Lever radios/checkboxes: check the input whose label text equals the value; `select` → `chooseNative`. Ashby `choice` entries → `clickChoiceButton` within the field's container (closest ancestor containing the field label); text → fillText by `[name="<id>"]`.

- [ ] **Step 1:** Write the two fixtures and tests mirroring Task 3's three tests (fill all, missing field reported, submit confirmed with exactly one intercepted POST, no POST during fill) plus: Lever radio question set via label; Ashby yes/no button chosen (assert via the button's `aria-pressed`/selected class toggled by the fixture script).
- [ ] **Step 2:** Implement; run tests → PASS.
- [ ] **Step 3: Live fill-only smoke** with `fill-smoke.ts` extended to accept Lever/Ashby URLs (use one Lever posting, e.g. `jobs.lever.co/toptal/<id>`, and one Ashby posting, e.g. `jobs.ashbyhq.com/resend/<id>`; pick currently open ones from the public APIs). Report + screenshots in the task report. Never call `submit`.
- [ ] **Step 4: Commit** — `feat(core): lever and ashby form fillers`

---

### Task 5: Fill and submit stages

**Files:** Create `src/pipeline/fill.ts`, `src/pipeline/submit.ts`; Test `test/fill-stage.test.ts`, `test/submit-stage.test.ts`.

**Interfaces — Consumes:** repo (Task 1), `buildFillPlan`, `verifyFill`, `detectLoginWall`, `detectCaptchaChallenge`, `checkSubmitAllowed`, `fillerFor`, `takeShot`, `latestDraft`, `draftJob` (fill-time answers: call with `questions` = the missing required questions only and use its `answers`/`flags`; blocking flags → manual), `costUsd`, `recordUsage`, `withTimeout`.
**Produces:**
```ts
export interface PageFactory { newPage(): Promise<import('playwright').Page> }
export interface FillDeps {
  db: Db; cfg: Config; provider: LLMProvider; profile: Profile; answers: Answers; shotsDir: string;
  pages: PageFactory; now?: Date; limit?: number;
}
export interface FillRunResult { filled: number; manual: number }
export function runFill(d: FillDeps): Promise<FillRunResult>;
export interface SubmitDeps { db: Db; cfg: Config; profile: Profile; answers: Answers; shotsDir: string; pages: PageFactory; now?: Date }
export type SubmitRunResult =
  | { status: 'refused'; reason: string }
  | { status: 'dry_run' | 'applied' | 'submit_failed' | 'needs_manual'; reason?: string; shot: string | null };
export function runSubmit(d: SubmitDeps, jobId: number): Promise<SubmitRunResult>;
export function resetStaleFillSubmit(db: Db, olderThan: Date, now?: Date): void;
```
Rules:
- `runFill`: `resetStaleFillSubmit(db, now−15 min)` first (stale `filling` → `ready_to_apply`; stale `submitting` → `submit_failed` with note "worker restarted during submit — check your email"). For each `listJobsForFilling` job: status `filling`; questions = latest draft's `questions`; plan = buildFillPlan; if `missingRequired` non-empty → fill-time answers via draftJob (record usage stage `fill`), merge entries with source `fill_time`; any blocking flag or `manualReasons` → `needs_manual` (insert submission result `blocked`, evidence = reasons). Else open page (`filler.formUrl(target)`), check login wall + captcha challenge → blocked/manual; `filler.fill`; screenshot; `verifyFill` mismatches → blocked/manual with screenshot; else insert submission `filled` (plan, fillShot) and status `awaiting_submit`. Any exception → `needs_manual` with message and screenshot if possible. Always close the page. Whole job wrapped in `withTimeout(cfg.submit.fillTimeoutMs)`.
- `runSubmit(jobId)`: job must be `awaiting_submit` with a latest submission `filled` (else `refused: "Not awaiting submit (status X)"`). If not dryRun: `checkSubmitAllowed` → refused. Set status `submitting`. Open page, re-fill from the stored plan, `verifyFill` → mismatches → `needs_manual` (no click). Screenshot. If `cfg.submit.dryRun` → update submission `dry_run`, status back to `awaiting_submit`, return `dry_run`. Else update submission `dryRun:false, submittedAt: now` BEFORE clicking, then `filler.submit`; confirmed → submission `submitted`, status `applied`; captcha/error/unknown → submission `failed` (evidence), status `submit_failed`. Screenshot after. Exceptions after the click attempt started → `submit_failed`; before → `needs_manual`.
- Fill/submit of jobs whose resolved kind has no filler is impossible by construction (`listJobsForFilling`), but `runSubmit` still guards (`refused`).

- [ ] **Step 1: Failing tests** using a fake `PageFactory` backed by real Chromium pages serving the Task 3 Greenhouse fixture via `page.route` (reuse the helper from `fillers.test.ts`, extracted to `test/fill-helpers.ts`), a FakeProvider for fill-time answers, and an in-memory DB:
  1. ready_to_apply GH job with a complete draft → `awaiting_submit`, submission `filled` with a screenshot file that exists, no POST captured.
  2. draft missing a required answer → FakeProvider called once, entry source `fill_time`, `awaiting_submit`; with a FakeProvider returning a claimed skill not in the profile → `needs_manual`.
  3. plan with a field the page lacks → `needs_manual`, submission `blocked` with evidence containing "field not found".
  4. page whose title/body says "Sign in to apply" → `needs_manual`.
  5. stale `filling` (20 min) → reset and filled; stale `submitting` → `submit_failed`.
  6. `runSubmit` with dryRun true → `dry_run`, no POST, status back to `awaiting_submit`, submission result `dry_run`.
  7. dryRun false → exactly one POST, `applied`, submission `submitted`, `submittedAt` set.
  8. second `runSubmit` on the same job → `refused` (status applied), still one POST.
  9. rate limit: a real submission 30 s ago → `refused` with the wait message, no POST, status unchanged.
  10. form changed at submit time (route serves a fixture variant without `question_3`) → `needs_manual`, no POST.
  11. confirmation never appears (fixture variant whose submit does nothing) with a short timeout → `submit_failed`, submission `failed`.
- [ ] **Step 2: Implement.** **Step 3:** run → PASS (Chromium tests ~seconds). **Step 4: Commit** — `feat(core): fill and submit stages with dry run, limits and verification`

---

### Task 6: Worker — fill loop, Telegram submit flow, approve change, CLI fill

**Files:** Create `apps/worker/src/submissions.ts`, `apps/worker/src/mutex.ts`; Modify `apps/worker/src/main.ts`, `telegram.ts`, `drafts.ts`, `cli.ts`, `README.md`; Test `apps/worker/test/submissions.test.ts`, `apps/worker/test/mutex.test.ts`.

**Interfaces — Produces:**
- `createMutex(): <T>(fn: () => Promise<T>) => Promise<T>` (serialises all browser use: draft loop, fill loop, submit taps).
- `formatFillCard(job, sub, dryRun: boolean): string` — title/company, `✍️ N fields filled · CV attached`, fill-time answers listed `⚠️ <label>: <answer>` (escaped, capped), dry-run banner `🧪 Dry run is ON — Submit will not send anything` when on; `submitKeyboard(jobId)` → `🚀 Submit` (`su:<id>`) / `✋ Cancel` (`ca:<id>`).
- `notifySubmissions(sender: SubmissionSender, chatId, db, cfg)` — for unnotified latest submissions: `filled` → photo (if `pngSize` width+height ≤ 10000 and height/width ≤ 20 → `sendPhoto`, else `sendDocument`) with the card caption (≤ 1024 chars; longer details as a follow-up message) + keyboard; `blocked` → "⚠️ Finish manually — <title>: <reasons>" + screenshot (if any) + the phase 2 copy-paste messages (`sendReady`); mark notified after the main message is delivered.
- `SubmissionSender extends DraftSender { sendPhoto(chatId: string, path: string, caption: string, other?: Record<string, unknown>): Promise<unknown> }`.
- `parseSubmitCallback(data)`: `su:<id>` → submit, `ca:<id>` → cancel.
- `handleCancel(db, allowedChatId, fromChatId, jobId)`: chat gate; only from `awaiting_submit` → `needs_manual` (note "cancelled by user") and submission `cancelled`; returns `{ ok, text }`.
- Submit tap handling in `createBot`: chat gate; `answerCallbackQuery('🚀 Submitting…' or refusal)`; remove the keyboard immediately (press-once at the UI level) ; run `runSubmit` inside the mutex; then send the result: `applied` → "✅ Applied — <company>" + after-submit screenshot; `dry_run` → "🧪 Dry run — nothing was sent. Turn off submit.dryRun in config.yaml to submit for real." + screenshot + the Submit/Cancel keyboard again; `refused` → the reason (keyboard restored if status still `awaiting_submit`); `submit_failed`/`needs_manual` → "⚠️ <reason> — finish manually" + screenshot + copy-paste messages + 📨 Mark applied.
- `drafts.ts` `handleDraftAction`: `ma:` (mark applied) also allowed from `needs_manual` and `submit_failed`.
- Approve change (`createBot` `onReady`): when the job's `resolvedKind` is greenhouse/lever/ashby, don't send the copy-paste ready message (the fill loop will send the screenshot); otherwise keep current behavior.
- `main.ts`: the 60 s loop runs, under the mutex: drafting (existing) → `runFill` (only when `listJobsForFilling(db,1)` non-empty; uses the browser holder's context `newPage`) → `notifyDrafts` → `notifySubmissions`.
- `cli.ts fill <jobId>`: runs the fill stage for that job only (add `onlyJobId?: number` to `FillDeps`, same pattern as drafting) with the CLI browser profile, prints the plan, report and screenshot path. Never submits. There is no `cli submit`.
- README: phase 3 section — flow, dry run (on by default; how to turn off), limits, what "finish manually" means, the screenshot folder, and that the first real submission should be done with the user watching.

- [ ] **Step 1: Failing tests** — `submissions.test.ts`: fill card escapes, lists fill-time answers, shows the dry-run banner; photo vs document choice by PNG size (write tiny PNGs with chosen IHDR sizes); cancel only from `awaiting_submit`, other chats refused, press-once; `ma:` from `needs_manual` and `submit_failed`; notifySubmissions sends once per submission and the blocked path includes the copy-paste messages. `mutex.test.ts`: two overlapping calls run sequentially; an error in the first doesn't block the second.
- [ ] **Step 2: Implement; Step 3:** worker + core tests, typecheck. Do NOT start the service or call Telegram/LLM. **Step 4: Commit** — `feat(worker): fill loop, telegram submit/cancel and cli fill`

---

### Task 7: Dashboard submit controls

**Files:** Create `apps/web/app/jobs/[id]/submit-panel.tsx`, `apps/web/app/shot/[id]/route.ts`; Modify `apps/web/app/jobs/[id]/actions.ts`, `page.tsx`.

**Interfaces — Produces:** server actions `submitApplication(jobId)` → returns a result string; it calls core `runSubmit` with a short-lived browser (`openBrowser` with `data/browser-dashboard`) — guarded by the same rules and limits; `cancelSubmission(jobId)` (awaiting_submit → needs_manual); `markApplied` extended to `needs_manual`/`submit_failed`. Route `GET /shot/<submissionId>?k=fill|submit` serves PNGs only from `data/screenshots/` (realpath check, numeric id) like the CV route. The panel shows the latest fill screenshot (img → `/shot/<id>?k=fill`), the plan table (label · value · source, fill-time rows highlighted), dry-run banner, Submit/Cancel for `awaiting_submit`, Mark applied for `needs_manual`/`submit_failed`, and the submit screenshot + result for finished submissions.

- [ ] **Step 1:** Implement; **Step 2:** web build passes; manual check on a scratch root on port 3101 (bound to 127.0.0.1): `/shot/<id>` 200 for a PNG in `data/screenshots`, 404 outside or non-numeric; job page renders the panel for a seeded `awaiting_submit` job. Never touch the real `data/`. **Step 3: Commit** — `feat(web): submission panel, screenshot route and submit/cancel actions`

---

### Task 8: Live verification with the user (handoff)

- [ ] Upgrade the running install (pull/merge, `pnpm install`, restart service — migration 0004 applies).
- [ ] With `submit.dryRun: true`: user approves a Greenhouse draft (e.g. Fleetio) → screenshot arrives → user taps 🚀 Submit → "🧪 Dry run" reply with screenshot → user taps ✋ Cancel.
- [ ] Repeat for one Lever or Ashby job if one is in the queue.
- [ ] User sets `submit.dryRun: false`, restarts, and does exactly one real submission of a job they choose, with the confirmation screenshot reviewed together.

---

## Self-review notes

Spec §3 rules 1–7 → Global Constraints + Tasks 2, 5, 6; §4 states/transitions → Tasks 1, 5, 6; §5.1 plan → Task 2; §5.2 fill-time answers → Task 5 (reuses `draftJob` and its truthfulness checks); §5.3 fillers → Tasks 3–4; §5.4 stages → Task 5; §5.5 Telegram → Task 6; §5.6 dashboard → Task 7; §6 data → Task 1; §7 config → Task 1; §8 errors → Task 5 (stale `submitting` → `submit_failed`, never auto re-click); §9 testing → per task + Task 8; §10 order → task order. Deviation: cover letters are filled as text only (a generated PDF for file-only cover letter fields is deferred; optional fields are left empty, a required file-only cover letter → manual).
