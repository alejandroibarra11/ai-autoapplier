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
7. Approving from the dashboard does not send the Telegram "ready to apply" message; the dashboard itself shows the apply link and the answers. Approve from Telegram if you want the ready message there. Exception (phase 3): Greenhouse, Lever and Ashby jobs never get the copy-paste message on approval, from either place; the fill loop sends a Telegram screenshot card with 🚀 Submit / ✋ Cancel instead (or "finish manually" + the copy-paste messages if it can't fill the form).

Manual draft for one job in status awaiting_review, shortlisted, draft_ready or draft_failed (no Telegram; uses its own browser profile `data/browser-cli`, so it can run while the service is up):

    pnpm --filter @autoapplier/worker cli draft <jobId>

## Phase 3: form filling and submission

For Greenhouse, Lever and Ashby postings the worker fills the employer's form in its headless browser and only clicks the final submit button when you tap it.

Flow: Approve a draft -> the worker (60 s loop) opens the form, fills it from your profile, `answers.yaml` and the approved draft, attaches the CV and takes a full-page screenshot -> Telegram gets the screenshot with the field count, any answers it had to generate at fill time (marked ⚠️, check them) and 🚀 Submit / ✋ Cancel -> 🚀 Submit re-fills the form from the same plan, checks it again and clicks submit -> "✅ Applied — <company>" with the confirmation screenshot. Other ATSs keep the phase 2 copy-paste flow (Approve sends the "ready to apply" message).

Ashby autosaves form values on the employer's side as they are typed, so for Ashby jobs the employer may already have the filled-in values (but no submitted application) before you tap anything — ✋ Cancel doesn't remove them. The Ashby fill card says so: "ℹ️ Ashby saves these values on the employer's side while filling — Cancel doesn't remove them."

Dry run is ON by default (`submit.dryRun: true` in `config.yaml`): 🚀 Submit does everything except the click and replies "🧪 Dry run — nothing was sent." with the Submit/Cancel buttons again. Do a few dry runs, then set `submit.dryRun: false` and restart the service (`systemctl --user restart ai-autoapplier`). After switching dry run off, old dry-run cards won't submit — the bot re-fills and sends a fresh card. Do the first real submission with you watching: pick a job you really want, tap 🚀 Submit and check the confirmation screenshot and your email.

Limits (`config.yaml` `submit`): at most one real submission every `minSecondsBetween` (120 s) and `dailyLimit` (15) per UTC day; dry runs don't count. Over the limit, Submit is refused and nothing is clicked. `fillTimeoutMs` bounds one fill.

"Finish manually" (`needs_manual`) means the worker stopped before clicking: a login wall or captcha, a required question it could not answer truthfully, a field it could not find or verify, the form changed between the screenshot and Submit, or you tapped ✋ Cancel. You get the screenshot of where it stopped plus the copy-paste messages; apply in your browser and tap 📨 Mark applied. `submit_failed` means the click happened (or may have) but no confirmation was seen: check your email before re-applying, then tap 📨 Mark applied if it went through. The same applies if the worker restarted mid-submit.

The dashboard job page (`/jobs/<id>`) also shows the fill screenshot, the field plan (fill-time answers highlighted), and 🚀 Submit / ✋ Cancel for `awaiting_submit` jobs and 📨 Mark applied for `needs_manual` / `submit_failed`; ⏭ Skip works from all three (skipping an `awaiting_submit` job cancels its pending submission). Dashboard Submit uses the same rules, limits and mode check as Telegram (a page rendered under another dry-run setting re-fills instead of submitting) and its own browser profile `data/browser-dashboard`. The dashboard reads `config.yaml` live, while Telegram cards follow the worker's setting until the worker restarts. The dashboard only answers requests whose Host is `127.0.0.1`, `localhost` or `[::1]` (any port).

Screenshots are saved under `data/screenshots/` (git-ignored; they contain your personal data).

Fill one ready_to_apply job by hand (prints the plan, the result and the screenshot path; never submits — there is no CLI submit; uses the `data/browser-cli` profile, so it can run while the service is up; if the service is running it will then send the Telegram card for that job):

    pnpm --filter @autoapplier/worker cli fill <jobId>
