# Phase 1 — Discover, Filter, Score, Notify, Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local worker that polls job sources every few hours, rejects ineligible/irrelevant postings with free rules, scores the rest with a cheap LLM, pushes good matches to Telegram (Shortlist / Skip), and a read-only Next.js dashboard to browse everything.

**Architecture:** pnpm TypeScript monorepo. `packages/core` holds all domain logic (source adapters, rules, LLM providers, scoring, SQLite via Drizzle) as plain TS consumed directly (no build step). `apps/worker` runs the pipeline on a cron and hosts the Telegram bot (long polling). `apps/web` is a Next.js App Router dashboard reading the same SQLite file. Each job row carries a `status` that acts as the pipeline's state machine.

**Tech Stack:** Node 22 (mise), pnpm workspaces, TypeScript (ESM), Vitest, Drizzle ORM + better-sqlite3, Zod 4, `yaml`, `html-to-text`, `fast-xml-parser`, `@anthropic-ai/sdk`, `openai`, grammY, node-cron, tsx, Next.js 16.

**Spec:** `docs/superpowers/specs/2026-10-03-ai-autoapplier-design.md` (phase 1 = spec §10 item 1; also uses §3, §5.1–5.3, §5.5 partially, §6, §7, §8, §9).

## Global Constraints

- Node 22 via `mise.toml` (`node = "22"`); pnpm workspace; every package `"type": "module"`; TS `moduleResolution: "Bundler"`, extensionless relative imports.
- **No personal data or secrets committed.** `profile/*` (except `*.example.*` and `README.md`), `.env`, `data/`, `*.db` are git-ignored (already in `.gitignore`). The repo is public.
- The user's work repositories and CV PDF are **read-only** sources of context. Never write there.
- No LinkedIn scraping. Only the public endpoints listed in this plan.
- HTTP requests send `user-agent: ai-autoapplier/0.1 (personal job search)` and a 30 s timeout. Sources are fetched sequentially.
- Job statuses (exact strings): `discovered`, `filtered_out`, `passed_rules`, `score_failed`, `ineligible`, `low_score`, `awaiting_review`, `shortlisted`, `skipped`.
- Default scoring model `claude-haiku-4-5` (provider `anthropic`); provider/model come only from `config.yaml`.
- Pay: listed USD pay with hourly-equivalent max < $40 → reject; < $50 → `lowPay = true`. Hourly equivalent: year/2080, month×12/2080.
- Eligibility evidence must be a verbatim substring of the posting context; otherwise eligibility is downgraded to `unlikely`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019HoNfyA6FzHek4ALzhrbCV
  ```

## Review Focus

1. **Greenhouse returns entity-escaped HTML** (`&lt;p&gt;`) — descriptions shown to the LLM, Telegram and dashboard must be readable text, never raw/escaped markup. Pinned in Task 2 and Task 5 tests.
2. **A source is down / 404 / returns garbage** — the run must continue with the other sources, record the error, and deactivate a watched company whose board 404s. Pinned in Task 7 tests.
3. **Same job seen again on every poll, or on two different sources** — must be stored once and notified once. Pinned in Task 4 and Task 11 tests.
4. **LLM returns invalid output or invents an eligibility quote** — one retry, then `score_failed` (bounded by `maxAttempts`); a quote not found in the posting downgrades to `unlikely`; the worker never crashes. Pinned in Task 10 tests.
5. **Telegram button pressed from another chat, twice, or after the job was already handled** — ignored with a message; status changes exactly once. Pinned in Task 11 tests.

Also covered: non-USD pay never triggers the USD floor (Task 8), daily spend cap stops scoring (Task 10).

---

## File Structure

```
mise.toml, package.json, pnpm-workspace.yaml, tsconfig.base.json, .env.example, config.yaml
profile/README.md, profile/profile.example.yaml          (committed)
profile/profile.yaml                                      (git-ignored, Task 12)
packages/core/
  package.json, tsconfig.json, vitest.config.ts, drizzle.config.ts
  drizzle/                         generated SQL migrations
  src/index.ts                     public exports
  src/types.ts                     NormalizedJob, JobStatus, Ats, CompPeriod
  src/root.ts                      findRoot()
  src/text.ts                      htmlToText, dedupeKey, normalizeKey, normalizeForMatch
  src/http.ts                      getText/getJson + HttpError
  src/config.ts                    Config schema + loader
  src/profile.ts                   Profile schema + loader + prompt renderer
  src/db/schema.ts                 Drizzle tables
  src/db/client.ts                 openDb()
  src/db/repo.ts                   all queries
  src/sources/types.ts             Source interface
  src/sources/ats-detect.ts        detectAts, findAtsInHtml
  src/sources/greenhouse.ts | lever.ts | ashby.ts            ATS adapters
  src/sources/remoteok.ts | remotive.ts | himalayas.ts | wwr.ts   board adapters
  src/sources/index.ts             buildSources()
  src/pipeline/discover.ts         runDiscover()
  src/filter/rules.ts              applyRules(), toHourly()
  src/pipeline/filter.ts           runFilter()
  src/llm/provider.ts              LLMProvider, LLMUsage, LLMParseError, costUsd
  src/llm/anthropic.ts | openai.ts | factory.ts
  src/score/schema.ts              ScoreSchema, ScorePayload
  src/score/prompt.ts              jobContextText, buildScoringSystem, buildScoringUser
  src/score/score.ts               evidenceFound, applyEvidenceCheck, decide, scoreJob
  src/pipeline/score.ts            runScore()
  src/eval/metrics.ts              computeEligibilityMetrics()
  test/**                          vitest tests + helpers
apps/worker/
  package.json, tsconfig.json, vitest.config.ts
  src/telegram.ts                  formatJobCard, jobKeyboard, parseCallback, handleDecision, notifyPending, createBot
  src/pipeline.ts                  runPipelineOnce()
  src/bootstrap.ts                 loads env/config/profile/db
  src/main.ts                      cron + bot
  src/cli.ts                       once | smoke | export-eval | eval
  test/telegram.test.ts
apps/web/
  package.json, tsconfig.json, next.config.ts
  app/layout.tsx, app/globals.css, app/page.tsx, app/jobs/[id]/page.tsx, app/stats/page.tsx
  lib/db.ts, lib/format.ts
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `mise.toml`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/core/test/sanity.test.ts`

**Interfaces:**
- Produces: workspace package `@autoapplier/core` (exports `./src/index.ts`), root scripts `test`, `typecheck`.

- [ ] **Step 1: Pin Node 22 and verify pnpm**

```bash
cd /home/hacker/dev/ai-autoapplier
cat > mise.toml <<'EOF'
[tools]
node = "22"
EOF
mise trust && mise install
mise exec -- node -v      # expect v22.x
mise exec -- pnpm -v      # expect a version; if it errors, run: mise exec -- npm i -g pnpm@10
```

All later commands run inside the mise env (`mise exec -- <cmd>`, or a shell where mise is activated).

- [ ] **Step 2: Root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
  - sharp
```

`package.json`:
```json
{
  "name": "ai-autoapplier",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "worker": "pnpm --filter @autoapplier/worker start",
    "once": "pnpm --filter @autoapplier/worker once",
    "web": "pnpm --filter @autoapplier/web dev",
    "db:generate": "pnpm --filter @autoapplier/core db:generate"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`.env.example`:
```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DATABASE_PATH=data/app.db
```

- [ ] **Step 3: Core package skeleton**

`packages/core/package.json`:
```json
{
  "name": "@autoapplier/core",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "db:generate": "drizzle-kit generate"
  }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "drizzle.config.ts", "vitest.config.ts"] }
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

`packages/core/src/index.ts`:
```ts
export const VERSION = '0.1.0';
```

```bash
mise exec -- pnpm --filter @autoapplier/core add zod yaml html-to-text fast-xml-parser drizzle-orm better-sqlite3 @anthropic-ai/sdk openai
mise exec -- pnpm --filter @autoapplier/core add -D vitest typescript @types/node @types/better-sqlite3 @types/html-to-text drizzle-kit
```

- [ ] **Step 4: Sanity test**

`packages/core/test/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index';

describe('core', () => {
  it('loads', () => expect(VERSION).toBe('0.1.0'));
});
```

Run: `mise exec -- pnpm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo with core package"
```
(append the Global Constraints trailer to every commit message)

---

### Task 2: Types, text utilities, ATS detection

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/root.ts`, `packages/core/src/text.ts`, `packages/core/src/sources/ats-detect.ts`
- Test: `packages/core/test/text.test.ts`, `packages/core/test/ats-detect.test.ts`

**Interfaces:**
- Produces:
  - `type Ats = 'greenhouse'|'lever'|'ashby'|'workable'`, `type CompPeriod = 'hour'|'month'|'year'`, `type JobStatus` (9 values above), `JOB_STATUSES: readonly JobStatus[]`, `interface NormalizedJob`
  - `findRoot(start?: string): string`
  - `htmlToText(html: string): string`, `normalizeKey(s: string): string`, `dedupeKey(company: string, title: string): string`, `normalizeForMatch(s: string): string`
  - `detectAts(url: string): { ats: Ats; token: string } | null`, `findAtsInHtml(html: string): { ats: Ats; token: string; url: string } | null`

- [ ] **Step 1: Write failing tests**

`packages/core/test/text.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { htmlToText, dedupeKey, normalizeKey, normalizeForMatch } from '../src/text';

describe('htmlToText', () => {
  it('decodes entity-escaped html (greenhouse style)', () => {
    const out = htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;/ul&gt;');
    expect(out).toContain('Hello & welcome');
    expect(out).toContain('TypeScript');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('<p>');
  });
  it('converts normal html and drops link urls', () => {
    const out = htmlToText('<p>Apply <a href="https://x.com/a">here</a></p>');
    expect(out).toBe('Apply here');
  });
  it('returns empty string for empty input', () => expect(htmlToText('')).toBe(''));
});

describe('keys', () => {
  it('normalizes company + title for dedupe', () => {
    expect(dedupeKey('Acme, Inc.', 'Senior AI Engineer (Remote)')).toBe('acme inc|senior ai engineer remote');
  });
  it('strips accents', () => expect(normalizeKey('México Ñandú')).toBe('mexico nandu'));
  it('normalizeForMatch collapses whitespace and lowercases', () => {
    expect(normalizeForMatch('  Remote\n  LATAM  ')).toBe('remote latam');
  });
});
```

`packages/core/test/ats-detect.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { detectAts, findAtsInHtml } from '../src/sources/ats-detect';

describe('detectAts', () => {
  it.each([
    ['https://job-boards.greenhouse.io/vercel/jobs/123', { ats: 'greenhouse', token: 'vercel' }],
    ['https://boards.greenhouse.io/gitlab/jobs/1', { ats: 'greenhouse', token: 'gitlab' }],
    ['https://boards.greenhouse.io/embed/job_app?for=GitLab&token=1', { ats: 'greenhouse', token: 'gitlab' }],
    ['https://jobs.lever.co/toptal/abc/apply', { ats: 'lever', token: 'toptal' }],
    ['https://jobs.ashbyhq.com/elevenlabs/uuid', { ats: 'ashby', token: 'elevenlabs' }],
    ['https://apply.workable.com/huggingface/j/ABC/', { ats: 'workable', token: 'huggingface' }],
  ])('%s', (url, expected) => expect(detectAts(url)).toEqual(expected));

  it('returns null for non-ATS or invalid urls', () => {
    expect(detectAts('https://remoteok.com/remote-jobs/1')).toBeNull();
    expect(detectAts('not a url')).toBeNull();
    expect(detectAts('https://apply.workable.com/api/v3/x')).toBeNull();
  });
});

describe('findAtsInHtml', () => {
  it('finds the first ATS link', () => {
    const html = '<a href="https://remoteok.com">x</a> <a href="https://jobs.lever.co/acme/1">apply</a>';
    expect(findAtsInHtml(html)).toEqual({ ats: 'lever', token: 'acme', url: 'https://jobs.lever.co/acme/1' });
  });
  it('handles &amp; inside hrefs', () => {
    expect(findAtsInHtml('<a href="https://boards.greenhouse.io/embed/job_app?for=foo&amp;token=2">a</a>'))
      .toEqual({ ats: 'greenhouse', token: 'foo', url: 'https://boards.greenhouse.io/embed/job_app?for=foo&token=2' });
  });
  it('returns null when none', () => expect(findAtsInHtml('<p>no links</p>')).toBeNull());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `mise exec -- pnpm --filter @autoapplier/core test`
Expected: FAIL — cannot resolve `../src/text`, `../src/sources/ats-detect`.

- [ ] **Step 3: Implement**

`packages/core/src/types.ts`:
```ts
export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workable';
export type CompPeriod = 'hour' | 'month' | 'year';

export const JOB_STATUSES = [
  'discovered', 'filtered_out', 'passed_rules', 'score_failed',
  'ineligible', 'low_score', 'awaiting_review', 'shortlisted', 'skipped',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface NormalizedJob {
  source: string;
  sourceJobId: string;
  company: string;
  title: string;
  locationText: string;
  description: string; // plain text
  applyUrl: string;
  ats: Ats | null;
  atsToken: string | null;
  compMin: number | null;
  compMax: number | null;
  compCurrency: string | null;
  compPeriod: CompPeriod | null;
  postedAt: Date;
}
```

`packages/core/src/root.ts`:
```ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findRoot(start: string = process.cwd()): string {
  if (process.env.AUTOAPPLIER_ROOT) return process.env.AUTOAPPLIER_ROOT;
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found (no pnpm-workspace.yaml above cwd)');
    dir = parent;
  }
}
```

`packages/core/src/text.ts`:
```ts
import { convert } from 'html-to-text';

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export function htmlToText(html: string): string {
  if (!html) return '';
  // Greenhouse returns entity-escaped HTML; unescape once so tags are real tags.
  const src = /&lt;\/?[a-z]/i.test(html) ? decodeBasicEntities(html) : html;
  return convert(src, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
    ],
  }).replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeKey(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function dedupeKey(company: string, title: string): string {
  return `${normalizeKey(company)}|${normalizeKey(title)}`;
}

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
```

`packages/core/src/sources/ats-detect.ts`:
```ts
import type { Ats } from '../types';

export function detectAts(url: string): { ats: Ats; token: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const first = seg[0]?.toLowerCase();

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (first === 'embed') {
      const forParam = u.searchParams.get('for');
      return forParam ? { ats: 'greenhouse', token: forParam.toLowerCase() } : null;
    }
    return first ? { ats: 'greenhouse', token: first } : null;
  }
  if (host === 'jobs.lever.co' && first) return { ats: 'lever', token: first };
  if (host === 'jobs.ashbyhq.com' && first) return { ats: 'ashby', token: first };
  if (host === 'apply.workable.com' && first && first !== 'api') return { ats: 'workable', token: first };
  return null;
}

export function findAtsInHtml(html: string): { ats: Ats; token: string; url: string } | null {
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const url = (m[1] ?? '').replace(/&amp;/g, '&');
    const hit = detectAts(url);
    if (hit) return { ...hit, url };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `mise exec -- pnpm --filter @autoapplier/core test`
Expected: all pass. If `htmlToText('<p>Apply <a ...>here</a></p>')` yields extra whitespace, adjust only the `selectors` options — do not loosen the test.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): types, text utils, ATS url detection"`

---

### Task 3: Config and profile loaders

**Files:**
- Create: `packages/core/src/config.ts`, `packages/core/src/profile.ts`, `config.yaml`, `profile/README.md`, `profile/profile.example.yaml`
- Test: `packages/core/test/config.test.ts`, `packages/core/test/profile.test.ts`

**Interfaces:**
- Produces: `ConfigSchema`, `type Config`, `parseConfig(yamlText: string): Config`, `loadConfig(path: string): Config`; `ProfileSchema`, `type Profile`, `parseProfile(yamlText: string): Profile`, `loadProfile(path: string): Profile`, `renderProfileForPrompt(p: Profile): string`.

- [ ] **Step 1: Write `config.yaml` (committed; no personal data)**

```yaml
pollIntervalHours: 3
maxAgeDays: 7

roles:
  # whole-word match against the normalized title (lowercase, punctuation -> space)
  titleInclude: [ai engineer, ai ml, ml engineer, machine learning engineer, llm, applied ai, genai, generative ai,
                 full stack, fullstack, software engineer, software developer, backend engineer, frontend engineer,
                 product engineer, typescript, voice, conversational, agent, agents, agentic, ai developer]
  titleExclude: [intern, internship, junior, jr, director, vp, vice president, head of, manager, sales,
                 account executive, recruiter, designer, data scientist, qa, support, marketing, consultant, lead generation]

eligibility:
  # case-insensitive regexes, tested against location + description
  rejectPatterns:
    - "(must|need to|required to) (be )?(legally )?authori[sz]ed to work in the (u\\.?s\\.?a?|united states)"
    - "(u\\.?s\\.?|united states) citizens?( or (green card|permanent resident)s?( holders?)?)? only"
    - "must be an? (u\\.?s\\.?|united states) citizen"
    - "\\bw-?2 (only|employees? only|position)\\b"
    - "security clearance"
    - "must (reside|live|be located|be based) in the (u\\.?s\\.?a?|united states)"
    - "(only|exclusively) (open|available) to (candidates|applicants|residents) (located |based |residing )?in the (u\\.?s\\.?a?|united states)"
  # tested against each location segment (location split on ; | ·)
  usOnlyLocationPatterns:
    - "^(remote\\s*[-–(,:]?\\s*)?(us|u\\.s\\.|usa|united states( of america)?)\\)?(\\s*[-–]?\\s*(only|remote))?$"
    - "^[a-z .'-]+,\\s*(al|az|ca|co|ct|dc|fl|ga|il|ma|md|mi|mn|nc|nj|ny|oh|or|pa|tn|tx|ut|va|wa|wi)$"
    - "^(san francisco|new york|nyc|seattle|austin|boston|los angeles|chicago|denver|miami)( bay area)?$"
  # if any of these appear in location or description, the US-only location rule does not fire
  allowedRegionPatterns: ["\\bm[eé]xico\\b", "\\blatam\\b", "latin america", "south america", "\\bamericas\\b",
                          "north america", "worldwide", "\\banywhere\\b", "\\bglobal(ly)?\\b", "\\bdeel\\b"]

pay:
  rejectBelowHourly: 40
  lowPriorityBelowHourly: 50

scoring:
  provider: anthropic        # anthropic | openai
  model: claude-haiku-4-5    # openai alternative: set provider: openai and the exact Luna model id from the OpenAI dashboard
  threshold: 65
  maxPerRun: 100
  maxAttempts: 2
  dailySpendCapUsd: 3

pricing:   # USD per 1M tokens
  claude-haiku-4-5: { input: 1, output: 5 }
  claude-sonnet-5-5: { input: 2, output: 10 }
  claude-opus-5-5: { input: 4, output: 20 }
  gpt-5.6-luna: { input: 0.2, output: 1.2 }
  gpt-5.6-terra: { input: 2, output: 12 }
  gpt-5.6-sol: { input: 5, output: 30 }

sources:
  greenhouse: true
  lever: true
  ashby: true
  remoteok: true
  remotive: { enabled: true, categories: [software-development, artificial-intelligence] }
  himalayas: { enabled: true, country: MX, pages: 3, queries: [ai engineer, llm, full stack, voice ai, typescript] }
  wwr:
    enabled: true
    feeds:
      - https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss
      - https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss

# watchlist seed (verified 2026-10-03); grows automatically from board apply links
seedCompanies:
  - { ats: greenhouse, token: gitlab, name: GitLab }
  - { ats: greenhouse, token: remotecom, name: Remote }
  - { ats: greenhouse, token: automatticcareers, name: Automattic }
  - { ats: greenhouse, token: elastic, name: Elastic }
  - { ats: greenhouse, token: canonical, name: Canonical }
  - { ats: ashby, token: zapier, name: Zapier }
  - { ats: ashby, token: close, name: Close }
  - { ats: ashby, token: supabase, name: Supabase }
  - { ats: ashby, token: posthog, name: PostHog }
  - { ats: ashby, token: vapi, name: Vapi }
  - { ats: ashby, token: elevenlabs, name: ElevenLabs }
  - { ats: ashby, token: livekit, name: LiveKit }
  - { ats: lever, token: toptal, name: Toptal }
```

- [ ] **Step 2: Write profile example + README (committed)**

`profile/README.md`:
```md
# profile/

Personal data. Everything here is git-ignored except this README and `*.example.*` files.

- `profile.yaml` — source of truth for skills/experience. Copy `profile.example.yaml` and fill it in.
  The LLM may only select/rephrase facts from this file, never add new ones.
```

`profile/profile.example.yaml`:
```yaml
name: Jane Doe
headline: AI Engineer · Senior Full Stack Developer
location: Somewhere, Mexico
timezone: GMT-7
workAuthorization: >-
  Based in Mexico. Not authorized to work in the US. Available as an independent contractor
  (own entity or EOR such as Deel); no visa sponsorship needed for contractor roles.
englishLevel: C1 (professional working proficiency)
yearsExperience: 5
summary: >-
  Full stack engineer focused on LLM applications and voice agents.
skills:
  ai: [OpenAI API, RAG, Prompt engineering]
  frontend: [React, TypeScript]
  backend: [Node.js, NestJS]
experience:
  - company: Example Co
    role: Senior Full Stack Developer
    start: 2022-08
    end: present
    highlights:
      - Built X that did Y for Z users.
projects:
  - name: Example voice agent
    summary: Voice agent that handles reservations.
    stack: [Python, OpenAI]
```

- [ ] **Step 3: Write failing tests**

`packages/core/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, loadConfig } from '../src/config';
import { findRoot } from '../src/root';

describe('config', () => {
  it('loads the committed config.yaml', () => {
    const cfg = loadConfig(join(findRoot(), 'config.yaml'));
    expect(cfg.scoring.model).toBe('claude-haiku-4-5');
    expect(cfg.pay.rejectBelowHourly).toBe(40);
    expect(cfg.seedCompanies.length).toBeGreaterThan(5);
  });
  it('rejects an invalid regex with a clear message', () => {
    const text = readFileSync(join(findRoot(), 'config.yaml'), 'utf8')
      .replace('rejectPatterns:\n', 'rejectPatterns:\n    - "([unclosed"\n');
    expect(() => parseConfig(text)).toThrow(/invalid regex/i);
  });
  it('rejects missing sections', () => {
    expect(() => parseConfig('pollIntervalHours: 3')).toThrow();
  });
});
```

`packages/core/test/profile.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadProfile, renderProfileForPrompt } from '../src/profile';
import { findRoot } from '../src/root';

describe('profile', () => {
  it('parses the example and renders a prompt block', () => {
    const p = loadProfile(join(findRoot(), 'profile/profile.example.yaml'));
    const text = renderProfileForPrompt(p);
    expect(text).toContain('Jane Doe');
    expect(text).toContain('Work authorization: Based in Mexico');
    expect(text).toContain('- Built X that did Y for Z users.');
    expect(text).toContain('ai: OpenAI API, RAG, Prompt engineering');
  });
});
```

- [ ] **Step 4: Run to verify failure** — `mise exec -- pnpm --filter @autoapplier/core test` → FAIL (modules missing).

- [ ] **Step 5: Implement**

`packages/core/src/config.ts`:
```ts
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

const SeedCompany = z.object({
  ats: z.enum(['greenhouse', 'lever', 'ashby', 'workable']),
  token: z.string().min(1),
  name: z.string().min(1),
});

export const ConfigSchema = z.object({
  pollIntervalHours: z.number().int().positive(),
  maxAgeDays: z.number().positive(),
  roles: z.object({ titleInclude: z.array(z.string()).min(1), titleExclude: z.array(z.string()) }),
  eligibility: z.object({
    rejectPatterns: z.array(z.string()),
    usOnlyLocationPatterns: z.array(z.string()),
    allowedRegionPatterns: z.array(z.string()),
  }),
  pay: z.object({ rejectBelowHourly: z.number(), lowPriorityBelowHourly: z.number() }),
  scoring: z.object({
    provider: z.enum(['anthropic', 'openai']),
    model: z.string().min(1),
    threshold: z.number().min(0).max(100),
    maxPerRun: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    dailySpendCapUsd: z.number().positive(),
  }),
  pricing: z.record(z.string(), z.object({ input: z.number(), output: z.number() })),
  sources: z.object({
    greenhouse: z.boolean(),
    lever: z.boolean(),
    ashby: z.boolean(),
    remoteok: z.boolean(),
    remotive: z.object({ enabled: z.boolean(), categories: z.array(z.string()) }),
    himalayas: z.object({
      enabled: z.boolean(), country: z.string(), pages: z.number().int().positive(), queries: z.array(z.string()),
    }),
    wwr: z.object({ enabled: z.boolean(), feeds: z.array(z.string()) }),
  }),
  seedCompanies: z.array(SeedCompany),
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(yamlText: string): Config {
  const cfg = ConfigSchema.parse(YAML.parse(yamlText));
  const { rejectPatterns, usOnlyLocationPatterns, allowedRegionPatterns } = cfg.eligibility;
  for (const p of [...rejectPatterns, ...usOnlyLocationPatterns, ...allowedRegionPatterns]) {
    try { new RegExp(p, 'i'); } catch (e) {
      throw new Error(`config: invalid regex "${p}": ${(e as Error).message}`);
    }
  }
  return cfg;
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}
```

`packages/core/src/profile.ts`:
```ts
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

export const ProfileSchema = z.object({
  name: z.string(),
  headline: z.string(),
  location: z.string(),
  timezone: z.string(),
  workAuthorization: z.string(),
  englishLevel: z.string(),
  yearsExperience: z.number(),
  summary: z.string(),
  skills: z.record(z.string(), z.array(z.string())),
  experience: z.array(z.object({
    company: z.string(), role: z.string(), start: z.coerce.string(), end: z.coerce.string(),
    highlights: z.array(z.string()),
  })),
  projects: z.array(z.object({ name: z.string(), summary: z.string(), stack: z.array(z.string()) })).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(yamlText: string): Profile {
  return ProfileSchema.parse(YAML.parse(yamlText));
}

export function loadProfile(path: string): Profile {
  return parseProfile(readFileSync(path, 'utf8'));
}

export function renderProfileForPrompt(p: Profile): string {
  const lines = [
    `Name: ${p.name}`,
    `Headline: ${p.headline}`,
    `Location: ${p.location} (${p.timezone})`,
    `Work authorization: ${p.workAuthorization}`,
    `English: ${p.englishLevel}`,
    `Years of experience: ${p.yearsExperience}`,
    `Summary: ${p.summary}`,
    'Skills:',
    ...Object.entries(p.skills).map(([k, v]) => `  ${k}: ${v.join(', ')}`),
    'Experience:',
  ];
  for (const e of p.experience) {
    lines.push(`* ${e.role} — ${e.company} (${e.start} – ${e.end})`);
    for (const h of e.highlights) lines.push(`  - ${h}`);
  }
  if (p.projects.length) {
    lines.push('Projects:');
    for (const pr of p.projects) lines.push(`* ${pr.name}: ${pr.summary} [${pr.stack.join(', ')}]`);
  }
  return lines.join('\n');
}
```

Note: the profile test expects `'- Built X that did Y for Z users.'` — that substring is present inside `'  - Built X…'`.

- [ ] **Step 6: Run tests** — expected PASS. (YAML parses `2022-08` as a string; `z.coerce.string()` protects against YAML dates.)

- [ ] **Step 7: Commit** — `git commit -m "feat(core): config and profile loaders"`

---

### Task 4: Database schema, client, repository

**Files:**
- Create: `packages/core/src/score/schema.ts`, `packages/core/src/db/schema.ts`, `packages/core/src/db/client.ts`, `packages/core/src/db/repo.ts`, `packages/core/drizzle.config.ts`, `packages/core/drizzle/*` (generated), `packages/core/test/helpers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/repo.test.ts`

**Interfaces:**
- Consumes: `NormalizedJob`, `JobStatus`, `Ats`, `CompPeriod`, `dedupeKey`, `findRoot`.
- Produces:
  - `ScoreSchema` (zod), `type ScorePayload`
  - `openDb(path: string, opts?: { migrate?: boolean; readonly?: boolean }): Db`, `type Db`
  - tables `companies`, `jobs`, `scores`, `jobEvents`, `llmUsage`; `type JobRow`, `type CompanyRow`, `type JobEventRow`
  - repo: `insertJobs(db, list: NormalizedJob[], now?: Date): number`; `getJob(db, id: number): JobRow | undefined`; `listJobsByStatus(db, statuses: JobStatus[], limit?: number): JobRow[]`; `listJobsForScoring(db, maxAttempts: number, limit: number): JobRow[]`; `listUnnotified(db, limit: number): JobRow[]`; `setStatus(db, jobId: number, to: JobStatus, note?: string | null, patch?: StatusPatch, now?: Date): void`; `markNotified(db, jobId: number, now?: Date): void`; `insertScore(db, jobId: number, model: string, payload: ScorePayload, now?: Date): void`; `latestScore(db, jobId: number): ScorePayload | undefined`; `recordUsage(db, u: UsageInput, now?: Date): void`; `spendSince(db, since: Date): number`; `upsertCompany(db, c: { ats: Ats; token: string; name: string; source: string }): void`; `listActiveCompanies(db): CompanyRow[]`; `deactivateCompany(db, id: number): void`; `markPolled(db, id: number, now?: Date): void`; `listEvents(db, jobId: number): JobEventRow[]`; `countByStatus(db): { status: JobStatus; count: number }[]`; `countBySource(db): { source: string; count: number }[]`; `spendByDay(db, days?: number): { day: string; costUsd: number }[]`
  - `interface StatusPatch { filterReason?: string | null; lowPay?: boolean; scoreAttempts?: number }`
  - `interface UsageInput { jobId: number | null; stage: string; provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }`
  - test helper `makeJob(overrides?: Partial<NormalizedJob>): NormalizedJob`, `testDb(): Db`

- [ ] **Step 1: Score schema (needed by db types)**

`packages/core/src/score/schema.ts`:
```ts
import { z } from 'zod';

// No numeric min/max here: structured-output backends may reject them. Clamp in code.
export const ScoreSchema = z.object({
  eligibility: z.enum(['eligible', 'likely', 'unlikely', 'ineligible']),
  eligibilityEvidence: z.string(),
  fitScore: z.number(),
  roleCategory: z.enum(['ai', 'fullstack', 'voice', 'other']),
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  redFlags: z.array(z.string()),
  compEstimate: z.string().nullable(),
});
export type ScorePayload = z.infer<typeof ScoreSchema>;
```

- [ ] **Step 2: Drizzle schema**

`packages/core/src/db/schema.ts`:
```ts
import { sqliteTable, integer, text, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import type { Ats, CompPeriod, JobStatus } from '../types';
import type { ScorePayload } from '../score/schema';

export const companies = sqliteTable('companies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  ats: text('ats').$type<Ats>().notNull(),
  token: text('token').notNull(),
  source: text('source').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastPolledAt: integer('last_polled_at', { mode: 'timestamp' }),
}, (t) => [uniqueIndex('companies_ats_token').on(t.ats, t.token)]);

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  sourceJobId: text('source_job_id').notNull(),
  company: text('company').notNull(),
  title: text('title').notNull(),
  locationText: text('location_text').notNull(),
  description: text('description').notNull(),
  applyUrl: text('apply_url').notNull(),
  ats: text('ats').$type<Ats>(),
  atsToken: text('ats_token'),
  compMin: real('comp_min'),
  compMax: real('comp_max'),
  compCurrency: text('comp_currency'),
  compPeriod: text('comp_period').$type<CompPeriod>(),
  postedAt: integer('posted_at', { mode: 'timestamp' }).notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  status: text('status').$type<JobStatus>().notNull().default('discovered'),
  filterReason: text('filter_reason'),
  lowPay: integer('low_pay', { mode: 'boolean' }).notNull().default(false),
  scoreAttempts: integer('score_attempts').notNull().default(0),
  notifiedAt: integer('notified_at', { mode: 'timestamp' }),
}, (t) => [uniqueIndex('jobs_dedupe_key').on(t.dedupeKey), index('jobs_status').on(t.status)]);

export const scores = sqliteTable('scores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  model: text('model').notNull(),
  payload: text('payload', { mode: 'json' }).$type<ScorePayload>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('scores_job').on(t.jobId)]);

export const jobEvents = sqliteTable('job_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  fromStatus: text('from_status').$type<JobStatus>(),
  toStatus: text('to_status').$type<JobStatus>().notNull(),
  note: text('note'),
  at: integer('at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('job_events_job').on(t.jobId)]);

export const llmUsage = sqliteTable('llm_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id'),
  stage: text('stage').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
});
```

`packages/core/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'sqlite', schema: './src/db/schema.ts', out: './drizzle' });
```

Run: `mise exec -- pnpm db:generate`
Expected: `packages/core/drizzle/0000_*.sql` and `drizzle/meta/` created.

- [ ] **Step 3: DB client**

`packages/core/src/db/client.ts`:
```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as schema from './schema';
import { findRoot } from '../root';

export function openDb(path: string, opts: { migrate?: boolean; readonly?: boolean } = {}) {
  const { migrate: runMigrations = true, readonly = false } = opts;
  if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { readonly, fileMustExist: readonly });
  if (!readonly) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
  }
  const db = drizzle(sqlite, { schema });
  if (runMigrations && !readonly) {
    migrate(db, { migrationsFolder: join(findRoot(), 'packages/core/drizzle') });
  }
  return db;
}
export type Db = ReturnType<typeof openDb>;
```

- [ ] **Step 4: Test helpers + failing repo tests**

`packages/core/test/helpers.ts`:
```ts
import type { NormalizedJob } from '../src/types';
import { openDb } from '../src/db/client';

let seq = 0;
export function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  seq += 1;
  return {
    source: 'greenhouse',
    sourceJobId: String(seq),
    company: 'Acme',
    title: `Senior AI Engineer ${seq}`,
    locationText: 'Remote - LATAM',
    description: 'We hire contractors anywhere in Latin America. TypeScript, LLMs, RAG.',
    applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${seq}`,
    ats: 'greenhouse',
    atsToken: 'acme',
    compMin: null,
    compMax: null,
    compCurrency: null,
    compPeriod: null,
    postedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

export function testDb() {
  return openDb(':memory:');
}
```

`packages/core/test/repo.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { makeJob, testDb } from './helpers';
import {
  insertJobs, getJob, listJobsByStatus, listJobsForScoring, setStatus, listEvents, insertScore, latestScore,
  recordUsage, spendSince, upsertCompany, listActiveCompanies, deactivateCompany, listUnnotified, markNotified,
  countByStatus, spendByDay,
} from '../src/db/repo';
import type { ScorePayload } from '../src/score/schema';

const score: ScorePayload = {
  eligibility: 'eligible', eligibilityEvidence: 'anywhere in Latin America', fitScore: 80,
  roleCategory: 'ai', matched: ['TypeScript'], missing: [], redFlags: [], compEstimate: null,
};

describe('repo', () => {
  it('dedupes on company+title across polls and sources', () => {
    const db = testDb();
    const a = makeJob({ company: 'Acme', title: 'AI Engineer' });
    expect(insertJobs(db, [a])).toBe(1);
    expect(insertJobs(db, [a])).toBe(0);
    expect(insertJobs(db, [{ ...a, source: 'remoteok', sourceJobId: 'x', company: 'ACME' }])).toBe(0);
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(1);
  });

  it('setStatus updates row and writes an event', () => {
    const db = testDb();
    insertJobs(db, [makeJob()]);
    const [job] = listJobsByStatus(db, ['discovered']);
    setStatus(db, job!.id, 'filtered_out', 'title', { filterReason: 'title: no include match' });
    const updated = getJob(db, job!.id)!;
    expect(updated.status).toBe('filtered_out');
    expect(updated.filterReason).toBe('title: no include match');
    const events = listEvents(db, job!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: 'discovered', toStatus: 'filtered_out', note: 'title' });
  });

  it('listJobsForScoring respects statuses and attempts', () => {
    const db = testDb();
    insertJobs(db, [makeJob(), makeJob(), makeJob()]);
    const [a, b, c] = listJobsByStatus(db, ['discovered']);
    setStatus(db, a!.id, 'passed_rules');
    setStatus(db, b!.id, 'score_failed', 'err', { scoreAttempts: 2 });
    setStatus(db, c!.id, 'score_failed', 'err', { scoreAttempts: 1 });
    const ids = listJobsForScoring(db, 2, 10).map((j) => j.id).sort();
    expect(ids).toEqual([a!.id, c!.id].sort());
  });

  it('scores round-trip as json', () => {
    const db = testDb();
    insertJobs(db, [makeJob()]);
    const [job] = listJobsByStatus(db, ['discovered']);
    insertScore(db, job!.id, 'm', { ...score, fitScore: 10 });
    insertScore(db, job!.id, 'm', score);
    expect(latestScore(db, job!.id)).toEqual(score);
  });

  it('tracks spend since a date and by day', () => {
    const db = testDb();
    const u = { jobId: null, stage: 'score', provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1 };
    recordUsage(db, { ...u, costUsd: 0.5 }, new Date('2026-10-02T10:00:00Z'));
    recordUsage(db, { ...u, costUsd: 0.25 }, new Date('2026-10-03T10:00:00Z'));
    expect(spendSince(db, new Date('2026-10-03T00:00:00Z'))).toBeCloseTo(0.25);
    expect(spendByDay(db)).toEqual([{ day: '2026-10-03', costUsd: 0.25 }, { day: '2026-10-02', costUsd: 0.5 }]);
  });

  it('companies: upsert is idempotent, deactivate hides', () => {
    const db = testDb();
    upsertCompany(db, { ats: 'lever', token: 'Acme', name: 'Acme', source: 'seed' });
    upsertCompany(db, { ats: 'lever', token: 'acme', name: 'Acme 2', source: 'remoteok' });
    const list = listActiveCompanies(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.token).toBe('acme');
    deactivateCompany(db, list[0]!.id);
    expect(listActiveCompanies(db)).toHaveLength(0);
  });

  it('unnotified awaiting_review jobs', () => {
    const db = testDb();
    insertJobs(db, [makeJob(), makeJob()]);
    const [a, b] = listJobsByStatus(db, ['discovered']);
    setStatus(db, a!.id, 'awaiting_review');
    setStatus(db, b!.id, 'awaiting_review');
    markNotified(db, a!.id);
    expect(listUnnotified(db, 10).map((j) => j.id)).toEqual([b!.id]);
    expect(countByStatus(db)).toEqual([{ status: 'awaiting_review', count: 2 }]);
  });
});
```

Run: `mise exec -- pnpm --filter @autoapplier/core test` → FAIL (repo missing).

- [ ] **Step 5: Implement repo**

`packages/core/src/db/repo.ts`:
```ts
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { companies, jobEvents, jobs, llmUsage, scores } from './schema';
import type { Ats, JobStatus, NormalizedJob } from '../types';
import type { ScorePayload } from '../score/schema';
import { dedupeKey } from '../text';

export type JobRow = typeof jobs.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;

export interface StatusPatch { filterReason?: string | null; lowPay?: boolean; scoreAttempts?: number }
export interface UsageInput {
  jobId: number | null; stage: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; costUsd: number;
}

export function insertJobs(db: Db, list: NormalizedJob[], now = new Date()): number {
  return db.transaction((tx) => {
    let n = 0;
    for (const j of list) {
      const r = tx.insert(jobs)
        .values({ ...j, dedupeKey: dedupeKey(j.company, j.title), fetchedAt: now, updatedAt: now })
        .onConflictDoNothing({ target: jobs.dedupeKey })
        .run();
      n += r.changes;
    }
    return n;
  });
}

export function getJob(db: Db, id: number): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobsByStatus(db: Db, statuses: JobStatus[], limit = 500): JobRow[] {
  return db.select().from(jobs).where(inArray(jobs.status, statuses))
    .orderBy(desc(jobs.postedAt), asc(jobs.id)).limit(limit).all();
}

export function listJobsForScoring(db: Db, maxAttempts: number, limit: number): JobRow[] {
  return db.select().from(jobs)
    .where(and(inArray(jobs.status, ['passed_rules', 'score_failed']), lt(jobs.scoreAttempts, maxAttempts)))
    .orderBy(desc(jobs.postedAt), asc(jobs.id)).limit(limit).all();
}

export function listUnnotified(db: Db, limit: number): JobRow[] {
  return db.select().from(jobs)
    .where(and(eq(jobs.status, 'awaiting_review'), isNull(jobs.notifiedAt)))
    .orderBy(desc(jobs.postedAt), asc(jobs.id)).limit(limit).all();
}

export function setStatus(
  db: Db, jobId: number, to: JobStatus, note: string | null = null, patch: StatusPatch = {}, now = new Date(),
): void {
  db.transaction((tx) => {
    const cur = tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (!cur) throw new Error(`job ${jobId} not found`);
    tx.update(jobs).set({ status: to, updatedAt: now, ...patch }).where(eq(jobs.id, jobId)).run();
    tx.insert(jobEvents).values({ jobId, fromStatus: cur.status, toStatus: to, note, at: now }).run();
  });
}

export function markNotified(db: Db, jobId: number, now = new Date()): void {
  db.update(jobs).set({ notifiedAt: now }).where(eq(jobs.id, jobId)).run();
}

export function insertScore(db: Db, jobId: number, model: string, payload: ScorePayload, now = new Date()): void {
  db.insert(scores).values({ jobId, model, payload, createdAt: now }).run();
}

export function latestScore(db: Db, jobId: number): ScorePayload | undefined {
  return db.select({ payload: scores.payload }).from(scores).where(eq(scores.jobId, jobId))
    .orderBy(desc(scores.id)).limit(1).get()?.payload;
}

export function recordUsage(db: Db, u: UsageInput, now = new Date()): void {
  db.insert(llmUsage).values({ ...u, at: now }).run();
}

export function spendSince(db: Db, since: Date): number {
  const r = db.select({ total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage).where(gte(llmUsage.at, since)).get();
  return r?.total ?? 0;
}

export function upsertCompany(db: Db, c: { ats: Ats; token: string; name: string; source: string }): void {
  db.insert(companies).values({ ...c, token: c.token.toLowerCase() })
    .onConflictDoNothing({ target: [companies.ats, companies.token] }).run();
}

export function listActiveCompanies(db: Db): CompanyRow[] {
  return db.select().from(companies).where(eq(companies.active, true)).orderBy(asc(companies.id)).all();
}

export function deactivateCompany(db: Db, id: number): void {
  db.update(companies).set({ active: false }).where(eq(companies.id, id)).run();
}

export function markPolled(db: Db, id: number, now = new Date()): void {
  db.update(companies).set({ lastPolledAt: now }).where(eq(companies.id, id)).run();
}

export function listEvents(db: Db, jobId: number): JobEventRow[] {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(asc(jobEvents.id)).all();
}

export function countByStatus(db: Db): { status: JobStatus; count: number }[] {
  return db.select({ status: jobs.status, count: sql<number>`count(*)` }).from(jobs)
    .groupBy(jobs.status).orderBy(asc(jobs.status)).all();
}

export function countBySource(db: Db): { source: string; count: number }[] {
  return db.select({ source: jobs.source, count: sql<number>`count(*)` }).from(jobs)
    .groupBy(jobs.source).orderBy(desc(sql`count(*)`)).all();
}

export function spendByDay(db: Db, days = 14): { day: string; costUsd: number }[] {
  const day = sql<string>`date(${llmUsage.at}, 'unixepoch')`;
  return db.select({ day, costUsd: sql<number>`sum(${llmUsage.costUsd})` }).from(llmUsage)
    .groupBy(day).orderBy(desc(day)).limit(days).all();
}
```

Update `packages/core/src/index.ts`:
```ts
export const VERSION = '0.1.0';
export * from './types';
export * from './root';
export * from './text';
export * from './config';
export * from './profile';
export * from './score/schema';
export * from './db/schema';
export * from './db/client';
export * from './db/repo';
```

- [ ] **Step 6: Run tests** — expected PASS. Then `mise exec -- pnpm typecheck` → no errors.

- [ ] **Step 7: Commit** — `git commit -m "feat(core): sqlite schema, migrations and repository"`

---

### Task 5: HTTP helper and ATS adapters (Greenhouse, Lever, Ashby)

**Files:**
- Create: `packages/core/src/http.ts`, `packages/core/src/sources/types.ts`, `packages/core/src/sources/greenhouse.ts`, `packages/core/src/sources/lever.ts`, `packages/core/src/sources/ashby.ts`
- Test: `packages/core/test/sources-ats.test.ts`

**Interfaces:**
- Consumes: `NormalizedJob`, `htmlToText`, `CompanyRow`.
- Produces:
  - `class HttpError extends Error { status: number }`, `getText(url: string, init?: RequestInit): Promise<string>`, `getJson<T>(url: string, init?: RequestInit): Promise<T>`
  - `interface Source { name: string; companyId?: number; fetchJobs(): Promise<NormalizedJob[]> }`
  - `parseGreenhouse(token: string, raw: unknown): NormalizedJob[]`, `greenhouseSource(c: { id: number; token: string }): Source`
  - `parseLever(token: string, company: string, raw: unknown): NormalizedJob[]`, `leverSource(c: { id: number; token: string; name: string }): Source`
  - `parseAshby(token: string, company: string, raw: unknown): NormalizedJob[]`, `ashbySource(c: { id: number; token: string; name: string }): Source`

Endpoint facts (verified 2026-10-03):
- Greenhouse `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` → `{ jobs: [{ id, title, absolute_url, first_published, updated_at, location: { name }, content (entity-escaped HTML), company_name }] }`
- Lever `GET https://api.lever.co/v0/postings/{token}?mode=json` → array of `{ id, text, hostedUrl, applyUrl, createdAt (ms), categories: { location, allLocations[] }, workplaceType, descriptionPlain, lists: [{ text, content(html) }], additionalPlain, salaryRange: { min, max, currency, interval } | null }`. Unknown company → `{"ok":false,"error":"Document not found"}` with HTTP 404.
- Ashby `GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true` → `{ jobs: [{ id, title, jobUrl, applyUrl, publishedAt, location, secondaryLocations: [{ location }], workplaceType, isRemote, isListed, descriptionPlain, compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR'|'1 MONTH'|'1 HOUR'|'NONE', currencyCode, minValue, maxValue }] } }] }`

- [ ] **Step 1: Write failing tests**

`packages/core/test/sources-ats.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseGreenhouse } from '../src/sources/greenhouse';
import { parseLever } from '../src/sources/lever';
import { parseAshby } from '../src/sources/ashby';

describe('parseGreenhouse', () => {
  const raw = { jobs: [{
    id: 6136160004, title: ' Senior AI Engineer ', absolute_url: 'https://job-boards.greenhouse.io/vercel/jobs/6136160004',
    first_published: '2026-09-30T12:50:10-04:00', updated_at: '2026-10-01T13:34:54-04:00',
    location: { name: 'Remote - Americas' }, company_name: 'Vercel',
    content: '&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Build agents &amp;amp; RAG.&lt;/p&gt;',
  }] };

  it('normalizes jobs and decodes escaped html', () => {
    const [j] = parseGreenhouse('vercel', raw);
    expect(j).toMatchObject({
      source: 'greenhouse', sourceJobId: '6136160004', company: 'Vercel', title: 'Senior AI Engineer',
      locationText: 'Remote - Americas', ats: 'greenhouse', atsToken: 'vercel',
      applyUrl: 'https://job-boards.greenhouse.io/vercel/jobs/6136160004', compMax: null,
    });
    expect(j!.description).toContain('Build agents & RAG.');
    expect(j!.description).not.toContain('&lt;');
    expect(j!.postedAt.toISOString()).toBe('2026-09-30T16:50:10.000Z');
  });

  it('falls back to updated_at and token when fields are missing', () => {
    const [j] = parseGreenhouse('acme', { jobs: [{ id: 1, title: 'X', absolute_url: 'u', updated_at: '2026-10-01T00:00:00Z', content: null, location: null }] });
    expect(j!.company).toBe('acme');
    expect(j!.locationText).toBe('');
    expect(j!.description).toBe('');
    expect(j!.postedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('throws on unexpected shape', () => {
    expect(() => parseGreenhouse('x', { nope: true })).toThrow(/greenhouse/);
  });
});

describe('parseLever', () => {
  const raw = [{
    id: 'abc', text: 'Full Stack Engineer', hostedUrl: 'https://jobs.lever.co/toptal/abc',
    applyUrl: 'https://jobs.lever.co/toptal/abc/apply', createdAt: 1790000000000,
    categories: { location: 'Mexico', allLocations: ['Mexico', 'Brazil'] }, workplaceType: 'remote',
    descriptionPlain: 'Intro text.', lists: [{ text: 'Requirements', content: '<li>TypeScript</li><li>NestJS</li>' }],
    additionalPlain: 'Contractor role.', salaryRange: { min: 50, max: 70, currency: 'USD', interval: 'per-hour-wage' },
  }];

  it('normalizes jobs including lists and salary', () => {
    const [j] = parseLever('toptal', 'Toptal', raw);
    expect(j).toMatchObject({
      source: 'lever', sourceJobId: 'abc', company: 'Toptal', title: 'Full Stack Engineer',
      locationText: 'Mexico; Brazil', applyUrl: 'https://jobs.lever.co/toptal/abc/apply',
      ats: 'lever', atsToken: 'toptal', compMin: 50, compMax: 70, compCurrency: 'USD', compPeriod: 'hour',
    });
    expect(j!.description).toContain('Workplace: remote');
    expect(j!.description).toContain('Requirements');
    expect(j!.description).toContain('NestJS');
    expect(j!.description).toContain('Contractor role.');
    expect(j!.postedAt.getTime()).toBe(1790000000000);
  });

  it('maps yearly salary and missing salary', () => {
    const [a] = parseLever('t', 'T', [{ ...raw[0], salaryRange: { min: 1, max: 2, currency: 'USD', interval: 'per-year-salary' } }]);
    expect(a!.compPeriod).toBe('year');
    const [b] = parseLever('t', 'T', [{ ...raw[0], salaryRange: null }]);
    expect(b!.compMax).toBeNull();
    expect(b!.compPeriod).toBeNull();
  });
});

describe('parseAshby', () => {
  const raw = { jobs: [
    {
      id: 'u1', title: 'Voice AI Engineer', jobUrl: 'https://jobs.ashbyhq.com/vapi/u1', applyUrl: 'https://jobs.ashbyhq.com/vapi/u1/application',
      publishedAt: '2026-10-01T17:12:35.753+00:00', location: 'Remote (US)', secondaryLocations: [{ location: 'Remote (Mexico)' }],
      workplaceType: 'Remote', isRemote: true, isListed: true, descriptionPlain: 'Build voice agents.',
      compensation: { summaryComponents: [
        { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
        { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150000, maxValue: 200000 },
      ] },
    },
    { id: 'u2', title: 'Hidden', jobUrl: 'x', publishedAt: '2026-10-01T00:00:00Z', isListed: false, descriptionPlain: '' },
  ] };

  it('normalizes listed jobs with compensation and secondary locations', () => {
    const list = parseAshby('vapi', 'Vapi', raw);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      source: 'ashby', sourceJobId: 'u1', company: 'Vapi', locationText: 'Remote (US); Remote (Mexico)',
      applyUrl: 'https://jobs.ashbyhq.com/vapi/u1/application', compMin: 150000, compMax: 200000,
      compCurrency: 'USD', compPeriod: 'year', ats: 'ashby', atsToken: 'vapi',
    });
    expect(list[0]!.description).toContain('Workplace: Remote');
    expect(list[0]!.description).toContain('Build voice agents.');
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (modules missing).

- [ ] **Step 3: Implement**

`packages/core/src/http.ts`:
```ts
export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

const UA = 'ai-autoapplier/0.1 (personal job search)';

export async function getText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export async function getJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const text = await getText(url, init);
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`invalid JSON from ${url}: ${text.slice(0, 120)}`);
  }
}
```

`packages/core/src/sources/types.ts`:
```ts
import type { NormalizedJob } from '../types';

export interface Source {
  name: string;
  companyId?: number; // set for per-company ATS sources (deactivated on 404)
  fetchJobs(): Promise<NormalizedJob[]>;
}
```

`packages/core/src/sources/greenhouse.ts`:
```ts
import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';

interface GhJob {
  id: number; title: string; absolute_url: string; first_published?: string | null; updated_at: string;
  location?: { name?: string } | null; content?: string | null; company_name?: string | null;
}

export function parseGreenhouse(token: string, raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error(`greenhouse:${token}: unexpected response shape`);
  return (list as GhJob[]).map((j) => ({
    source: 'greenhouse',
    sourceJobId: String(j.id),
    company: j.company_name?.trim() || token,
    title: j.title.trim(),
    locationText: j.location?.name?.trim() ?? '',
    description: htmlToText(j.content ?? ''),
    applyUrl: j.absolute_url,
    ats: 'greenhouse',
    atsToken: token,
    compMin: null, compMax: null, compCurrency: null, compPeriod: null,
    postedAt: new Date(j.first_published ?? j.updated_at),
  }));
}

export function greenhouseSource(c: { id: number; token: string }): Source {
  return {
    name: `greenhouse:${c.token}`,
    companyId: c.id,
    fetchJobs: async () =>
      parseGreenhouse(c.token, await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.token)}/jobs?content=true`)),
  };
}
```

`packages/core/src/sources/lever.ts`:
```ts
import type { CompPeriod, NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';

interface LeverJob {
  id: string; text: string; hostedUrl: string; applyUrl?: string; createdAt: number;
  categories?: { location?: string; allLocations?: string[] };
  workplaceType?: string; descriptionPlain?: string; additionalPlain?: string;
  lists?: { text: string; content: string }[];
  salaryRange?: { min: number; max: number; currency: string; interval: string } | null;
}

function leverPeriod(interval: string): CompPeriod {
  if (interval.includes('hour')) return 'hour';
  if (interval.includes('month')) return 'month';
  return 'year';
}

export function parseLever(token: string, company: string, raw: unknown): NormalizedJob[] {
  if (!Array.isArray(raw)) throw new Error(`lever:${token}: unexpected response shape`);
  return (raw as LeverJob[]).map((j) => {
    const locs = j.categories?.allLocations?.length ? j.categories.allLocations : [j.categories?.location ?? ''];
    const parts = [
      j.workplaceType ? `Workplace: ${j.workplaceType}` : '',
      j.descriptionPlain ?? '',
      ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`),
      j.additionalPlain ?? '',
    ].filter(Boolean);
    const s = j.salaryRange;
    return {
      source: 'lever',
      sourceJobId: j.id,
      company,
      title: j.text.trim(),
      locationText: locs.filter(Boolean).join('; '),
      description: parts.join('\n\n').trim(),
      applyUrl: j.applyUrl ?? j.hostedUrl,
      ats: 'lever',
      atsToken: token,
      compMin: s?.min ?? null,
      compMax: s?.max ?? null,
      compCurrency: s?.currency ?? null,
      compPeriod: s ? leverPeriod(s.interval) : null,
      postedAt: new Date(j.createdAt),
    };
  });
}

export function leverSource(c: { id: number; token: string; name: string }): Source {
  return {
    name: `lever:${c.token}`,
    companyId: c.id,
    fetchJobs: async () =>
      parseLever(c.token, c.name, await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(c.token)}?mode=json`)),
  };
}
```

`packages/core/src/sources/ashby.ts`:
```ts
import type { CompPeriod, NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';

interface AshbyComp { compensationType: string; interval: string; currencyCode: string | null; minValue: number | null; maxValue: number | null }
interface AshbyJob {
  id: string; title: string; jobUrl: string; applyUrl?: string; publishedAt: string;
  location?: string; secondaryLocations?: { location: string }[]; workplaceType?: string | null;
  isListed?: boolean; descriptionPlain?: string;
  compensation?: { summaryComponents?: AshbyComp[] } | null;
}

const PERIODS: Record<string, CompPeriod> = { '1 YEAR': 'year', '1 MONTH': 'month', '1 HOUR': 'hour' };

export function parseAshby(token: string, company: string, raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error(`ashby:${token}: unexpected response shape`);
  return (list as AshbyJob[]).filter((j) => j.isListed !== false).map((j) => {
    const salary = j.compensation?.summaryComponents?.find((c) => c.compensationType === 'Salary' && PERIODS[c.interval]);
    const locs = [j.location ?? '', ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean);
    return {
      source: 'ashby',
      sourceJobId: j.id,
      company,
      title: j.title.trim(),
      locationText: locs.join('; '),
      description: [j.workplaceType ? `Workplace: ${j.workplaceType}` : '', j.descriptionPlain ?? ''].filter(Boolean).join('\n\n').trim(),
      applyUrl: j.applyUrl ?? j.jobUrl,
      ats: 'ashby',
      atsToken: token,
      compMin: salary?.minValue ?? null,
      compMax: salary?.maxValue ?? null,
      compCurrency: salary?.currencyCode ?? null,
      compPeriod: salary ? PERIODS[salary.interval]! : null,
      postedAt: new Date(j.publishedAt),
    };
  });
}

export function ashbySource(c: { id: number; token: string; name: string }): Source {
  return {
    name: `ashby:${c.token}`,
    companyId: c.id,
    fetchJobs: async () =>
      parseAshby(c.token, c.name, await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.token)}?includeCompensation=true`)),
  };
}
```

- [ ] **Step 4: Run tests** — expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): greenhouse, lever and ashby source adapters"`

---

### Task 6: Job board adapters (RemoteOK, Remotive, Himalayas, WWR)

**Files:**
- Create: `packages/core/src/sources/remoteok.ts`, `packages/core/src/sources/remotive.ts`, `packages/core/src/sources/himalayas.ts`, `packages/core/src/sources/wwr.ts`
- Test: `packages/core/test/sources-boards.test.ts`

**Interfaces:**
- Consumes: `Source`, `getJson`, `getText`, `htmlToText`, `findAtsInHtml`.
- Produces: `parseRemoteOk(raw: unknown): NormalizedJob[]`, `remoteOkSource(): Source`; `parseRemotive(raw: unknown): NormalizedJob[]`, `remotiveSource(category: string): Source`; `parseHimalayas(raw: unknown): NormalizedJob[]`, `himalayasSource(query: string, country: string, pages: number): Source`; `parseWwr(xml: string): NormalizedJob[]`, `wwrSource(feedUrl: string): Source`.

Endpoint facts (verified 2026-10-03):
- RemoteOK `GET https://remoteok.com/api` → array; element 0 is `{ last_updated, legal }` (skip), others `{ id, epoch, date, company, position, location, salary_min, salary_max (USD/yr, 0 = none), url, apply_url, description (html), tags[] }`.
- Remotive `GET https://remotive.com/api/remote-jobs?category={slug}` → `{ jobs: [{ id, url, title, company_name, publication_date ('2026-09-30T13:15:26', no tz → UTC), candidate_required_location, salary (free text), description (html) }] }`.
- Himalayas `GET https://himalayas.app/jobs/api/search?q={q}&country={CC}&sort=recent&offset={n}` → `{ jobs: [...] }`, 20 per page; job `{ guid, title, companyName, locationRestrictions[] ([] = anywhere), timezoneRestrictions, minSalary, maxSalary, currency, salaryPeriod ('annual'|'monthly'|'hourly'), pubDate (unix s), applicationLink, description (html), employmentType }`.
- WWR RSS `<item><title>Company: Title</title><region>…</region><link>…</link><guid>…</guid><pubDate>RFC822</pubDate><description>escaped html</description></item>`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/sources-boards.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseRemoteOk } from '../src/sources/remoteok';
import { parseRemotive } from '../src/sources/remotive';
import { parseHimalayas } from '../src/sources/himalayas';
import { parseWwr } from '../src/sources/wwr';

describe('parseRemoteOk', () => {
  const raw = [
    { last_updated: 1, legal: 'terms' },
    {
      id: '1137460', epoch: 1790945581, date: '2026-10-02T12:53:01+00:00', company: 'Acme', position: 'Senior LLM Engineer',
      location: 'LATAM', salary_min: 90000, salary_max: 120000, url: 'https://remoteOK.com/remote-jobs/1137460',
      apply_url: 'https://remoteOK.com/remote-jobs/1137460',
      description: '<p><strong>Application URL</strong><br /><a href="https://jobs.ashbyhq.com/acme/9">apply</a></p><p>Build RAG.</p>',
      tags: ['ai', 'llm'],
    },
    { id: '2', epoch: 1790945581, date: '2026-10-02T12:53:01+00:00', company: 'B', position: 'Dev', location: '', salary_min: 0, salary_max: 0, url: 'https://remoteok.com/2', apply_url: '', description: '', tags: [] },
  ];

  it('skips the legal row, extracts ATS link, maps salary', () => {
    const list = parseRemoteOk(raw);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      source: 'remoteok', sourceJobId: '1137460', company: 'Acme', title: 'Senior LLM Engineer', locationText: 'LATAM',
      applyUrl: 'https://jobs.ashbyhq.com/acme/9', ats: 'ashby', atsToken: 'acme',
      compMin: 90000, compMax: 120000, compCurrency: 'USD', compPeriod: 'year',
    });
    expect(list[0]!.description).toContain('Build RAG.');
    expect(list[0]!.description).toContain('Tags: ai, llm');
    expect(list[1]).toMatchObject({ compMin: null, compMax: null, compPeriod: null, applyUrl: 'https://remoteok.com/2', ats: null });
  });
});

describe('parseRemotive', () => {
  it('normalizes and treats tz-less dates as UTC', () => {
    const [j] = parseRemotive({ jobs: [{
      id: 2091132, url: 'https://remotive.com/remote-jobs/x-2091132', title: 'Senior back-end Engineer', company_name: 'Lemon.io',
      publication_date: '2026-09-30T13:15:26', candidate_required_location: 'USA, Mexico', salary: '$50-70/hr',
      description: '<p>Work remote.</p>',
    }] });
    expect(j).toMatchObject({ source: 'remotive', sourceJobId: '2091132', company: 'Lemon.io', locationText: 'USA, Mexico', ats: null });
    expect(j!.postedAt.toISOString()).toBe('2026-09-30T13:15:26.000Z');
    expect(j!.description).toContain('Salary: $50-70/hr');
    expect(j!.description).toContain('Work remote.');
  });
});

describe('parseHimalayas', () => {
  it('maps restrictions, salary period and unix dates', () => {
    const list = parseHimalayas({ jobs: [
      { guid: 'g1', title: 'AI Engineer', companyName: 'Lingo', locationRestrictions: [], timezoneRestrictions: [], minSalary: 100, maxSalary: 150,
        currency: 'USD', salaryPeriod: 'hourly', pubDate: 1791052678, applicationLink: 'https://himalayas.app/x', description: '<p>LLM work</p>', employmentType: 'Contractor' },
      { guid: 'g2', title: 'ETL', companyName: 'Seq', locationRestrictions: ['Mexico', 'Colombia'], timezoneRestrictions: [], minSalary: null, maxSalary: null,
        currency: null, salaryPeriod: null, pubDate: 1791036915, applicationLink: 'https://himalayas.app/y', description: '', employmentType: 'Full Time' },
    ] });
    expect(list[0]).toMatchObject({ source: 'himalayas', sourceJobId: 'g1', company: 'Lingo', locationText: 'Anywhere',
      compMin: 100, compMax: 150, compCurrency: 'USD', compPeriod: 'hour' });
    expect(list[0]!.description).toContain('Employment type: Contractor');
    expect(list[0]!.postedAt.getTime()).toBe(1791052678 * 1000);
    expect(list[1]).toMatchObject({ locationText: 'Mexico; Colombia', compPeriod: null });
  });
});

describe('parseWwr', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Pinterest: Senior Full Stack Engineer</title><region>Anywhere in the World</region>
      <link>https://weworkremotely.com/remote-jobs/pinterest-sfse</link><guid>https://weworkremotely.com/remote-jobs/pinterest-sfse</guid>
      <pubDate>Thu, 02 Oct 2026 10:00:00 +0000</pubDate>
      <description>&lt;p&gt;Apply at &lt;a href="https://boards.greenhouse.io/pinterest/jobs/1"&gt;here&lt;/a&gt;&lt;/p&gt;</description></item>
  </channel></rss>`;

  it('parses a single-item feed', () => {
    const [j] = parseWwr(xml);
    expect(j).toMatchObject({
      source: 'wwr', company: 'Pinterest', title: 'Senior Full Stack Engineer', locationText: 'Anywhere in the World',
      applyUrl: 'https://boards.greenhouse.io/pinterest/jobs/1', ats: 'greenhouse', atsToken: 'pinterest',
      sourceJobId: 'https://weworkremotely.com/remote-jobs/pinterest-sfse',
    });
    expect(j!.postedAt.toISOString()).toBe('2026-10-02T10:00:00.000Z');
    expect(j!.description).toContain('Apply at here');
  });

  it('returns [] for an empty channel', () => {
    expect(parseWwr('<rss><channel></channel></rss>')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/sources/remoteok.ts`:
```ts
import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface RokJob {
  id?: string; date: string; company: string; position: string; location?: string;
  salary_min?: number; salary_max?: number; url: string; apply_url?: string; description?: string; tags?: string[];
}

export function parseRemoteOk(raw: unknown): NormalizedJob[] {
  if (!Array.isArray(raw)) throw new Error('remoteok: unexpected response shape');
  return (raw as RokJob[]).filter((j) => j && j.id && j.position).map((j) => {
    const html = j.description ?? '';
    const ats = findAtsInHtml(html);
    const hasSalary = (j.salary_max ?? 0) > 0 || (j.salary_min ?? 0) > 0;
    const tags = j.tags?.length ? `\n\nTags: ${j.tags.join(', ')}` : '';
    return {
      source: 'remoteok',
      sourceJobId: String(j.id),
      company: j.company.trim(),
      title: j.position.trim(),
      locationText: j.location?.trim() ?? '',
      description: htmlToText(html) + tags,
      applyUrl: ats?.url ?? (j.apply_url || j.url),
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: hasSalary ? (j.salary_min || null) : null,
      compMax: hasSalary ? (j.salary_max || null) : null,
      compCurrency: hasSalary ? 'USD' : null,
      compPeriod: hasSalary ? 'year' : null,
      postedAt: new Date(j.date),
    };
  });
}

export function remoteOkSource(): Source {
  return { name: 'remoteok', fetchJobs: async () => parseRemoteOk(await getJson('https://remoteok.com/api')) };
}
```

`packages/core/src/sources/remotive.ts`:
```ts
import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface RemotiveJob {
  id: number; url: string; title: string; company_name: string; publication_date: string;
  candidate_required_location?: string; salary?: string; description?: string;
}

function parseDate(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

export function parseRemotive(raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error('remotive: unexpected response shape');
  return (list as RemotiveJob[]).map((j) => {
    const html = j.description ?? '';
    const ats = findAtsInHtml(html);
    const salary = j.salary?.trim() ? `Salary: ${j.salary.trim()}\n\n` : '';
    return {
      source: 'remotive',
      sourceJobId: String(j.id),
      company: j.company_name.trim(),
      title: j.title.trim(),
      locationText: j.candidate_required_location?.trim() ?? '',
      description: salary + htmlToText(html),
      applyUrl: ats?.url ?? j.url,
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: null, compMax: null, compCurrency: null, compPeriod: null,
      postedAt: parseDate(j.publication_date),
    };
  });
}

export function remotiveSource(category: string): Source {
  return {
    name: `remotive:${category}`,
    fetchJobs: async () =>
      parseRemotive(await getJson(`https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`)),
  };
}
```

`packages/core/src/sources/himalayas.ts`:
```ts
import type { CompPeriod, NormalizedJob } from '../types';
import type { Source } from './types';
import { getJson } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface HimJob {
  guid: string; title: string; companyName: string; locationRestrictions?: string[]; timezoneRestrictions?: unknown[];
  minSalary?: number | null; maxSalary?: number | null; currency?: string | null; salaryPeriod?: string | null;
  pubDate: number; applicationLink: string; description?: string; employmentType?: string;
}

const PERIODS: Record<string, CompPeriod> = { annual: 'year', monthly: 'month', hourly: 'hour' };

export function parseHimalayas(raw: unknown): NormalizedJob[] {
  const list = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error('himalayas: unexpected response shape');
  return (list as HimJob[]).map((j) => {
    const html = j.description ?? '';
    const ats = findAtsInHtml(html);
    const period = j.salaryPeriod ? PERIODS[j.salaryPeriod] ?? null : null;
    const hasComp = period !== null && (j.minSalary != null || j.maxSalary != null);
    const restrictions = j.locationRestrictions ?? [];
    return {
      source: 'himalayas',
      sourceJobId: j.guid,
      company: j.companyName.trim(),
      title: j.title.trim(),
      locationText: restrictions.length ? restrictions.join('; ') : 'Anywhere',
      description: [j.employmentType ? `Employment type: ${j.employmentType}` : '', htmlToText(html)].filter(Boolean).join('\n\n'),
      applyUrl: ats?.url ?? j.applicationLink,
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: hasComp ? j.minSalary ?? null : null,
      compMax: hasComp ? j.maxSalary ?? null : null,
      compCurrency: hasComp ? j.currency ?? null : null,
      compPeriod: hasComp ? period : null,
      postedAt: new Date(j.pubDate * 1000),
    };
  });
}

export function himalayasSource(query: string, country: string, pages: number): Source {
  return {
    name: `himalayas:${query}`,
    fetchJobs: async () => {
      const out: NormalizedJob[] = [];
      for (let p = 0; p < pages; p++) {
        const url = `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&country=${encodeURIComponent(country)}&sort=recent&offset=${p * 20}`;
        const page = parseHimalayas(await getJson(url));
        out.push(...page);
        if (page.length < 20) break;
      }
      return out;
    },
  };
}
```

`packages/core/src/sources/wwr.ts`:
```ts
import { XMLParser } from 'fast-xml-parser';
import type { NormalizedJob } from '../types';
import type { Source } from './types';
import { getText } from '../http';
import { htmlToText } from '../text';
import { findAtsInHtml } from './ats-detect';

interface WwrItem { title: string; region?: string; link: string; guid?: string | { '#text': string }; pubDate: string; description?: string }

const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });

export function parseWwr(xml: string): NormalizedJob[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: WwrItem | WwrItem[] } } };
  const raw = doc.rss?.channel?.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return items.map((it) => {
    const full = String(it.title);
    const idx = full.indexOf(': ');
    const company = idx > 0 ? full.slice(0, idx) : 'Unknown';
    const title = idx > 0 ? full.slice(idx + 2) : full;
    const html = String(it.description ?? '');
    const ats = findAtsInHtml(html);
    const guid = typeof it.guid === 'object' ? it.guid['#text'] : it.guid;
    return {
      source: 'wwr',
      sourceJobId: String(guid ?? it.link),
      company: company.trim(),
      title: title.trim(),
      locationText: String(it.region ?? '').trim(),
      description: htmlToText(html),
      applyUrl: ats?.url ?? String(it.link),
      ats: ats?.ats ?? null,
      atsToken: ats?.token ?? null,
      compMin: null, compMax: null, compCurrency: null, compPeriod: null,
      postedAt: new Date(it.pubDate),
    };
  });
}

export function wwrSource(feedUrl: string): Source {
  const slug = feedUrl.split('/').pop()?.replace('.rss', '') ?? feedUrl;
  return { name: `wwr:${slug}`, fetchJobs: async () => parseWwr(await getText(feedUrl)) };
}
```

- [ ] **Step 4: Run tests** — expected PASS. If `fast-xml-parser` leaves entities in `description`, keep `processEntities: true` and rely on `htmlToText`'s unescape; do not weaken the test.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): remoteok, remotive, himalayas and wwr adapters"`

---

### Task 7: Source registry and discover stage (+ live smoke)

**Files:**
- Create: `packages/core/src/sources/index.ts`, `packages/core/src/pipeline/discover.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/discover.test.ts`

**Interfaces:**
- Consumes: all adapters, `Config`, `CompanyRow`, repo (`insertJobs`, `upsertCompany`, `markPolled`, `deactivateCompany`), `HttpError`.
- Produces: `buildSources(cfg: Config, companies: CompanyRow[]): Source[]`; `seedCompanies(db: Db, cfg: Config): void`; `interface DiscoverResult { fetched: number; inserted: number; errors: { source: string; message: string }[] }`; `runDiscover(db: Db, sources: Source[], now?: Date): Promise<DiscoverResult>`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/discover.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { makeJob, testDb } from './helpers';
import { runDiscover, seedCompanies } from '../src/pipeline/discover';
import { buildSources } from '../src/sources';
import { HttpError } from '../src/http';
import { listActiveCompanies, listJobsByStatus, upsertCompany } from '../src/db/repo';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import type { Source } from '../src/sources/types';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));

describe('runDiscover', () => {
  it('continues after a failing source and records the error', async () => {
    const db = testDb();
    const bad: Source = { name: 'bad', fetchJobs: async () => { throw new Error('boom'); } };
    const good: Source = { name: 'good', fetchJobs: async () => [makeJob({ title: 'AI Engineer A' })] };
    const r = await runDiscover(db, [bad, good]);
    expect(r).toMatchObject({ fetched: 1, inserted: 1, errors: [{ source: 'bad', message: 'boom' }] });
    expect(listJobsByStatus(db, ['discovered'])).toHaveLength(1);
  });

  it('deactivates a company whose board returns 404', async () => {
    const db = testDb();
    upsertCompany(db, { ats: 'lever', token: 'gone', name: 'Gone', source: 'seed' });
    const [c] = listActiveCompanies(db);
    const src: Source = { name: 'lever:gone', companyId: c!.id, fetchJobs: async () => { throw new HttpError(404, 'u'); } };
    await runDiscover(db, [src]);
    expect(listActiveCompanies(db)).toHaveLength(0);
  });

  it('keeps a company active on non-404 errors', async () => {
    const db = testDb();
    upsertCompany(db, { ats: 'lever', token: 'flaky', name: 'Flaky', source: 'seed' });
    const [c] = listActiveCompanies(db);
    const src: Source = { name: 'lever:flaky', companyId: c!.id, fetchJobs: async () => { throw new HttpError(503, 'u'); } };
    await runDiscover(db, [src]);
    expect(listActiveCompanies(db)).toHaveLength(1);
  });

  it('grows the watchlist from board jobs that link to an ATS', async () => {
    const db = testDb();
    const src: Source = { name: 'remoteok', fetchJobs: async () => [
      makeJob({ source: 'remoteok', company: 'NewCo', ats: 'ashby', atsToken: 'newco' }),
      makeJob({ source: 'remoteok', company: 'NoAts', ats: null, atsToken: null }),
    ] };
    await runDiscover(db, [src]);
    expect(listActiveCompanies(db).map((c) => `${c.ats}:${c.token}`)).toEqual(['ashby:newco']);
  });
});

describe('buildSources', () => {
  it('builds per-company and board sources from config, skipping workable', () => {
    const db = testDb();
    seedCompanies(db, cfg);
    upsertCompany(db, { ats: 'workable', token: 'hf', name: 'HF', source: 'seed' });
    const names = buildSources(cfg, listActiveCompanies(db)).map((s) => s.name);
    expect(names).toContain('greenhouse:gitlab');
    expect(names).toContain('ashby:vapi');
    expect(names).toContain('lever:toptal');
    expect(names).toContain('remoteok');
    expect(names).toContain('remotive:software-development');
    expect(names).toContain('himalayas:ai engineer');
    expect(names.some((n) => n.startsWith('wwr:'))).toBe(true);
    expect(names.some((n) => n.startsWith('workable:'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/sources/index.ts`:
```ts
import type { Config } from '../config';
import type { CompanyRow } from '../db/repo';
import type { Source } from './types';
import { greenhouseSource } from './greenhouse';
import { leverSource } from './lever';
import { ashbySource } from './ashby';
import { remoteOkSource } from './remoteok';
import { remotiveSource } from './remotive';
import { himalayasSource } from './himalayas';
import { wwrSource } from './wwr';

export type { Source } from './types';

export function buildSources(cfg: Config, companies: CompanyRow[]): Source[] {
  const s = cfg.sources;
  const out: Source[] = [];
  for (const c of companies) {
    if (c.ats === 'greenhouse' && s.greenhouse) out.push(greenhouseSource(c));
    else if (c.ats === 'lever' && s.lever) out.push(leverSource(c));
    else if (c.ats === 'ashby' && s.ashby) out.push(ashbySource(c));
    // workable: no adapter in phase 1
  }
  if (s.remoteok) out.push(remoteOkSource());
  if (s.remotive.enabled) for (const cat of s.remotive.categories) out.push(remotiveSource(cat));
  if (s.himalayas.enabled) for (const q of s.himalayas.queries) out.push(himalayasSource(q, s.himalayas.country, s.himalayas.pages));
  if (s.wwr.enabled) for (const f of s.wwr.feeds) out.push(wwrSource(f));
  return out;
}
```

`packages/core/src/pipeline/discover.ts`:
```ts
import type { Db } from '../db/client';
import type { Config } from '../config';
import type { Source } from '../sources/types';
import { HttpError } from '../http';
import { deactivateCompany, insertJobs, markPolled, upsertCompany } from '../db/repo';

export interface DiscoverResult { fetched: number; inserted: number; errors: { source: string; message: string }[] }

export function seedCompanies(db: Db, cfg: Config): void {
  for (const c of cfg.seedCompanies) upsertCompany(db, { ...c, source: 'seed' });
}

export async function runDiscover(db: Db, sources: Source[], now = new Date()): Promise<DiscoverResult> {
  const r: DiscoverResult = { fetched: 0, inserted: 0, errors: [] };
  for (const src of sources) {
    try {
      const list = await src.fetchJobs();
      r.fetched += list.length;
      r.inserted += insertJobs(db, list, now);
      if (src.companyId !== undefined) markPolled(db, src.companyId, now);
      for (const j of list) {
        if (j.ats && j.atsToken && j.source !== j.ats) {
          upsertCompany(db, { ats: j.ats, token: j.atsToken, name: j.company, source: j.source });
        }
      }
    } catch (e) {
      r.errors.push({ source: src.name, message: e instanceof Error ? e.message : String(e) });
      if (src.companyId !== undefined && e instanceof HttpError && e.status === 404) deactivateCompany(db, src.companyId);
    }
  }
  return r;
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './http';
export * from './sources';
export * from './sources/ats-detect';
export * from './pipeline/discover';
```

- [ ] **Step 4: Run tests** — expected PASS.

- [ ] **Step 5: Live smoke script (manual check against real endpoints)**

`packages/core/scripts/smoke-sources.ts`:
```ts
import { join } from 'node:path';
import { buildSources, findRoot, loadConfig, openDb, seedCompanies, listActiveCompanies } from '../src/index';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const db = openDb(':memory:');
seedCompanies(db, cfg);
for (const s of buildSources(cfg, listActiveCompanies(db))) {
  try {
    const jobs = await s.fetchJobs();
    const j = jobs[0];
    console.log(`OK   ${s.name.padEnd(40)} ${String(jobs.length).padStart(4)}  ${j ? `${j.company} | ${j.title} | ${j.locationText} | ${j.postedAt.toISOString()}` : ''}`);
  } catch (e) {
    console.log(`FAIL ${s.name.padEnd(40)} ${(e as Error).message}`);
  }
}
```
Add to core `package.json` scripts: `"smoke": "tsx scripts/smoke-sources.ts"` and `mise exec -- pnpm --filter @autoapplier/core add -D tsx`. Add `"scripts"` to core tsconfig `include`.

Run: `mise exec -- pnpm --filter @autoapplier/core smoke`
Expected: every line `OK` with job count > 0 (a seed company with 0 jobs is fine). Every description shown downstream must be readable text. If a line FAILs, fix the adapter against the real response (save the response as an extra test fixture) before committing.

- [ ] **Step 6: Commit** — `git commit -m "feat(core): source registry, discover stage, smoke script"`

---

### Task 8: Rules filter

**Files:**
- Create: `packages/core/src/filter/rules.ts`, `packages/core/src/pipeline/filter.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/rules.test.ts`

**Interfaces:**
- Consumes: `Config`, `NormalizedJob`, `normalizeKey`, repo `listJobsByStatus`, `setStatus`.
- Produces: `toHourly(value: number, period: CompPeriod): number`; `interface RuleResult { pass: boolean; reason: string | null; lowPay: boolean }`; `applyRules(job: NormalizedJob, cfg: Config, now?: Date): RuleResult`; `runFilter(db: Db, cfg: Config, now?: Date): { passed: number; rejected: number }`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/rules.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { applyRules, toHourly } from '../src/filter/rules';
import { runFilter } from '../src/pipeline/filter';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import { makeJob, testDb } from './helpers';
import { getJob, insertJobs, listJobsByStatus } from '../src/db/repo';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const now = new Date('2026-10-03T00:00:00Z');
const ok = (o: Parameters<typeof makeJob>[0] = {}) => applyRules(makeJob({ postedAt: new Date('2026-10-02T00:00:00Z'), ...o }), cfg, now);

describe('toHourly', () => {
  it('converts periods', () => {
    expect(toHourly(104000, 'year')).toBe(50);
    expect(toHourly(8000, 'month')).toBeCloseTo(46.15, 2);
    expect(toHourly(60, 'hour')).toBe(60);
  });
});

describe('applyRules', () => {
  it('passes a good LATAM AI job', () => expect(ok()).toEqual({ pass: true, reason: null, lowPay: false }));

  it('title include / exclude use whole words', () => {
    expect(ok({ title: 'Account Executive' }).reason).toMatch(/^title/);
    expect(ok({ title: 'Engineering Manager, AI' }).reason).toMatch(/^title: excluded "manager"/);
    expect(ok({ title: 'Junior Full-Stack Developer' }).reason).toMatch(/^title: excluded "junior"/);
    expect(ok({ title: 'Senior Full-Stack Engineer' }).pass).toBe(true);
    expect(ok({ title: 'Staff LLM Platform Engineer' }).pass).toBe(true);
    expect(ok({ title: 'Agentic Systems Engineer' }).pass).toBe(true);
  });

  it('rejects old postings', () => {
    expect(ok({ postedAt: new Date('2026-09-20T00:00:00Z') }).reason).toMatch(/^age/);
  });

  it('rejects explicit US authorization requirements', () => {
    const r = ok({ description: 'Candidates must be authorized to work in the United States without sponsorship.' });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^eligibility/);
    expect(ok({ description: 'This is a W2 only position.' }).pass).toBe(false);
    expect(ok({ description: 'Requires active security clearance.' }).pass).toBe(false);
  });

  it('rejects US-only locations unless an allowed region is mentioned', () => {
    expect(ok({ locationText: 'Remote - US', description: 'Great team.' }).reason).toMatch(/^location/);
    expect(ok({ locationText: 'United States', description: 'Great team.' }).reason).toMatch(/^location/);
    expect(ok({ locationText: 'San Francisco, CA; New York, NY', description: 'Great team.' }).reason).toMatch(/^location/);
    expect(ok({ locationText: 'Remote - US', description: 'We also hire contractors in LATAM.' }).pass).toBe(true);
    expect(ok({ locationText: 'Remote (US); Remote (Mexico)', description: 'x' }).pass).toBe(true);
    expect(ok({ locationText: 'Remote', description: 'Great team.' }).pass).toBe(true);
    expect(ok({ locationText: '', description: 'Great team.' }).pass).toBe(true);
  });

  it('applies the USD pay floor and low-pay flag', () => {
    expect(ok({ compMax: 70000, compCurrency: 'USD', compPeriod: 'year' }).reason).toMatch(/^pay/);
    expect(ok({ compMin: 35, compMax: 45, compCurrency: 'USD', compPeriod: 'hour' })).toEqual({ pass: true, reason: null, lowPay: true });
    expect(ok({ compMin: 120000, compMax: 160000, compCurrency: 'USD', compPeriod: 'year' }).lowPay).toBe(false);
  });

  it('ignores the USD floor for other currencies and missing pay', () => {
    expect(ok({ compMax: 800000, compCurrency: 'INR', compPeriod: 'year' }).pass).toBe(true);
    expect(ok({ compMax: 30000, compCurrency: 'MXN', compPeriod: 'month' }).pass).toBe(true);
    expect(ok({ compMax: null, compCurrency: null, compPeriod: null }).pass).toBe(true);
  });
});

describe('runFilter', () => {
  it('moves discovered jobs to passed_rules or filtered_out with reason', () => {
    const db = testDb();
    insertJobs(db, [
      makeJob({ title: 'Senior AI Engineer', postedAt: new Date('2026-10-02T00:00:00Z') }),
      makeJob({ title: 'Sales Director', postedAt: new Date('2026-10-02T00:00:00Z') }),
    ]);
    expect(runFilter(db, cfg, now)).toEqual({ passed: 1, rejected: 1 });
    const [rejected] = listJobsByStatus(db, ['filtered_out']);
    expect(getJob(db, rejected!.id)!.filterReason).toMatch(/^title/);
    expect(runFilter(db, cfg, now)).toEqual({ passed: 0, rejected: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/filter/rules.ts`:
```ts
import type { Config } from '../config';
import type { CompPeriod, NormalizedJob } from '../types';
import { normalizeKey } from '../text';

export interface RuleResult { pass: boolean; reason: string | null; lowPay: boolean }

const HOURS_PER_YEAR = 2080;
const PLACEHOLDER_LOCATIONS = /^(remote|hybrid|on-?site|in office|anywhere)?$/i;

export function toHourly(value: number, period: CompPeriod): number {
  if (period === 'hour') return value;
  if (period === 'month') return (value * 12) / HOURS_PER_YEAR;
  return value / HOURS_PER_YEAR;
}

function hasWord(haystack: string, term: string): boolean {
  return ` ${haystack} `.includes(` ${normalizeKey(term)} `);
}

const reject = (reason: string): RuleResult => ({ pass: false, reason, lowPay: false });

export function applyRules(job: NormalizedJob, cfg: Config, now = new Date()): RuleResult {
  const title = normalizeKey(job.title);
  if (!cfg.roles.titleInclude.some((t) => hasWord(title, t))) return reject('title: no include match');
  const excluded = cfg.roles.titleExclude.find((t) => hasWord(title, t));
  if (excluded) return reject(`title: excluded "${excluded}"`);

  const ageDays = (now.getTime() - job.postedAt.getTime()) / 86_400_000;
  if (ageDays > cfg.maxAgeDays) return reject(`age: ${Math.floor(ageDays)} days old`);

  const fullText = `${job.locationText}\n${job.description}`;
  const hit = cfg.eligibility.rejectPatterns.find((p) => new RegExp(p, 'i').test(fullText));
  if (hit) return reject(`eligibility: matched /${hit}/`);

  const segments = job.locationText.split(/[;|·]/).map((s) => s.trim().toLowerCase()).filter((s) => !PLACEHOLDER_LOCATIONS.test(s));
  const usOnly = segments.length > 0 && segments.every((seg) =>
    cfg.eligibility.usOnlyLocationPatterns.some((p) => new RegExp(p, 'i').test(seg)));
  const allowed = cfg.eligibility.allowedRegionPatterns.some((p) => new RegExp(p, 'i').test(fullText));
  if (usOnly && !allowed) return reject(`location: US only (${job.locationText})`);

  let lowPay = false;
  const pay = job.compMax ?? job.compMin;
  if (pay !== null && job.compPeriod && job.compCurrency?.toUpperCase() === 'USD') {
    const hourly = toHourly(pay, job.compPeriod);
    if (hourly < cfg.pay.rejectBelowHourly) return reject(`pay: ~$${hourly.toFixed(0)}/hr`);
    lowPay = hourly < cfg.pay.lowPriorityBelowHourly;
  }
  return { pass: true, reason: null, lowPay };
}
```

`packages/core/src/pipeline/filter.ts`:
```ts
import type { Db } from '../db/client';
import type { Config } from '../config';
import { listJobsByStatus, setStatus } from '../db/repo';
import { applyRules } from '../filter/rules';

export function runFilter(db: Db, cfg: Config, now = new Date()): { passed: number; rejected: number } {
  let passed = 0;
  let rejected = 0;
  for (const job of listJobsByStatus(db, ['discovered'], 100_000)) {
    const r = applyRules(job, cfg, now);
    if (r.pass) { setStatus(db, job.id, 'passed_rules', null, { lowPay: r.lowPay }, now); passed++; }
    else { setStatus(db, job.id, 'filtered_out', r.reason, { filterReason: r.reason }, now); rejected++; }
  }
  return { passed, rejected };
}
```

`JobRow` is structurally compatible with `NormalizedJob` (extra fields allowed). If TS complains, pass `job` as `NormalizedJob` via a typed local.

Append to `packages/core/src/index.ts`:
```ts
export * from './filter/rules';
export * from './pipeline/filter';
```

- [ ] **Step 4: Run tests** — expected PASS. If a location case fails, fix the regex in `config.yaml` (the test file is the contract).

- [ ] **Step 5: Commit** — `git commit -m "feat(core): rules filter (title, age, eligibility, location, pay)"`

---

### Task 9: LLM provider layer

**Files:**
- Create: `packages/core/src/llm/provider.ts`, `packages/core/src/llm/anthropic.ts`, `packages/core/src/llm/openai.ts`, `packages/core/src/llm/factory.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/llm.test.ts`

**Interfaces:**
- Produces:
  - `interface LLMUsage { provider: 'anthropic' | 'openai'; model: string; inputTokens: number; outputTokens: number }`
  - `interface StructuredRequest<T> { system: string; user: string; schema: z.ZodType<T>; schemaName: string; maxTokens: number }`
  - `interface LLMProvider { readonly name: 'anthropic' | 'openai'; generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }> }`
  - `class LLMParseError extends Error { usage?: LLMUsage }`
  - `costUsd(pricing: Config['pricing'], usage: LLMUsage): number`
  - `AnthropicProvider`, `OpenAIProvider` (constructors take an SDK client), `createProvider(name: 'anthropic' | 'openai'): LLMProvider`

SDK facts (from the bundled Claude API skill + OpenAI SDK; verify against installed type definitions if the compiler disagrees):
- Anthropic: `client.messages.parse({ model, max_tokens, system, messages, output_config: { format: zodOutputFormat(schema) } })` from `@anthropic-ai/sdk/helpers/zod` → `res.parsed_output` (null on parse failure), `res.stop_reason`, `res.usage.input_tokens/output_tokens`. Haiku 4.5: no `thinking` param needed for scoring.
- OpenAI: `client.responses.parse({ model, instructions, input, max_output_tokens, text: { format: zodTextFormat(schema, name) } })` from `openai/helpers/zod` → `res.output_parsed`, `res.usage?.input_tokens/output_tokens`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/llm.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { AnthropicProvider } from '../src/llm/anthropic';
import { OpenAIProvider } from '../src/llm/openai';
import { LLMParseError, costUsd } from '../src/llm/provider';

const schema = z.object({ ok: z.boolean() });
const req = { system: 's', user: 'u', schema, schemaName: 'x', maxTokens: 100 };

describe('AnthropicProvider', () => {
  it('returns parsed data and usage', async () => {
    let sent: any;
    const fake = { messages: { parse: async (p: unknown) => { sent = p; return {
      parsed_output: { ok: true }, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }; } } };
    const p = new AnthropicProvider(fake as unknown as Anthropic);
    const r = await p.generateStructured('claude-haiku-4-5', req);
    expect(r).toEqual({ data: { ok: true }, usage: { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 5 } });
    expect(sent).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(sent.output_config.format).toBeDefined();
  });

  it('throws LLMParseError with usage when nothing parsed', async () => {
    const fake = { messages: { parse: async () => ({ parsed_output: null, stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }) } };
    const p = new AnthropicProvider(fake as unknown as Anthropic);
    const err = await p.generateStructured('m', req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMParseError);
    expect(err.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });
});

describe('OpenAIProvider', () => {
  it('returns parsed data and usage', async () => {
    const fake = { responses: { parse: async () => ({ output_parsed: { ok: false }, usage: { input_tokens: 7, output_tokens: 3 } }) } };
    const p = new OpenAIProvider(fake as unknown as OpenAI);
    const r = await p.generateStructured('gpt-5.6-luna', req);
    expect(r.data).toEqual({ ok: false });
    expect(r.usage).toEqual({ provider: 'openai', model: 'gpt-5.6-luna', inputTokens: 7, outputTokens: 3 });
  });

  it('throws LLMParseError when output_parsed is null', async () => {
    const fake = { responses: { parse: async () => ({ output_parsed: null, usage: { input_tokens: 1, output_tokens: 1 } }) } };
    await expect(new OpenAIProvider(fake as unknown as OpenAI).generateStructured('m', req)).rejects.toBeInstanceOf(LLMParseError);
  });
});

describe('costUsd', () => {
  it('prices known models and returns 0 for unknown', () => {
    const pricing = { 'claude-haiku-4-5': { input: 1, output: 5 } };
    expect(costUsd(pricing, { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 3000, outputTokens: 300 })).toBeCloseTo(0.0045);
    expect(costUsd(pricing, { provider: 'anthropic', model: 'nope', inputTokens: 3000, outputTokens: 300 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/llm/provider.ts`:
```ts
import type { z } from 'zod';
import type { Config } from '../config';

export interface LLMUsage { provider: 'anthropic' | 'openai'; model: string; inputTokens: number; outputTokens: number }

export interface StructuredRequest<T> {
  system: string; user: string; schema: z.ZodType<T>; schemaName: string; maxTokens: number;
}

export interface LLMProvider {
  readonly name: 'anthropic' | 'openai';
  generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }>;
}

export class LLMParseError extends Error {
  constructor(message: string, public readonly usage?: LLMUsage) { super(message); }
}

const warned = new Set<string>();
export function costUsd(pricing: Config['pricing'], usage: LLMUsage): number {
  const p = pricing[usage.model];
  if (!p) {
    if (!warned.has(usage.model)) { warned.add(usage.model); console.warn(`[llm] no pricing for model ${usage.model}; cost recorded as 0`); }
    return 0;
  }
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}
```

`packages/core/src/llm/anthropic.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LLMParseError, type LLMProvider, type LLMUsage, type StructuredRequest } from './provider';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }> {
    const res = await this.client.messages.parse({
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: zodOutputFormat(req.schema) },
    });
    const usage: LLMUsage = { provider: 'anthropic', model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (!res.parsed_output) throw new LLMParseError(`anthropic: no parsed output (stop_reason=${res.stop_reason})`, usage);
    return { data: res.parsed_output as T, usage };
  }
}
```

`packages/core/src/llm/openai.ts`:
```ts
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { LLMParseError, type LLMProvider, type LLMUsage, type StructuredRequest } from './provider';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  constructor(private readonly client: OpenAI = new OpenAI()) {}

  async generateStructured<T>(model: string, req: StructuredRequest<T>): Promise<{ data: T; usage: LLMUsage }> {
    const res = await this.client.responses.parse({
      model,
      instructions: req.system,
      input: req.user,
      max_output_tokens: req.maxTokens,
      text: { format: zodTextFormat(req.schema, req.schemaName) },
    });
    const usage: LLMUsage = {
      provider: 'openai', model, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0,
    };
    if (!res.output_parsed) throw new LLMParseError('openai: no parsed output', usage);
    return { data: res.output_parsed as T, usage };
  }
}
```

`packages/core/src/llm/factory.ts`:
```ts
import type { LLMProvider } from './provider';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

export function createProvider(name: 'anthropic' | 'openai'): LLMProvider {
  return name === 'anthropic' ? new AnthropicProvider() : new OpenAIProvider();
}
```

If `zodOutputFormat` / `zodTextFormat` generic typing rejects `z.ZodType<T>`, cast the schema argument (`req.schema as never`) — runtime behavior is what the tests pin.

Append to `packages/core/src/index.ts`:
```ts
export * from './llm/provider';
export * from './llm/anthropic';
export * from './llm/openai';
export * from './llm/factory';
```

- [ ] **Step 4: Run tests + typecheck** — `mise exec -- pnpm --filter @autoapplier/core test && mise exec -- pnpm --filter @autoapplier/core typecheck` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): pluggable LLM providers (anthropic, openai) with cost tracking"`

---

### Task 10: Scoring (prompt, evidence check, decision, stage)

**Files:**
- Create: `packages/core/src/score/prompt.ts`, `packages/core/src/score/score.ts`, `packages/core/src/pipeline/score.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/score.test.ts`

**Interfaces:**
- Consumes: `ScoreSchema`, `ScorePayload`, `LLMProvider`, `LLMParseError`, `costUsd`, repo (`listJobsForScoring`, `setStatus`, `insertScore`, `recordUsage`, `spendSince`), `JobRow`, `normalizeForMatch`.
- Produces:
  - `MAX_POSTING_CHARS = 24000`; `jobContextText(job: Pick<JobRow, 'title'|'company'|'locationText'|'description'|'compMin'|'compMax'|'compCurrency'|'compPeriod'>): string`; `buildScoringSystem(profileText: string): string`; `buildScoringUser(context: string): string`
  - `evidenceFound(evidence: string, text: string): boolean`; `applyEvidenceCheck(s: ScorePayload, text: string): ScorePayload`; `decide(s: ScorePayload, threshold: number): 'awaiting_review' | 'ineligible' | 'low_score'`; `scoreJob(provider: LLMProvider, model: string, profileText: string, job: JobRow, onUsage: (u: LLMUsage) => void): Promise<ScorePayload>`
  - `interface ScoreRunResult { scored: number; failed: number; capped: boolean }`; `runScore(d: { db: Db; cfg: Config; provider: LLMProvider; profileText: string; now?: Date }): Promise<ScoreRunResult>`

- [ ] **Step 1: Write failing tests**

`packages/core/test/score.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { applyEvidenceCheck, decide, evidenceFound } from '../src/score/score';
import { jobContextText, MAX_POSTING_CHARS } from '../src/score/prompt';
import { runScore } from '../src/pipeline/score';
import { LLMParseError, type LLMProvider, type StructuredRequest } from '../src/llm/provider';
import type { ScorePayload } from '../src/score/schema';
import { loadConfig } from '../src/config';
import { findRoot } from '../src/root';
import { makeJob, testDb } from './helpers';
import { getJob, insertJobs, latestScore, listJobsByStatus, recordUsage, setStatus, spendSince } from '../src/db/repo';

const cfg = loadConfig(join(findRoot(), 'config.yaml'));
const base: ScorePayload = {
  eligibility: 'eligible', eligibilityEvidence: 'contractors anywhere in Latin America', fitScore: 82,
  roleCategory: 'ai', matched: ['TypeScript'], missing: [], redFlags: [], compEstimate: null,
};

describe('evidenceFound', () => {
  const text = 'Location: Remote - LATAM\n\nWe hire contractors   anywhere in\nLatin America.';
  it('matches verbatim quotes ignoring case/whitespace and wrapping quotes', () => {
    expect(evidenceFound('"Contractors anywhere in Latin America"', text)).toBe(true);
    expect(evidenceFound('Remote - LATAM', text)).toBe(true);
  });
  it('supports ellipsis-joined fragments', () => {
    expect(evidenceFound('We hire contractors ... Latin America', text)).toBe(true);
  });
  it('rejects invented or too-short quotes', () => {
    expect(evidenceFound('open to candidates in Mexico', text)).toBe(false);
    expect(evidenceFound('none found', text)).toBe(false);
    expect(evidenceFound('LA', text)).toBe(false);
  });
});

describe('applyEvidenceCheck / decide', () => {
  it('downgrades eligible with invented evidence', () => {
    const s = applyEvidenceCheck({ ...base, eligibilityEvidence: 'Mexico welcome' }, 'Remote - US only');
    expect(s.eligibility).toBe('unlikely');
    expect(s.redFlags).toContain('eligibility evidence not found in posting');
  });
  it('leaves ineligible untouched', () => {
    const s = applyEvidenceCheck({ ...base, eligibility: 'ineligible', eligibilityEvidence: 'made up' }, 'text');
    expect(s.eligibility).toBe('ineligible');
  });
  it('decides by eligibility then threshold', () => {
    expect(decide(base, 65)).toBe('awaiting_review');
    expect(decide({ ...base, eligibility: 'likely', fitScore: 65 }, 65)).toBe('awaiting_review');
    expect(decide({ ...base, fitScore: 64 }, 65)).toBe('low_score');
    expect(decide({ ...base, eligibility: 'unlikely' }, 65)).toBe('ineligible');
    expect(decide({ ...base, eligibility: 'ineligible' }, 65)).toBe('ineligible');
  });
});

describe('jobContextText', () => {
  it('includes header fields and truncates long descriptions with a marker', () => {
    const t = jobContextText({ ...makeJob({ compMin: 50, compMax: 70, compCurrency: 'USD', compPeriod: 'hour' }), description: 'x'.repeat(MAX_POSTING_CHARS + 10) });
    expect(t).toContain('Location: Remote - LATAM');
    expect(t).toContain('Compensation: USD 50–70 per hour');
    expect(t).toContain('[description truncated]');
  });
});

class FakeProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  calls = 0;
  constructor(private readonly responses: (ScorePayload | Error)[]) {}
  async generateStructured<T>(model: string, _req: StructuredRequest<T>) {
    const r = this.responses[Math.min(this.calls++, this.responses.length - 1)]!;
    const usage = { provider: 'anthropic' as const, model, inputTokens: 3000, outputTokens: 300 };
    if (r instanceof Error) throw r;
    return { data: r as unknown as T, usage };
  }
}

function seedPassed(db: ReturnType<typeof testDb>, n = 1) {
  insertJobs(db, Array.from({ length: n }, () => makeJob()));
  for (const j of listJobsByStatus(db, ['discovered'])) setStatus(db, j.id, 'passed_rules');
  return listJobsByStatus(db, ['passed_rules']);
}

describe('runScore', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('scores, stores payload, records usage, and routes by decision', async () => {
    const db = testDb();
    const [job] = seedPassed(db);
    const provider = new FakeProvider([base]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(r).toEqual({ scored: 1, failed: 0, capped: false });
    expect(getJob(db, job!.id)!.status).toBe('awaiting_review');
    expect(latestScore(db, job!.id)).toEqual(base);
    expect(spendSince(db, new Date('2026-10-03T00:00:00Z'))).toBeCloseTo(0.0045);
  });

  it('clamps fitScore to 0..100', async () => {
    const db = testDb();
    const [job] = seedPassed(db);
    await runScore({ db, cfg, provider: new FakeProvider([{ ...base, fitScore: 140.6 }]), profileText: 'p', now });
    expect(latestScore(db, job!.id)!.fitScore).toBe(100);
  });

  it('retries once on parse errors, then marks score_failed and increments attempts', async () => {
    const db = testDb();
    const [job] = seedPassed(db);
    const provider = new FakeProvider([new LLMParseError('bad'), new LLMParseError('bad again')]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(provider.calls).toBe(2);
    expect(r).toEqual({ scored: 0, failed: 1, capped: false });
    const j = getJob(db, job!.id)!;
    expect(j.status).toBe('score_failed');
    expect(j.scoreAttempts).toBe(1);
  });

  it('recovers when the retry succeeds', async () => {
    const db = testDb();
    seedPassed(db);
    const r = await runScore({ db, cfg, provider: new FakeProvider([new LLMParseError('bad'), base]), profileText: 'p', now });
    expect(r.scored).toBe(1);
  });

  it('does not retry non-parse errors (e.g. API errors) and does not crash', async () => {
    const db = testDb();
    seedPassed(db, 2);
    const provider = new FakeProvider([new Error('500 overloaded')]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(provider.calls).toBe(2);
    expect(r).toEqual({ scored: 0, failed: 2, capped: false });
  });

  it('stops when the daily spend cap is reached', async () => {
    const db = testDb();
    seedPassed(db, 3);
    recordUsage(db, { jobId: null, stage: 'score', provider: 'anthropic', model: 'x', inputTokens: 0, outputTokens: 0, costUsd: cfg.scoring.dailySpendCapUsd }, now);
    const provider = new FakeProvider([base]);
    const r = await runScore({ db, cfg, provider, profileText: 'p', now });
    expect(r).toEqual({ scored: 0, failed: 0, capped: true });
    expect(provider.calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement prompt**

`packages/core/src/score/prompt.ts`:
```ts
import type { JobRow } from '../db/repo';

export const MAX_POSTING_CHARS = 24_000;

type ContextJob = Pick<JobRow, 'title' | 'company' | 'locationText' | 'description' | 'compMin' | 'compMax' | 'compCurrency' | 'compPeriod'>;

export function formatComp(j: Pick<JobRow, 'compMin' | 'compMax' | 'compCurrency' | 'compPeriod'>): string | null {
  if (j.compMin === null && j.compMax === null) return null;
  const range = j.compMin !== null && j.compMax !== null && j.compMin !== j.compMax
    ? `${j.compMin}–${j.compMax}` : String(j.compMax ?? j.compMin);
  return `${j.compCurrency ?? ''} ${range}${j.compPeriod ? ` per ${j.compPeriod}` : ''}`.trim();
}

export function jobContextText(job: ContextJob): string {
  const comp = formatComp(job);
  let desc = job.description;
  if (desc.length > MAX_POSTING_CHARS) desc = `${desc.slice(0, MAX_POSTING_CHARS)}\n[description truncated]`;
  return [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.locationText || 'not stated'}`,
    `Compensation: ${comp ?? 'not stated'}`,
    '',
    desc,
  ].join('\n');
}

export function buildScoringSystem(profileText: string): string {
  return `You screen job postings for one candidate. Be strict and literal.

CANDIDATE PROFILE
${profileText}

ELIGIBILITY (most important)
The candidate lives in Mexico, is NOT authorized to work in the US, and can only work remotely as a contractor (own entity or an EOR such as Deel) or for an employer that hires in Mexico/LATAM.
- eligible: the posting explicitly allows Mexico, LATAM, the Americas, worldwide/anywhere, or international contractors.
- likely: fully remote with no stated country restriction and nothing implying US-only.
- unlikely: signals of US-only without saying so (US benefits like 401k/health insurance, US payroll, list of US states) or remote limited to another region (e.g. Europe-only, Canada-only).
- ineligible: explicitly requires US work authorization, residence, citizenship, clearance, W-2, on-site/hybrid work, or a non-Americas region only.
eligibilityEvidence MUST be an exact quote copied character-for-character from the posting text (the Location line counts) that supports the decision. At most ~200 characters. Never paraphrase. If nothing supports it, quote the Location line.

FIT
fitScore 0-100 = how strong this candidate would look to the hiring manager, using only facts in the profile. 80+ strong match on core stack and seniority; 60-79 solid with gaps; below 60 weak. Penalize hard requirements the candidate lacks (e.g. 8+ years, PhD, specific domain).
roleCategory: ai (LLM/AI/ML engineering), fullstack, voice (voice/conversational AI), other.
matched / missing: short phrases, max 6 each.
redFlags: concerning signals (unpaid trial, commission-only, vague company, crypto trading, extreme hours). Empty if none.
compEstimate: pay exactly as stated in the posting, else null.`;
}

export function buildScoringUser(context: string): string {
  return `JOB POSTING\n<posting>\n${context}\n</posting>`;
}
```

- [ ] **Step 4: Implement scoring logic**

`packages/core/src/score/score.ts`:
```ts
import type { JobRow } from '../db/repo';
import type { LLMProvider, LLMUsage } from '../llm/provider';
import { LLMParseError } from '../llm/provider';
import { normalizeForMatch } from '../text';
import { ScoreSchema, type ScorePayload } from './schema';
import { buildScoringSystem, buildScoringUser, jobContextText } from './prompt';

const MIN_FRAGMENT = 6;

export function evidenceFound(evidence: string, text: string): boolean {
  const hay = normalizeForMatch(text);
  const cleaned = evidence.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  const fragments = cleaned.split(/\s*(?:\.\.\.|…)\s*/).map(normalizeForMatch).filter(Boolean);
  if (fragments.length === 0) return false;
  return fragments.every((f) => f.length >= MIN_FRAGMENT && hay.includes(f));
}

