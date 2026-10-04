# AI Autoapplier — Phase 3: Form Filling & Submission — Design Spec

Date: 2026-10-04
Status: Draft, pending review
Parent specs: `2026-10-03-ai-autoapplier-design.md` (§5.7), `2026-10-04-phase-2-drafting-design.md`

## 1. Goal

After the user approves a draft, fill the employer's real application form in a headless browser, show the user a full-page screenshot, and submit only when the user taps Submit. Success: an approved job on Greenhouse/Lever/Ashby reaches `applied` with two taps (Approve, Submit) and a confirmation screenshot; anything the bot cannot do safely ends in `needs_manual` with everything ready to paste.

## 2. Decisions (agreed)

- Submission flow: **fill → screenshot → user taps 🚀 Submit**. No automatic submit path exists.
- Gaps: a required field missing from the draft is answered at fill time by one Opus call (profile-only), highlighted in the screenshot message. Captcha, login wall or unrecognized page → stop, `needs_manual`.
- Approach: dedicated fillers for Greenhouse, Lever, Ashby. Every other site → `needs_manual` (copy-paste message). A generic AI form agent is out of scope; we measure how often `needs_manual` happens first.
- Headless Chromium with the worker's persistent profile. No captcha solving or evasion.

## 3. Hard safety rules

1. The submit click happens only inside the submit step, which runs only in response to the user's 🚀 Submit (Telegram, chat-gated, press-once) or the dashboard Submit button.
2. Rate limits: at most 1 submission per 2 minutes and `submit.dailyLimit` (default 15) per UTC day; over the limit → the tap is refused with a message, nothing is clicked.
3. `submit.dryRun` (default `true`) runs everything except the final click and reports "dry run — not submitted".
4. The submit step re-fills from the saved fill plan and aborts (→ `needs_manual`) if the form no longer matches it (a planned required field is missing, a new required field appeared, or a select option disappeared).
5. Demographic/EEOC questions are never answered substantively: if required, choose an explicit decline option ("Decline to self-identify", "I don't wish to answer", "Prefer not to say"); if none exists → `needs_manual`.
6. Truthfulness rules from phase 2 apply unchanged; fill-time answers are shown to the user before Submit.
7. Every fill and submit attempt saves a full-page screenshot under `data/screenshots/` (git-ignored).

## 4. Flow and states

```
ready_to_apply ─(kind greenhouse|lever|ashby)→ filling → awaiting_submit ─🚀→ submitting → applied
       │                                    │                │                       └→ submit_failed → (manual msg)
       │                                    └→ needs_manual   └─✋→ needs_manual
       └─(other|manual)→ needs_manual (copy-paste message, as phase 2)
needs_manual / submit_failed ─(user: Mark applied)→ applied
```
New statuses: `filling`, `awaiting_submit`, `submitting`, `needs_manual`, `submit_failed`. Every transition writes `job_events`. Stale `filling`/`submitting` (> 15 min) are reset to `ready_to_apply` / `awaiting_submit` at loop start.

Change to phase 2 behaviour: approving an ATS-kind draft no longer sends the copy-paste "ready" message immediately; it is sent when the job reaches `needs_manual` or `submit_failed`.

## 5. Components

### 5.1 Fill plan (`core/src/submit/plan.ts`)
`FillEntry { fieldId, label, kind: 'text'|'textarea'|'select'|'multiselect'|'radio'|'checkbox'|'file', value: string, source: 'answers'|'draft'|'fill_time'|'identity'|'decline', required }`.
Built from the extracted form questions + latest draft + `answers.yaml` + CV path. Identity: first/last name (split `fullName`), email, phone, location, LinkedIn/GitHub; resume = CV PDF; cover letter field = draft cover letter (text) or a generated PDF of it when only file upload is offered. Stored as JSON on a new `submissions` table row.

### 5.2 Fill-time answers
Required non-identity fields with no plan value → one Opus call (same truthfulness checks as drafting: claimed-skill scan, option validation). Entries get `source: 'fill_time'`; any blocking flag → `needs_manual`.

