# AI Autoapplier — Design Spec

Date: 2026-10-03
Status: Draft, pending review

## 1. Goal

Get interviews for remote roles at US companies for a candidate based in Mexico without US work authorization. The tool finds eligible jobs, scores fit, drafts tailored applications, and submits them **after human approval**.

Success = interviews per week, not applications sent. Target: ~150–300 well-targeted applications/month, applied within hours of posting.

## 2. Constraints & non-goals

- **Eligibility is the core filter.** Only contractor / EOR / "LATAM OK" / "worldwide" / "anywhere in Americas" roles. Postings requiring US work authorization, W2, security clearance, or US residency are rejected.
- **Human-in-the-loop.** Nothing is submitted without explicit approval (dashboard or Telegram).
- **Truthfulness is hardcoded.** "Authorized to work in the US?" → No. Sponsorship → configured contractor answer. Skills, years, and experience come only from `profile/profile.yaml`. The LLM may select, reorder, and rephrase facts but never invent them.
- **No LinkedIn automation** (account-ban risk). No CAPTCHA solving services.
- **Local-first.** Runs on the user's Linux machine. No server required. Discovery is designed to be movable to Railway later.
- Non-goals for v1: email inbox parsing, auto-outreach to recruiters, multi-user support.

## 3. Target roles & filters (config, defaults below)

- Roles: AI/LLM Engineer (Applied AI, ML Engineer–LLM), Senior Full Stack (TypeScript: React/Angular + Node/NestJS), Voice / Conversational AI Engineer.
- Excluded titles: intern, junior, director, VP, manager (non-IC), data scientist (pure ML research).
- Pay: listed < $40/hr or < $80k/yr → reject. $40–50/hr → low priority. ≥ $50/hr or unlisted → normal.
- Recency: posted ≤ 7 days.

## 4. Architecture

TypeScript pnpm monorepo:

```
packages/core   domain: sources, filters, llm, drafting, db schema (Drizzle + SQLite)
apps/worker     node-cron scheduler, pipeline stages, Telegram bot (grammY), Playwright submitter
apps/web        Next.js dashboard on localhost
profile/        user data (git-ignored): profile.yaml, answers.yaml, cv template
```

- DB: SQLite via Drizzle (`data/app.db`). Postgres-compatible schema for a later move.
- No queue service: each job row has a `status` state machine; the worker polls for rows in actionable states.
- LLM: `LLMProvider` interface with Anthropic and OpenAI implementations via official SDKs. Outputs validated with Zod. Every call logged to `llm_usage` (model, tokens, cost, job id).
- Default models: scoring = Claude Haiku 4.5 (alt: GPT-5.6 Luna); drafting = Claude Opus 5.5 (alt: GPT-5.6 Sol). Selected by config. A week-1 blind comparison on 10 real jobs decides the drafting default.
- Browser: Playwright (form submission, form question extraction, CV HTML→PDF).
- Telegram: grammY with long polling (no public URL needed).

## 5. Pipeline & job state machine

```
discovered → filtered_out
           → scored → rejected_low_score | ineligible
                    → drafting → awaiting_review → skipped
                                                 → approved → submitting → applied
                                                                         → needs_manual
                                                                         → submit_failed
applied → replied → interview → offer | rejected | ghosted
```

### 5.1 Discover (every 2–3h)
Source adapters implement `fetchJobs(): Promise<RawJob[]>` and normalize to:

```ts
Job { id, source, sourceJobId, company, title, location, remoteScope, description,
      compMin?, compMax?, compPeriod?, applyUrl, ats?, atsCompanyToken?, postedAt, fetchedAt }
```

Sources v1:
- ATS public APIs per watched company: Greenhouse, Lever, Ashby, Workable.
- Remote boards: RemoteOK, Remotive, Himalayas, WeWorkRemotely (RSS), HN "Who is hiring" (Algolia API).
- Watchlist auto-growth: when a board posting's apply URL points to a known ATS, add that company+token to `companies` and poll it directly afterwards.
- Dedupe on normalized (company, title) plus source job id.
- Exact endpoints verified during implementation; an adapter that fails is logged and skipped without blocking others.

### 5.2 Rules filter (no LLM)
Title keyword match, exclusions, recency, pay floor, and hard-reject regexes (e.g. "authorized to work in the (US|United States)", "US citizens? only", "W-?2 only", "security clearance", "must (reside|be located) in the US"). Rejected jobs keep the matched reason.

