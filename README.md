# ai-autoapplier

AI-assisted job finder and applier for remote roles. Discovers postings from public ATS APIs and remote job boards, filters for eligibility, scores fit with an LLM, drafts tailored applications, and submits them after human approval (dashboard + Telegram).

> Work in progress. Personal profile data lives in `profile/` and is git-ignored.

## Run (phase 1)

Requirements: mise (Node 22), pnpm.

    mise install && pnpm install
    cp .env.example .env                       # fill ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN
    cp profile/profile.example.yaml profile/profile.yaml   # fill in; stays local
    pnpm once      # one pipeline pass, prints a summary
    pnpm worker    # cron every pollIntervalHours + Telegram bot (/start shows your chat id)
    pnpm web       # dashboard at http://localhost:3100

Tune roles, eligibility regexes, pay floors, models and sources in `config.yaml`.

## Phase 2: drafts

Shortlisting a job in Telegram triggers a draft (cover letter, answers to the application questions, tailored CV PDF). Setup:

    cp profile/answers.example.yaml profile/answers.yaml   # fill in; stays local
    mise exec -- pnpm --filter @autoapplier/core exec playwright install chromium

Flow: Shortlist -> draft card -> Approve -> ready message (links, CV, text) -> Mark applied. Drafts with blocking flags (unverified claim, missing answer, invalid option) cannot be approved from Telegram.

### Upgrading an existing install to phase 2

Do these in order:

1. `git pull`
2. `mise exec -- pnpm install`
3. `mise exec -- pnpm --filter @autoapplier/core exec playwright install chromium`
4. `cp profile/answers.example.yaml profile/answers.yaml` and fill it in (the service will not start without it).
5. `systemctl --user restart ai-autoapplier` — this applies the DB migrations. Do it BEFORE opening the dashboard (the dashboard does not migrate the DB).
6. Heads-up: jobs that are already `shortlisted` will be drafted (and billed against `drafting.dailySpendCapUsd`) within about a minute of the restart.
7. Approving from the dashboard does not send the Telegram "ready to apply" message; the dashboard itself shows the apply link and the answers. Approve from Telegram if you want the ready message there.

Manual draft for one job in status awaiting_review, shortlisted, draft_ready or draft_failed (no Telegram; uses its own browser profile `data/browser-cli`, so it can run while the service is up):

    pnpm --filter @autoapplier/worker cli draft <jobId>
