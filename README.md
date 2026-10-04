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

Manual draft for one job (no Telegram):

    pnpm --filter @autoapplier/worker cli draft <jobId>