export function applyEvidenceCheck(s: ScorePayload, text: string): ScorePayload {
  if ((s.eligibility === 'eligible' || s.eligibility === 'likely') && !evidenceFound(s.eligibilityEvidence, text)) {
    return { ...s, eligibility: 'unlikely', redFlags: [...s.redFlags, 'eligibility evidence not found in posting'] };
  }
  return s;
}

export function decide(s: ScorePayload, threshold: number): 'awaiting_review' | 'ineligible' | 'low_score' {
  if (s.eligibility === 'ineligible' || s.eligibility === 'unlikely') return 'ineligible';
  return s.fitScore >= threshold ? 'awaiting_review' : 'low_score';
}

export async function scoreJob(
  provider: LLMProvider, model: string, profileText: string, job: JobRow, onUsage: (u: LLMUsage) => void,
): Promise<ScorePayload> {
  const context = jobContextText(job);
  const req = {
    system: buildScoringSystem(profileText), user: buildScoringUser(context),
    schema: ScoreSchema, schemaName: 'job_score', maxTokens: 2000,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, usage } = await provider.generateStructured(model, req);
      onUsage(usage);
      const clamped = { ...data, fitScore: Math.max(0, Math.min(100, Math.round(data.fitScore))) };
      return applyEvidenceCheck(clamped, context);
    } catch (e) {
      lastErr = e;
      if (e instanceof LLMParseError) { if (e.usage) onUsage(e.usage); continue; }
      throw e;
    }
  }
  throw lastErr;
}
```

- [ ] **Step 5: Implement stage**

`packages/core/src/pipeline/score.ts`:
```ts
import type { Db } from '../db/client';
import type { Config } from '../config';
import type { LLMProvider } from '../llm/provider';
import { costUsd } from '../llm/provider';
import { insertScore, listJobsForScoring, recordUsage, setStatus, spendSince } from '../db/repo';
import { decide, scoreJob } from '../score/score';