### 5.3 Score (cheap model, batched)
Structured output:

```ts
{ eligibility: 'eligible'|'likely'|'unlikely'|'ineligible',
  eligibilityEvidence: string,          // verbatim quote from posting, or "none found"
  fitScore: number,                     // 0–100
  roleCategory: 'ai'|'fullstack'|'voice'|'other',
  matched: string[], missing: string[],
  redFlags: string[], compEstimate?: string }
```

Evidence must be a substring of the description (checked in code); otherwise eligibility downgrades to `unlikely`. Proceed to drafting when eligibility ∈ {eligible, likely} and fitScore ≥ threshold (default 65).

### 5.4 Draft (quality model)
1. Extract real application questions: Greenhouse via API (`questions=true`); Lever/Ashby/Workable by loading the form in Playwright and reading fields (no submit).
2. Generate: cover letter (≤ 250 words, no clichés), answer per question, tailored CV (selected/reordered bullets from profile → HTML template → PDF).
3. Grounding check: drafts reference only facts in `profile.yaml`; questions matching `answers.yaml` (work authorization, sponsorship, salary, notice period, location, timezone) use the stored answer verbatim.

### 5.5 Notify
Telegram card: title, company, pay, fit score, eligibility + quote, top matched/missing. Buttons: Approve, Skip, Open in dashboard. Approve from Telegram uses drafts as-is.

### 5.6 Review (dashboard)
Queue view sorted by score/recency; detail view with posting, editable cover letter and answers, CV PDF preview, Approve/Skip. Also: applications tracker, funnel stats per source/role, LLM spend.

### 5.7 Submit
Per-ATS Playwright adapters (order: Greenhouse, Lever, Ashby, Workable). Fill fields, upload CV PDF, answer questions; unknown optional fields left blank; unknown required fields mapped by LLM only from profile/answers with confidence ≥ threshold, else `needs_manual`. CAPTCHA or unexpected page → `needs_manual` with Telegram link. Screenshots before and after submit stored in `screenshots/`. `DRY_RUN=true` fills without submitting. Rate limit: ≤ 1 submission per 2 minutes.

### 5.8 Track
Manual status updates in dashboard; funnel metrics computed from status history (`job_events` table).

## 6. Data model (SQLite)

- `companies` (id, name, ats, atsToken, source, lastPolledAt, active)
- `jobs` (normalized fields + status, filterReason, dedupeKey)
- `scores` (jobId, model, payload json, createdAt)
- `drafts` (jobId, coverLetter, answers json, cvPdfPath, model, editedByUser)
- `applications` (jobId, submittedAt, method auto|manual, screenshots json, outcome)
- `job_events` (jobId, from, to, at, note)
- `llm_usage` (id, jobId?, stage, provider, model, inputTokens, outputTokens, costUsd, at)

## 7. Configuration

- `.env`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DRY_RUN`.
- `config.yaml`: roles/keywords, exclusions, pay floors, thresholds, models per stage, poll interval, sources enabled.
- `profile/profile.yaml`, `profile/answers.yaml`, `profile/cv.html` — git-ignored; `*.example.*` versions committed.

## 8. Error handling

- Stages idempotent; each transition written with an event row.
- Network/LLM errors retried with exponential backoff (max 3), then status `*_failed` with error message; visible in dashboard.
- LLM output failing Zod validation → one retry, then failed.
- Daily LLM spend cap (config) pauses scoring/drafting and notifies Telegram.

## 9. Testing

- Unit: normalizers, rules filter, evidence check, state transitions (Vitest) with saved real postings as fixtures.
- Adapter tests against recorded JSON/HTML fixtures.
- Submitter: dry-run against real forms, verifying fields filled via screenshots.
- Eligibility eval: ~30 hand-labeled postings; report accuracy per model before trusting automatic scoring.

## 10. Phases

1. Discover + rules filter + score + Telegram notify + read-only dashboard.
2. Drafting (questions extraction, cover letter, answers, tailored CV PDF) + editable review.
3. Auto-submit adapters: Greenhouse → Lever → Ashby → Workable.
4. Tracking and funnel stats.

Each phase gets its own implementation plan.