### 5.3 Fillers (`core/src/submit/{greenhouse,lever,ashby}.ts`)
Common interface:
```ts
interface AtsFiller {
  open(page, target): Promise<void>;
  detectBlockers(page): Promise<string[]>;          // captcha challenge visible, login wall, 404/closed posting
  fill(page, plan): Promise<{ filled: string[]; missing: string[]; mismatches: string[] }>;
  submit(page): Promise<{ confirmed: boolean; evidence: string }>; // click + wait for confirmation text/URL
}
```
Field location by name/id first, label text second. Uploads via `setInputFiles`. Confirmation detection per ATS (confirmation URL pattern or thank-you text); unknown result → `submit_failed` (never assume success).

### 5.4 Stages (`core/src/pipeline/fill.ts`, `submit.ts`)
- `runFill`: picks `ready_to_apply` jobs, routes by resolved kind, builds plan, fills, detects blockers, screenshots, stores the submission row, → `awaiting_submit` or `needs_manual`.
- `runSubmit(jobId)`: rate-limit check, dry-run check, re-fill + plan verification, click, confirmation, screenshot, → `applied` / `submit_failed` / `needs_manual`.
- Fill runs in the worker's existing 60 s loop after drafting; submit runs immediately on the user's tap (serialised with the loop's browser use).

### 5.5 Telegram
Fill result: `sendPhoto` (full-page screenshot, scaled to Telegram limits; full image also attached as a document if long) + caption: job, counts (filled / uploaded), fill-time answers listed with ⚠️, dry-run banner when on. Buttons 🚀 Submit / ✋ Cancel (chat gate, press-once). Results: "✅ Applied — <company>" + confirmation screenshot; or "⚠️ Finish manually" + copy-paste messages + screenshot of where it stopped.

### 5.6 Dashboard
Job page shows the latest fill screenshot, plan entries (with sources), Submit / Cancel, and Mark applied for `needs_manual`/`submit_failed`. Same guards and limits as Telegram.

## 6. Data model

- New `submissions` table: `id, job_id, plan (json), fill_screenshot, submit_screenshot, dry_run (bool), result ('filled'|'blocked'|'submitted'|'failed'|'cancelled'), evidence, created_at, submitted_at`.
- New statuses in `JOB_STATUSES`.
- Additive migration only.

## 7. Configuration

```yaml
submit:
  dryRun: true
  dailyLimit: 15
  minSecondsBetween: 120
  fillTimeoutMs: 60000
```

## 8. Error handling

- Any filler exception, timeout, blocker or verification mismatch → `needs_manual` with a screenshot (never stuck; stale sweep as in phase 2).
- Submit click without detectable confirmation → `submit_failed` (user checks the employer email/page and taps Mark applied if it went through).
- Fill-time LLM failure → `needs_manual`.
- Browser crash → the existing browser holder recreates it.

## 9. Testing

- Fillers tested against saved real application pages (Greenhouse capture added; Lever/Ashby fixtures exist) loaded via `file://`, with Playwright request interception so a submit POST is captured locally and never reaches an employer. Assertions: every plan value lands in the right field, uploads attached, decline options chosen for demographic questions, blockers detected on pages with a captcha challenge, confirmation detection on a synthetic thank-you page.
- Unit tests: plan building (identity split, cover-letter routing, missing-required detection), verification mismatch logic, rate limiter, dry-run guard, state transitions, Telegram handlers (chat gate, press-once, refused over limit).
- Live (with the user): one real job in dry run (fill → screenshot → Cancel); then dry run off; then exactly one real submission to a job the user chooses.

## 10. Build order

1. Fill plan + Greenhouse filler + `runFill` in dry run.
2. Telegram photo + Submit/Cancel + `runSubmit` + rate limits.
3. Lever and Ashby fillers.
4. Dashboard controls.
5. Live test.

## 11. Out of scope

Generic AI form agent, Workday/custom sites, captcha solving, email/inbox tracking (phase 4).