export interface ScoreRunResult { scored: number; failed: number; capped: boolean }

export async function runScore(d: { db: Db; cfg: Config; provider: LLMProvider; profileText: string; now?: Date }): Promise<ScoreRunResult> {
  const { db, cfg, provider, profileText } = d;
  const now = d.now ?? new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const res: ScoreRunResult = { scored: 0, failed: 0, capped: false };

  for (const job of listJobsForScoring(db, cfg.scoring.maxAttempts, cfg.scoring.maxPerRun)) {
    if (spendSince(db, dayStart) >= cfg.scoring.dailySpendCapUsd) { res.capped = true; break; }
    try {
      const score = await scoreJob(provider, cfg.scoring.model, profileText, job, (u) =>
        recordUsage(db, { jobId: job.id, stage: 'score', ...u, costUsd: costUsd(cfg.pricing, u) }, now));
      insertScore(db, job.id, cfg.scoring.model, score, now);
      setStatus(db, job.id, decide(score, cfg.scoring.threshold), `fit ${score.fitScore}, ${score.eligibility}`, {}, now);
      res.scored++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(db, job.id, 'score_failed', msg.slice(0, 500), { scoreAttempts: job.scoreAttempts + 1 }, now);
      res.failed++;
    }
  }
  return res;
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './score/prompt';
export * from './score/score';
export * from './pipeline/score';
```

- [ ] **Step 6: Run tests + typecheck** → PASS.

- [ ] **Step 7: Commit** — `git commit -m "feat(core): LLM job scoring with evidence check, retries and spend cap"`

---

### Task 11: Telegram bot module

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/vitest.config.ts`, `apps/worker/src/telegram.ts`
- Test: `apps/worker/test/telegram.test.ts`

**Interfaces:**
- Consumes: `Db`, `JobRow`, `ScorePayload`, `getJob`, `setStatus`, `listUnnotified`, `latestScore`, `markNotified`, `formatComp`.
- Produces: `escapeHtml(s: string): string`; `formatJobCard(job: JobRow, score: ScorePayload): string`; `jobKeyboard(jobId: number, applyUrl: string): InlineKeyboard`; `parseCallback(data: string): { action: 'shortlist' | 'skip'; jobId: number } | null`; `handleDecision(db: Db, allowedChatId: string, fromChatId: string | number | undefined, data: string, now?: Date): { ok: boolean; text: string; applyUrl?: string }`; `interface MessageSender { sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown> }`; `notifyPending(sender: MessageSender, chatId: string, db: Db, limit?: number, now?: Date): Promise<number>`; `createBot(token: string, chatId: string, db: Db): Bot`.

- [ ] **Step 1: Worker package**

`apps/worker/package.json`:
```json
{
  "name": "@autoapplier/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/main.ts",
    "once": "tsx src/cli.ts once",
    "cli": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```
`apps/worker/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }`
`apps/worker/vitest.config.ts`: same as core's.

```bash
mise exec -- pnpm --filter @autoapplier/worker add @autoapplier/core@workspace:* grammy node-cron
mise exec -- pnpm --filter @autoapplier/worker add -D tsx vitest typescript @types/node
```

- [ ] **Step 2: Write failing tests**

`apps/worker/test/telegram.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, insertJobs, listJobsByStatus, setStatus, insertScore, getJob, listUnnotified, type ScorePayload } from '@autoapplier/core';
import { escapeHtml, formatJobCard, handleDecision, notifyPending, parseCallback } from '../src/telegram';

const score: ScorePayload = {
  eligibility: 'eligible', eligibilityEvidence: 'Remote <LATAM> & Mexico', fitScore: 84, roleCategory: 'voice',
  matched: ['ElevenLabs', 'Vapi', 'TypeScript', 'NestJS', 'RAG'], missing: ['Go'], redFlags: [], compEstimate: '$60/hr',
};

function setup(n = 1) {
  const db = openDb(':memory:');
  insertJobs(db, Array.from({ length: n }, (_, i) => ({
    source: 'ashby', sourceJobId: String(i), company: 'Vapi & Co', title: `Voice <AI> Engineer ${i}`, locationText: 'Remote (Mexico)',
    description: 'd', applyUrl: `https://jobs.ashbyhq.com/vapi/${i}`, ats: 'ashby' as const, atsToken: 'vapi',
    compMin: 50, compMax: 70, compCurrency: 'USD', compPeriod: 'hour' as const, postedAt: new Date('2026-10-02T00:00:00Z'),
  })));
  const rows = listJobsByStatus(db, ['discovered']);
  rows.forEach((j, i) => { setStatus(db, j.id, 'awaiting_review'); insertScore(db, j.id, 'm', { ...score, fitScore: 70 + i }); });
  return { db, rows };
}

