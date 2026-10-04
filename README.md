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
