# AI Autoapplier — Phase 2: Drafting & Approval — Design Spec

Date: 2026-10-04
Status: Draft, pending review
Parent spec: `2026-10-03-ai-autoapplier-design.md` (§5.4–5.6, §10 phase 2)

## 1. Goal

Turn a job the user shortlists into an application they can approve in ~30 seconds: a tailored cover letter, an answer for each real application question, and a tailored CV PDF. Submission stays manual in this phase (phase 3 automates it). Success: drafts arrive within minutes of a shortlist and are accurate enough that the user rarely edits more than a sentence.

## 2. Decisions (agreed)

- Drafts are generated **only when the user taps 👍 Shortlist** (Telegram) or Shortlist in the dashboard. Never for un-shortlisted jobs.
- A **tailored CV PDF per job**, built from `profile.yaml` only.
- Apply-page resolution is **layered**: direct ATS link → headless browser → graceful "manual" fallback. Drafting happens in every case.
- The direct ATS watchlist is **widened** with verified remote/LATAM-friendly companies.
- Drafting model: `claude-opus-5-5` (config `drafting.model`), alternative provider pluggable as in phase 1.

## 3. Truthfulness rules (hardcoded, inherited)

- Fixed questions (work authorization, sponsorship, location/timezone, salary, notice period, English level, links) are answered **verbatim from `answers.yaml`**, never generated. Work authorization in the US is always "No".
- Generated text (cover letter, free-text answers) may only use facts in `profile.yaml`. A post-generation check extracts the skills/technologies the draft claims and flags any not present in the profile; flagged drafts show a warning on the Telegram card and in the dashboard and cannot be approved from Telegram (dashboard only, after edit or explicit override).
- The CV builder selects, reorders and trims existing bullets; it never writes new bullet text.

## 4. Flow and states

```
awaiting_review --(Shortlist)--> shortlisted --> drafting --> draft_ready --(Approve)--> ready_to_apply --(Mark applied)--> applied
                                       \--> draft_failed (after 1 retry)      \--(Skip)--> skipped
```

- `shortlisted` jobs are picked up by the worker's draft loop (polled every minute, independent of the 3-hour discovery cron), so a draft arrives within a few minutes of tapping.
- `draft_failed` jobs can be retried from the dashboard.
- Every transition writes a `job_events` row (existing mechanism).

## 5. Components

### 5.1 Apply-link resolver (`core/src/apply/resolve.ts`)
Input: job. Output: `{ kind: 'greenhouse'|'lever'|'ashby'|'other'|'manual', applyUrl, atsToken?, atsJobId? }`.
1. If `job.ats` ∈ {greenhouse, lever, ashby} with a known posting id → done.
2. If `applyUrl` already matches an ATS (`detectAts`) → done.
3. Else open `applyUrl` in headless Chromium (Playwright, persistent profile under `data/browser/`), wait for load, detect a Cloudflare challenge (title "Just a moment…") → `manual`. Otherwise find the primary apply link/button, follow it (max 2 hops, 20 s total), run `detectAts` on the final URL → ATS kind or `other`.
Results are cached on the job (`resolvedApplyUrl`, `resolvedKind`).

### 5.2 Question extractor (`core/src/apply/questions.ts`)
Output: `FormQuestion[] = { id, label, type: 'text'|'textarea'|'select'|'multiselect'|'boolean'|'file', required, options? }`.
- Greenhouse: `GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true`.
- Lever / Ashby: load the application page in the headless browser and read form fields (labels, types, required, options). No submission, no typing.
- `other` / `manual`: a fixed common-question set (why this company, why this role, salary expectation, notice period, work authorization, sponsorship, location/timezone, LinkedIn/GitHub).
- The standard identity fields (name, email, phone, resume upload) are marked `type: 'identity'` and are filled from `answers.yaml` in phase 3, not drafted.

### 5.3 Answers bank (`profile/answers.yaml`, git-ignored; `answers.example.yaml` committed)
Keys: `fullName, email, phone, location, timezone, workAuthorizationUS ("No"), sponsorship, salaryExpectation, noticePeriod, englishLevel, linkedin, github, portfolio?`. Plus `matchers`: regexes mapping common question labels to keys (e.g. `/authori[sz]ed to work/i → workAuthorizationUS`). Loaded with Zod; missing required keys fail fast at startup with a clear message.