describe('formatting', () => {
  it('escapes html', () => expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;'));
  it('renders a card with escaped fields', () => {
    const { db, rows } = setup();
    const card = formatJobCard(getJob(db, rows[0]!.id)!, score);
    expect(card).toContain('<b>Voice &lt;AI&gt; Engineer 0</b>');
    expect(card).toContain('Vapi &amp; Co');
    expect(card).toContain('Fit 84');
    expect(card).toContain('USD 50–70 per hour');
    expect(card).toContain('“Remote &lt;LATAM&gt; &amp; Mexico”');
    expect(card).not.toContain('RAG'); // max 4 matched shown
  });
});

describe('parseCallback', () => {
  it('parses valid data', () => {
    expect(parseCallback('sl:12')).toEqual({ action: 'shortlist', jobId: 12 });
    expect(parseCallback('sk:3')).toEqual({ action: 'skip', jobId: 3 });
  });
  it('rejects junk', () => {
    expect(parseCallback('xx:1')).toBeNull();
    expect(parseCallback('sl:abc')).toBeNull();
    expect(parseCallback('')).toBeNull();
  });
});

describe('handleDecision', () => {
  it('applies a decision exactly once', () => {
    const { db, rows } = setup();
    const id = rows[0]!.id;
    expect(handleDecision(db, '42', 42, `sl:${id}`)).toMatchObject({ ok: true, applyUrl: 'https://jobs.ashbyhq.com/vapi/0' });
    expect(getJob(db, id)!.status).toBe('shortlisted');
    expect(handleDecision(db, '42', 42, `sk:${id}`)).toEqual({ ok: false, text: 'Already shortlisted' });
    expect(getJob(db, id)!.status).toBe('shortlisted');
  });
  it('ignores other chats and unknown jobs', () => {
    const { db, rows } = setup();
    expect(handleDecision(db, '42', 99, `sl:${rows[0]!.id}`)).toEqual({ ok: false, text: 'Not allowed' });
    expect(handleDecision(db, '42', undefined, `sl:${rows[0]!.id}`)).toEqual({ ok: false, text: 'Not allowed' });
    expect(handleDecision(db, '42', 42, 'sl:9999')).toEqual({ ok: false, text: 'Job not found' });
    expect(getJob(db, rows[0]!.id)!.status).toBe('awaiting_review');
  });
});

describe('notifyPending', () => {
  it('sends best-first, marks notified, never re-sends', async () => {
    const { db } = setup(3);
    const sent: string[] = [];
    const sender = { sendMessage: async (_c: string, text: string) => { sent.push(text); } };
    expect(await notifyPending(sender, '42', db, 2)).toBe(2);
    expect(sent[0]).toContain('Fit 72');
    expect(sent[1]).toContain('Fit 71');
    expect(listUnnotified(db, 10)).toHaveLength(1);
    expect(await notifyPending(sender, '42', db, 10)).toBe(1);
    expect(await notifyPending(sender, '42', db, 10)).toBe(0);
  });

  it('leaves a job unnotified if sending fails', async () => {
    const { db } = setup(1);
    const sender = { sendMessage: async () => { throw new Error('network'); } };
    await expect(notifyPending(sender, '42', db)).rejects.toThrow('network');
    expect(listUnnotified(db, 10)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `mise exec -- pnpm --filter @autoapplier/worker test` → FAIL.

- [ ] **Step 4: Implement**

`apps/worker/src/telegram.ts`:
```ts
import { Bot, InlineKeyboard } from 'grammy';
import {
  formatComp, getJob, latestScore, listUnnotified, markNotified, setStatus,
  type Db, type JobRow, type ScorePayload,
} from '@autoapplier/core';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatJobCard(job: JobRow, score: ScorePayload): string {
  const comp = formatComp(job) ?? 'pay not listed';
  const lines = [
    `<b>${escapeHtml(job.title)}</b> — ${escapeHtml(job.company)}`,
    `📍 ${escapeHtml(job.locationText || 'not stated')} · 💰 ${escapeHtml(comp)}${job.lowPay ? ' (low)' : ''}`,
    `🎯 Fit ${score.fitScore} · ${score.roleCategory} · ${score.eligibility}`,
    `<i>“${escapeHtml(score.eligibilityEvidence)}”</i>`,
  ];
  if (score.matched.length) lines.push(`✅ ${escapeHtml(score.matched.slice(0, 4).join(', '))}`);
  if (score.missing.length) lines.push(`⚠️ ${escapeHtml(score.missing.slice(0, 3).join(', '))}`);
  if (score.redFlags.length) lines.push(`🚩 ${escapeHtml(score.redFlags.join('; '))}`);
  lines.push(`<code>#${job.id} · ${escapeHtml(job.source)}</code>`);
  return lines.join('\n');
}

export function jobKeyboard(jobId: number, applyUrl: string): InlineKeyboard {
  return new InlineKeyboard().text('👍 Shortlist', `sl:${jobId}`).text('⏭ Skip', `sk:${jobId}`).row().url('🔗 Open posting', applyUrl);
}

export function parseCallback(data: string): { action: 'shortlist' | 'skip'; jobId: number } | null {
  const m = /^(sl|sk):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] === 'sl' ? 'shortlist' : 'skip', jobId: Number(m[2]) };
}

export function handleDecision(
  db: Db, allowedChatId: string, fromChatId: string | number | undefined, data: string, now = new Date(),
): { ok: boolean; text: string; applyUrl?: string } {
  if (fromChatId === undefined || String(fromChatId) !== allowedChatId) return { ok: false, text: 'Not allowed' };
  const parsed = parseCallback(data);
  if (!parsed) return { ok: false, text: 'Unknown action' };
  const job = getJob(db, parsed.jobId);
  if (!job) return { ok: false, text: 'Job not found' };
  if (job.status !== 'awaiting_review') return { ok: false, text: `Already ${job.status}` };
  const to = parsed.action === 'shortlist' ? 'shortlisted' : 'skipped';
  setStatus(db, job.id, to, 'telegram', {}, now);
  return { ok: true, text: to === 'shortlisted' ? '👍 Shortlisted' : '⏭ Skipped', applyUrl: job.applyUrl };
}

export interface MessageSender {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export async function notifyPending(sender: MessageSender, chatId: string, db: Db, limit = 20, now = new Date()): Promise<number> {
  const rows = listUnnotified(db, 500)
    .map((job) => ({ job, score: latestScore(db, job.id) }))
    .filter((r): r is { job: JobRow; score: ScorePayload } => r.score !== undefined)
    .sort((a, b) => b.score.fitScore - a.score.fitScore)
    .slice(0, limit);
  for (const { job, score } of rows) {
    await sender.sendMessage(chatId, formatJobCard(job, score), {
      parse_mode: 'HTML',
      reply_markup: jobKeyboard(job.id, job.applyUrl),
      link_preview_options: { is_disabled: true },
    });
    markNotified(db, job.id, now);
  }
  return rows.length;
}

export function createBot(token: string, chatId: string, db: Db): Bot {
  const bot = new Bot(token);
  bot.command('start', (ctx) => ctx.reply(`Chat id: ${ctx.chat.id}\nPut it in .env as TELEGRAM_CHAT_ID.`));
  bot.on('callback_query:data', async (ctx) => {
    const r = handleDecision(db, chatId, ctx.chat?.id, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: r.text });
    if (r.ok && r.applyUrl) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().url(`${r.text} · 🔗 Open posting`, r.applyUrl) });
    }
  });
  bot.catch((err) => console.error('[telegram]', err.error));
  return bot;
}
```

- [ ] **Step 5: Run tests + typecheck** — `mise exec -- pnpm --filter @autoapplier/worker test && mise exec -- pnpm --filter @autoapplier/worker typecheck` → PASS. (`formatComp` was exported from core in Task 10 via `score/prompt`.)

- [ ] **Step 6: Commit** — `git commit -m "feat(worker): telegram cards, decisions and notifications"`

---

### Task 12: Real profile (local only, git-ignored)

**Files:**
- Create: `profile/profile.yaml` (git-ignored — never committed)

**Interfaces:**
- Consumes: `ProfileSchema` (Task 3). Read-only sources: the user's CV PDF (extract with `pdftotext -layout`), and READMEs/code in the user's work repositories (read-only).

- [ ] **Step 1: Draft `profile/profile.yaml`** following `profile/profile.example.yaml`. Rules:
  - Every highlight must be backed by the CV or by code/README evidence in the user's work repositories. No invented metrics; keep the CV's metrics as stated.
  - Include AI work the CV under-sells (verify each item in the repositories before writing), e.g. voice agents, RAG tooling, LLM evaluation, AI front-ends.
  - Add `Python` under skills only if the code confirms it.
  - Leave out email and phone (not needed in phase 1).
  - `workAuthorization`: the contractor wording from the example.

- [ ] **Step 2: Validate**

```bash
mise exec -- pnpm --filter @autoapplier/core exec tsx -e "import {loadProfile,renderProfileForPrompt,findRoot} from './src/index'; console.log(renderProfileForPrompt(loadProfile(findRoot()+'/profile/profile.yaml')))"
git status --short profile/   # must show nothing (ignored)
```
Expected: rendered profile printed; `git status` shows no `profile/profile.yaml`.

- [ ] **Step 3: Ask the user to review `profile/profile.yaml`** before any LLM run. No commit (file is ignored).

---

### Task 13: Worker pipeline, CLI and main loop

**Files:**
- Create: `apps/worker/src/bootstrap.ts`, `apps/worker/src/pipeline.ts`, `apps/worker/src/cli.ts`, `apps/worker/src/main.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from core; `createBot`, `notifyPending`, `MessageSender`.
- Produces: `bootstrap(): { root: string; cfg: Config; profileText: string; db: Db; env: { telegramToken?: string; chatId?: string } }`; `runPipelineOnce(ctx: PipelineCtx): Promise<PipelineSummary>` with `interface PipelineCtx { db: Db; cfg: Config; provider: LLMProvider; profileText: string; sender?: MessageSender; chatId?: string }` and `interface PipelineSummary { discover: DiscoverResult; filter: { passed: number; rejected: number }; score: ScoreRunResult; notified: number }`.

- [ ] **Step 1: Bootstrap**

`apps/worker/src/bootstrap.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadConfig, loadProfile, openDb, renderProfileForPrompt, seedCompanies } from '@autoapplier/core';

export function bootstrap() {
  const root = findRoot();
  const envPath = join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const cfg = loadConfig(join(root, 'config.yaml'));
  const profilePath = join(root, 'profile/profile.yaml');
  if (!existsSync(profilePath)) throw new Error(`missing ${profilePath} — copy profile/profile.example.yaml and fill it in`);
  const profileText = renderProfileForPrompt(loadProfile(profilePath));
  const db = openDb(join(root, process.env.DATABASE_PATH ?? 'data/app.db'));
  seedCompanies(db, cfg);
  return {
    root, cfg, profileText, db,
    env: { telegramToken: process.env.TELEGRAM_BOT_TOKEN || undefined, chatId: process.env.TELEGRAM_CHAT_ID || undefined },
  };
}
```

- [ ] **Step 2: Pipeline runner**

`apps/worker/src/pipeline.ts`:
```ts
import {
  buildSources, listActiveCompanies, runDiscover, runFilter, runScore,
  type Config, type Db, type DiscoverResult, type LLMProvider, type ScoreRunResult,
} from '@autoapplier/core';
import { notifyPending, type MessageSender } from './telegram';

export interface PipelineCtx { db: Db; cfg: Config; provider: LLMProvider; profileText: string; sender?: MessageSender; chatId?: string }
export interface PipelineSummary {
  discover: DiscoverResult; filter: { passed: number; rejected: number }; score: ScoreRunResult; notified: number;
}

export async function runPipelineOnce(ctx: PipelineCtx): Promise<PipelineSummary> {
  const { db, cfg } = ctx;
  const sources = buildSources(cfg, listActiveCompanies(db));
  const discover = await runDiscover(db, sources);
  const filter = runFilter(db, cfg);
  const score = await runScore({ db, cfg, provider: ctx.provider, profileText: ctx.profileText });
  let notified = 0;
  if (ctx.sender && ctx.chatId) {
    if (score.capped) await ctx.sender.sendMessage(ctx.chatId, `⚠️ Daily LLM spend cap ($${cfg.scoring.dailySpendCapUsd}) reached; scoring paused until tomorrow (UTC).`);
    notified = await notifyPending(ctx.sender, ctx.chatId, db);
  }
  return { discover, filter, score, notified };
}

export function logSummary(s: PipelineSummary): void {
  console.log(`[pipeline] sources fetched=${s.discover.fetched} new=${s.discover.inserted} errors=${s.discover.errors.length}`);
  for (const e of s.discover.errors) console.log(`  ! ${e.source}: ${e.message}`);
  console.log(`[pipeline] rules passed=${s.filter.passed} rejected=${s.filter.rejected}`);
  console.log(`[pipeline] scored=${s.score.scored} failed=${s.score.failed} capped=${s.score.capped} notified=${s.notified}`);
}
```