### 5.4 Drafter (`core/src/draft/`)
- For each question: if a matcher hits → fixed answer (source `answers`). Else → generated.
- One Opus call per job with structured output: `{ coverLetter, answers: [{ questionId, answer }], cvSelection: { summary, skillsOrder[], bulletIds[] }, claimedSkills[] }`. Inputs: profile (rendered), job context (title, company, location, description), the questions needing generation, fixed answers for context. Adaptive thinking, effort `medium`, server-side refusal fallback enabled.
- Rules in the prompt: ≤ 220 words cover letter, no clichés, no invented facts, English unless the posting is in another language (then match it), concrete references to the posting.
- Truthfulness check (code): every `claimedSkills` entry must case-insensitively match a profile skill/stack term; unmatched → `flags[]`. `bulletIds` must exist in the profile (profile bullets get stable ids at load time).
- Cost recorded in `llm_usage` with stage `draft`; separate daily cap `drafting.dailySpendCapUsd` (default $3).

### 5.5 CV builder (`core/src/cv/`)
- One HTML template (`profile/cv.template.html`, committed as `cv.template.example.html`; default bundled template used if absent): single column, ATS-friendly, no tables/graphics.
- Data: profile header + `cvSelection` (summary from profile summary/headline only, skills reordered, selected bullets in chosen order, max 6 per role).
- Rendered to PDF via Playwright `page.pdf()` → `data/cv/{jobId}-{company-slug}.pdf`.

### 5.6 Telegram
- Draft card: title/company, first ~400 chars of the cover letter, count of answers (fixed vs generated), flags if any, CV PDF sent as a document. Buttons: ✅ Approve (disabled if flagged), ✏️ Edit (opens `http://localhost:3100/jobs/{id}` link), ⏭ Skip.
- On Approve → `ready_to_apply` message: apply link (resolved URL), each answer as a copyable block, CV re-attached. Button: 📨 Mark applied.
- Same chat gate and press-once semantics as phase 1.

### 5.7 Dashboard (editable for drafts only)
- Job detail gains a Draft panel: editable cover letter and answers (textarea per question, fixed answers shown read-only with source), CV PDF preview/download, flags, buttons Approve / Regenerate / Skip / Mark applied.
- Writes go through Next.js server actions calling core repo functions; the DB is opened read-write by the web app only for these actions. Still localhost-only, no auth.

### 5.8 Wider watchlist
- A probe script checks candidate company tokens against the Greenhouse/Lever/Ashby APIs and appends verified ones to `config.yaml` `seedCompanies`. Target 40–60 companies known for remote/LATAM hiring; only tokens returning HTTP 200 with ≥1 job are added.

## 6. Data model changes

- `jobs`: add `resolved_apply_url`, `resolved_kind`.
- New `drafts` table: `id, job_id, model, cover_letter, answers (json: [{questionId,label,answer,source:'answers'|'generated'}]), questions (json), cv_selection (json), cv_pdf_path, flags (json), edited_by_user (bool), created_at, updated_at`. Latest draft per job is current.
- New statuses: `drafting, draft_ready, draft_failed, ready_to_apply, applied` added to `JOB_STATUSES`.

## 7. Configuration

`config.yaml` gains:
```yaml
drafting:
  provider: anthropic
  model: claude-opus-5-5
  effort: medium
  dailySpendCapUsd: 3
  maxAttempts: 2
  pollSeconds: 60
browser:
  headless: true
  timeoutMs: 20000
```
Pricing table already includes `claude-opus-5-5`.

## 8. Error handling

- Resolver/extractor failures or timeouts degrade to `manual` + common questions (never block drafting).
- Draft LLM parse failure: one retry; second failure → `draft_failed` with message. API errors: not counted as attempts; 3 consecutive → stop the loop until next tick (same rule as scoring).
- Spend cap reached → drafts wait; one Telegram warning per UTC day.
- PDF render failure → draft saved without CV, flagged "CV not generated", Approve still allowed.

## 9. Testing

- Unit: answer matchers, truthfulness check, bullet-id validation, CV selection rendering (HTML snapshot), state transitions, Telegram draft card formatting/escaping, approve/skip/mark-applied handlers (press-once, chat gate).
- Fixtures: recorded Greenhouse `questions=true` JSON; saved Lever and Ashby application page HTML for the extractor (run against local files with Playwright).
- Integration: drafter with a fake provider end to end (shortlisted → draft_ready, PDF file created).
- Manual: one real draft on a user-shortlisted job; user judges quality.

## 10. Build order

1. `answers.yaml` + drafter + CV PDF (posting text + common questions only).
2. Draft loop in the worker, Telegram draft card, approve / skip / mark-applied.
3. Resolver + question extractor (Greenhouse API, then Lever/Ashby page reading).
4. Editable dashboard draft panel.
5. Wider watchlist probe + seed expansion.

## 11. Out of scope

Automatic form filling and submission (phase 3), email/inbox tracking and interview stages (phase 4), LinkedIn, CAPTCHA solving.