- [ ] **Step 3: CLI (`once`)**

`apps/worker/src/cli.ts`:
```ts
import { Bot } from 'grammy';
import { createProvider } from '@autoapplier/core';
import { bootstrap } from './bootstrap';
import { logSummary, runPipelineOnce } from './pipeline';
import type { MessageSender } from './telegram';

const [cmd] = process.argv.slice(2);
const app = bootstrap();

if (cmd === 'once') {
  const sender: MessageSender | undefined = app.env.telegramToken
    ? (() => { const api = new Bot(app.env.telegramToken!).api; return { sendMessage: (c, t, o) => api.sendMessage(c, t, o as never) }; })()
    : undefined;
  const summary = await runPipelineOnce({
    db: app.db, cfg: app.cfg, provider: createProvider(app.cfg.scoring.provider), profileText: app.profileText,
    sender, chatId: app.env.chatId,
  });
  logSummary(summary);
} else {
  console.log('usage: pnpm --filter @autoapplier/worker cli <once>');
  process.exitCode = 1;
}
```

- [ ] **Step 4: Main loop**

`apps/worker/src/main.ts`:
```ts
import cron from 'node-cron';
import { createProvider } from '@autoapplier/core';
import { bootstrap } from './bootstrap';
import { logSummary, runPipelineOnce } from './pipeline';
import { createBot, type MessageSender } from './telegram';

const app = bootstrap();
const { telegramToken, chatId } = app.env;
if (!telegramToken) throw new Error('TELEGRAM_BOT_TOKEN missing in .env');

const bot = createBot(telegramToken, chatId ?? '', app.db);
const sender: MessageSender = { sendMessage: (c, t, o) => bot.api.sendMessage(c, t, o as never) };
const provider = createProvider(app.cfg.scoring.provider);

let running = false;
async function tick() {
  if (running) { console.log('[pipeline] previous run still in progress, skipping'); return; }
  running = true;
  try {
    logSummary(await runPipelineOnce({ db: app.db, cfg: app.cfg, provider, profileText: app.profileText, sender, chatId }));
  } catch (e) {
    console.error('[pipeline] run failed', e);
  } finally {
    running = false;
  }
}

if (!chatId) console.warn('TELEGRAM_CHAT_ID missing: send /start to the bot to get it; notifications disabled until set.');
cron.schedule(`0 */${app.cfg.pollIntervalHours} * * *`, tick);
void bot.start({ onStart: (me) => console.log(`[telegram] @${me.username} polling`) });
void tick();

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void bot.stop(); process.exit(0); });
```

- [ ] **Step 5: Typecheck** — `mise exec -- pnpm typecheck` → no errors.

- [ ] **Step 6: Live run without Telegram (dry pass, real APIs, real LLM)**

Prereqs: `.env` with `ANTHROPIC_API_KEY`; `profile/profile.yaml` reviewed (Task 12). Temporarily keep spend tiny:
```bash
cp .env.example .env   # then fill ANTHROPIC_API_KEY (user does this)
AUTOAPPLIER_ROOT=$PWD mise exec -- pnpm once
```
Expected log: `sources fetched=<hundreds+> new=<n> errors=<small>`, `rules passed=<n> rejected=<most>`, `scored=<≤100> failed=0`. Then inspect:
```bash
sqlite3 data/app.db "select status, count(*) from jobs group by status;"
sqlite3 data/app.db "select j.title, j.company, json_extract(s.payload,'$.eligibility'), json_extract(s.payload,'$.fitScore'), json_extract(s.payload,'$.eligibilityEvidence') from jobs j join scores s on s.job_id=j.id order by 4 desc limit 15;"
sqlite3 data/app.db "select round(sum(cost_usd),4) from llm_usage;"
```
Check by eye: top results are relevant and evidence quotes are real. Report the numbers to the user.

- [ ] **Step 7: Telegram setup + live run** (user creates the bot via @BotFather and puts `TELEGRAM_BOT_TOKEN` in `.env`)
```bash
mise exec -- pnpm worker      # send /start to the bot → copy chat id into .env as TELEGRAM_CHAT_ID → restart
```
Expected: cards arrive best-first; pressing Shortlist/Skip updates the card's button and `sqlite3 data/app.db "select status,count(*) from jobs group by status"` shows `shortlisted`/`skipped`.

- [ ] **Step 8: README run section** — append to `README.md`:
```md
## Run (phase 1)

Requirements: mise (Node 22), pnpm.

    mise install && pnpm install
    cp .env.example .env                       # fill ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN
    cp profile/profile.example.yaml profile/profile.yaml   # fill in; stays local
    pnpm once      # one pipeline pass, prints a summary
    pnpm worker    # cron every pollIntervalHours + Telegram bot (/start shows your chat id)
    pnpm web       # dashboard at http://localhost:3100

Tune roles, eligibility regexes, pay floors, models and sources in `config.yaml`.
```

- [ ] **Step 9: Commit** — `git commit -m "feat(worker): pipeline runner, cli and cron main loop"`

---

### Task 14: Read-only dashboard

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/lib/db.ts`, `apps/web/lib/format.ts`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx`, `apps/web/app/jobs/[id]/page.tsx`, `apps/web/app/stats/page.tsx`

**Interfaces:**
- Consumes: `openDb`, `findRoot`, `listJobsByStatus`, `latestScore`, `getJob`, `listEvents`, `countByStatus`, `countBySource`, `spendByDay`, `formatComp`, `JOB_STATUSES`, `JobStatus`.
- Produces: pages `/` (queue, `?status=` filter), `/jobs/[id]`, `/stats`.

- [ ] **Step 1: Package + config**

```bash
mkdir -p apps/web && cd apps/web
cat > package.json <<'EOF'
{
  "name": "@autoapplier/web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "next dev -p 3100", "build": "next build", "start": "next start -p 3100", "typecheck": "tsc --noEmit", "test": "echo 'web: covered by build' " }
}
EOF
cd ../.. && mise exec -- pnpm --filter @autoapplier/web add next react react-dom @autoapplier/core@workspace:*
mise exec -- pnpm --filter @autoapplier/web add -D typescript @types/react @types/react-dom @types/node
```

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@autoapplier/core'],
  serverExternalPackages: ['better-sqlite3'],
};
export default config;
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM"], "jsx": "preserve", "plugins": [{ "name": "next" }], "allowJs": false, "incremental": true },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 2: DB + format helpers**

`apps/web/lib/db.ts`:
```ts
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { findRoot, openDb, type Db } from '@autoapplier/core';

let db: Db | undefined;
export function getDb(): Db | null {
  if (db) return db;
  const path = join(findRoot(), process.env.DATABASE_PATH ?? 'data/app.db');
  if (!existsSync(path)) return null;
  db = openDb(path, { readonly: true, migrate: false });
  return db;
}
```

`apps/web/lib/format.ts`:
```ts
export function ago(d: Date): string {
  const h = Math.round((Date.now() - d.getTime()) / 3_600_000);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
```

- [ ] **Step 3: Layout + styles**

`apps/web/app/layout.tsx`:
```tsx
import './globals.css';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = { title: 'Autoapplier' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav><Link href="/">Queue</Link><Link href="/stats">Stats</Link></nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

`apps/web/app/globals.css`:
```css
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #0f766e; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --line: #292524; --accent: #2dd4bf; --card: #1c1917; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
nav { display: flex; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
nav a, a { color: var(--accent); text-decoration: none; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.tabs a { padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; }
.tabs a.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
pre { white-space: pre-wrap; word-break: break-word; font: inherit; }
@media (max-width: 640px) { .hide-sm { display: none; } }
```

- [ ] **Step 4: Queue page**

`apps/web/app/page.tsx`:
```tsx
import Link from 'next/link';
import { JOB_STATUSES, formatComp, latestScore, listJobsByStatus, type JobStatus } from '@autoapplier/core';
import { getDb } from '../lib/db';
import { ago } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function Queue({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const db = getDb();
  if (!db) return <p>No database yet. Run <code>pnpm once</code> first.</p>;
  const { status: raw } = await searchParams;
  const status: JobStatus = (JOB_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as JobStatus) : 'awaiting_review';
  const rows = listJobsByStatus(db, [status], 300)
    .map((job) => ({ job, score: latestScore(db, job.id) }))
    .sort((a, b) => (b.score?.fitScore ?? -1) - (a.score?.fitScore ?? -1));

  return (
    <>
      <div className="tabs">
        {JOB_STATUSES.map((s) => <Link key={s} href={`/?status=${s}`} className={s === status ? 'on' : ''}>{s}</Link>)}
      </div>
      <table>
        <thead><tr><th>Fit</th><th>Role</th><th className="hide-sm">Eligibility</th><th className="hide-sm">Pay</th><th>Posted</th></tr></thead>
        <tbody>
          {rows.map(({ job, score }) => (
            <tr key={job.id}>
              <td>{score?.fitScore ?? '–'}</td>
              <td><Link href={`/jobs/${job.id}`}>{job.title}</Link><div className="muted">{job.company} · {job.locationText || '—'} · {job.source}</div>
                {job.filterReason && <div className="muted">{job.filterReason}</div>}</td>
              <td className="hide-sm">{score?.eligibility ?? '–'}</td>
              <td className="hide-sm">{formatComp(job) ?? '—'}{job.lowPay ? ' (low)' : ''}</td>
              <td>{ago(job.postedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">Nothing in {status}.</p>}
    </>
  );
}
```

- [ ] **Step 5: Job detail page**

`apps/web/app/jobs/[id]/page.tsx`:
```tsx
import { notFound } from 'next/navigation';
import { formatComp, getJob, latestScore, listEvents } from '@autoapplier/core';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await params;
  const job = db ? getJob(db, Number(id)) : undefined;
  if (!db || !job) notFound();
  const score = latestScore(db, job.id);
  const events = listEvents(db, job.id);
  return (
    <>
      <div className="card">
        <h2 style={{ margin: 0 }}>{job.title}</h2>
        <p className="muted">{job.company} · {job.locationText || '—'} · {formatComp(job) ?? 'pay not listed'} · {job.source} · status <b>{job.status}</b></p>
        <a href={job.applyUrl} target="_blank" rel="noreferrer">Open posting ↗</a>
      </div>
      {score && (
        <div className="card">
          <p><b>Fit {score.fitScore}</b> · {score.roleCategory} · eligibility <b>{score.eligibility}</b></p>
          <blockquote>“{score.eligibilityEvidence}”</blockquote>
          <p>✅ {score.matched.join(', ') || '—'}</p>
          <p>⚠️ {score.missing.join(', ') || '—'}</p>
          {score.redFlags.length > 0 && <p>🚩 {score.redFlags.join('; ')}</p>}
        </div>
      )}
      <div className="card"><pre>{job.description}</pre></div>
      <div className="card">
        <h3>History</h3>
        <ul>{events.map((e) => <li key={e.id}>{e.at.toISOString().slice(0, 16)} — {e.fromStatus ?? '∅'} → {e.toStatus}{e.note ? ` (${e.note})` : ''}</li>)}</ul>
      </div>
    </>
  );
}
```

- [ ] **Step 6: Stats page**

`apps/web/app/stats/page.tsx`:
```tsx
import { countBySource, countByStatus, spendByDay } from '@autoapplier/core';
import { getDb } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default function Stats() {
  const db = getDb();
  if (!db) return <p>No database yet.</p>;
  const byStatus = countByStatus(db);
  const bySource = countBySource(db);
  const spend = spendByDay(db);
  const total = spend.reduce((a, d) => a + d.costUsd, 0);
  return (
    <>
      <div className="card"><h3>By status</h3><table><tbody>{byStatus.map((r) => <tr key={r.status}><td>{r.status}</td><td>{r.count}</td></tr>)}</tbody></table></div>
      <div className="card"><h3>By source</h3><table><tbody>{bySource.map((r) => <tr key={r.source}><td>{r.source}</td><td>{r.count}</td></tr>)}</tbody></table></div>
      <div className="card"><h3>LLM spend (last {spend.length} days: ${total.toFixed(2)})</h3>
        <table><tbody>{spend.map((d) => <tr key={d.day}><td>{d.day}</td><td>${d.costUsd.toFixed(3)}</td></tr>)}</tbody></table></div>
    </>
  );
}
```

- [ ] **Step 7: Build + manual check**

```bash
mise exec -- pnpm --filter @autoapplier/web build
mise exec -- pnpm web   # open http://localhost:3100
```
Expected: build succeeds; with the DB from Task 13 the queue shows scored jobs sorted by fit; tabs switch status; detail page shows readable description, evidence quote, history; stats show counts and spend. With no DB, the page says "No database yet". If Next.js reports the `searchParams`/`params` types differently in the installed version, follow the compiler (both are Promises in Next 15+).

- [ ] **Step 8: Commit** — `git commit -m "feat(web): read-only dashboard (queue, job detail, stats)"`

---

### Task 15: Eligibility eval

**Files:**
- Create: `packages/core/src/eval/metrics.ts`
- Modify: `packages/core/src/index.ts`, `apps/worker/src/cli.ts`
- Test: `packages/core/test/eval.test.ts`

**Interfaces:**
- Consumes: `scoreJob`, `createProvider`, repo `listJobsByStatus`, `getJob`, `recordUsage`, `costUsd`.
- Produces: `interface EvalRow { jobId: number; label: 'eligible' | 'ineligible'; predicted: 'eligible' | 'likely' | 'unlikely' | 'ineligible' }`; `computeEligibilityMetrics(rows: EvalRow[]): { n: number; accuracy: number; falsePositives: number[]; falseNegatives: number[] }`; CLI commands `export-eval [n]` and `eval [model]`.

- [ ] **Step 1: Failing test**

`packages/core/test/eval.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeEligibilityMetrics } from '../src/eval/metrics';

describe('computeEligibilityMetrics', () => {
  it('treats eligible/likely as positive and reports errors', () => {
    const m = computeEligibilityMetrics([
      { jobId: 1, label: 'eligible', predicted: 'eligible' },
      { jobId: 2, label: 'eligible', predicted: 'unlikely' },
      { jobId: 3, label: 'ineligible', predicted: 'likely' },
      { jobId: 4, label: 'ineligible', predicted: 'ineligible' },
    ]);
    expect(m).toEqual({ n: 4, accuracy: 0.5, falsePositives: [3], falseNegatives: [2] });
  });
  it('handles empty input', () => {
    expect(computeEligibilityMetrics([])).toEqual({ n: 0, accuracy: 0, falsePositives: [], falseNegatives: [] });
  });
});
```

- [ ] **Step 2: Run → FAIL. Implement**

`packages/core/src/eval/metrics.ts`:
```ts
export interface EvalRow {
  jobId: number;
  label: 'eligible' | 'ineligible';
  predicted: 'eligible' | 'likely' | 'unlikely' | 'ineligible';
}

export function computeEligibilityMetrics(rows: EvalRow[]) {
  const falsePositives: number[] = [];
  const falseNegatives: number[] = [];
  let correct = 0;
  for (const r of rows) {
    const positive = r.predicted === 'eligible' || r.predicted === 'likely';
    if (positive === (r.label === 'eligible')) correct++;
    else if (positive) falsePositives.push(r.jobId);
    else falseNegatives.push(r.jobId);
  }
  return { n: rows.length, accuracy: rows.length ? correct / rows.length : 0, falsePositives, falseNegatives };
}
```
Append `export * from './eval/metrics';` to core `index.ts`. Run tests → PASS.

- [ ] **Step 3: CLI commands** — in `apps/worker/src/cli.ts`, add before the `else` branch:

```ts
} else if (cmd === 'export-eval') {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { listJobsByStatus } = await import('@autoapplier/core');
  const n = Number(process.argv[3] ?? 30);
  const pool = listJobsByStatus(app.db, ['awaiting_review', 'ineligible', 'low_score', 'shortlisted', 'skipped'], 1000);
  const pick = pool.sort(() => Math.random() - 0.5).slice(0, n);
  mkdirSync(join(app.root, 'data/eval'), { recursive: true });
  const out = join(app.root, 'data/eval/eligibility.jsonl');
  writeFileSync(out, pick.map((j) => JSON.stringify({ jobId: j.id, company: j.company, title: j.title, location: j.locationText, url: j.applyUrl, label: null })).join('\n') + '\n');
  console.log(`wrote ${pick.length} rows to ${out}. Set "label" to "eligible" or "ineligible" for each (open the url), then run: pnpm --filter @autoapplier/worker cli eval`);
} else if (cmd === 'eval') {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { getJob, scoreJob, computeEligibilityMetrics, recordUsage, costUsd } = await import('@autoapplier/core');
  const model = process.argv[3] ?? app.cfg.scoring.model;
  const provider = createProvider(model.startsWith('claude') ? 'anthropic' : 'openai');
  const lines = readFileSync(join(app.root, 'data/eval/eligibility.jsonl'), 'utf8').split('\n').filter(Boolean);
  const labeled = lines.map((l) => JSON.parse(l) as { jobId: number; label: 'eligible' | 'ineligible' | null }).filter((r) => r.label);
  const rows = [];
  for (const r of labeled) {
    const job = getJob(app.db, r.jobId);
    if (!job) continue;
    const s = await scoreJob(provider, model, app.profileText, job, (u) =>
      recordUsage(app.db, { jobId: job.id, stage: 'eval', ...u, costUsd: costUsd(app.cfg.pricing, u) }));
    rows.push({ jobId: job.id, label: r.label!, predicted: s.eligibility });
  }
  const m = computeEligibilityMetrics(rows);
  console.log(`model=${model} n=${m.n} accuracy=${(m.accuracy * 100).toFixed(1)}%`);
  console.log(`false positives (would waste an application): ${m.falsePositives.join(', ') || 'none'}`);
  console.log(`false negatives (missed eligible jobs): ${m.falseNegatives.join(', ') || 'none'}`);
```
Update the usage line to `<once|export-eval [n]|eval [model]>`.

- [ ] **Step 4: Typecheck + tests** — `mise exec -- pnpm typecheck && mise exec -- pnpm test` → PASS.

- [ ] **Step 5: Run with the user** — after a few days of data: `pnpm --filter @autoapplier/worker cli export-eval 30`, the user labels the file, then `cli eval` (and optionally `cli eval gpt-5.6-luna` with the correct OpenAI model id to compare). Target: accuracy ≥ 90% and false positives ≤ 2/30 before trusting scoring blindly. Report results.

- [ ] **Step 6: Commit** — `git commit -m "feat: eligibility eval (export, label, measure)"`

---

## Out of scope for phase 1 (later phases, per spec §10)

Drafting (cover letter, answers, tailored CV), auto-submit adapters, Workable and HN "Who is hiring" sources, application tracking beyond shortlist/skip, Batch API and prompt caching for scoring (volume is small; revisit if spend > $10/month), server-side fallbacks for Opus drafting (phase 2).
