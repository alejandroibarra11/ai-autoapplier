import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { loadConfig, type Config } from '../src/config';
import { loadProfile } from '../src/profile';
import { parseAnswers } from '../src/answers';
import { findRoot } from '../src/root';
import type { FormQuestion, DraftAnswer } from '../src/apply/types';
import type { LLMProvider, StructuredRequest } from '../src/llm/provider';
import type { PageFactory } from '../src/pipeline/fill';
import { insertDraft, insertJobs, listJobsByStatus, setResolved, setStatus } from '../src/db/repo';
import { makeJob, testDb } from './helpers';

export const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/**
 * Answers every request matching `pattern` locally: POSTs are recorded in `posted` and answered `{}`; everything else gets `html(url)`.
 * Nothing reaches the network.
 */
export async function serveLocally(page: Page, posted: string[], html: (url: string) => string, pattern = '**/*'): Promise<void> {
  await page.route(pattern, async (route) => {
    if (route.request().method() === 'POST') { posted.push(route.request().postData() ?? ''); return route.fulfill({ status: 200, body: '{}' }); }
    return route.fulfill({ status: 200, contentType: 'text/html', body: html(route.request().url()) });
  });
}

/** A new page serving `fixture` for every URL under `base`, opened at `<base>/acme/jobs/1<query>`. */
export async function openFixture(browser: Browser, posted: string[], name: string, query = '', base = 'https://boards.test'): Promise<Page> {
  const page = await browser.newPage();
  await serveLocally(page, posted, () => fixture(name), `${base}/**`);
  await page.goto(`${base}/acme/jobs/1${query}`);
  return page;
}

/** PageFactory whose pages answer every request locally with `state.html` (mutable between calls). */
export function fakePages(browser: Browser, state: { html: string; posted: string[] }): PageFactory & { opened: Page[] } {
  const opened: Page[] = [];
  return {
    opened,
    async newPage() {
      const p = await browser.newPage();
      opened.push(p);
      await serveLocally(p, state.posted, () => state.html);
      return p;
    },
  };
}

// ---- stage fixtures (Greenhouse form) ----

const root = findRoot();
export const baseCfg: Config = loadConfig(join(root, 'config.yaml'));
export const cfgWith = (submit: Partial<Config['submit']>): Config => ({ ...baseCfg, submit: { ...baseCfg.submit, ...submit } });
export const profile = loadProfile(join(root, 'profile/profile.example.yaml'));
// The fixture's location widget only knows Mazatlán.
export const answers = { ...parseAnswers(readFileSync(join(root, 'profile/answers.example.yaml'), 'utf8')), location: 'Mazatlán, Mexico' };

export const GH_QUESTIONS: FormQuestion[] = [
  { id: 'first_name', label: 'First Name', type: 'identity', required: true },
  { id: 'question_1', label: 'LinkedIn Profile', type: 'text', required: true },
  { id: 'question_2', label: 'Are you authorized to work?', type: 'select', required: true, options: ['Yes', 'No'] },
  { id: 'question_3', label: 'Why us?', type: 'textarea', required: true },
];
export const GH_ANSWERS: DraftAnswer[] = [
  { questionId: 'question_1', label: 'LinkedIn Profile', answer: 'https://linkedin.com/in/x', source: 'answers' },
  { questionId: 'question_2', label: 'Are you authorized to work?', answer: 'No', source: 'answers' },
  { questionId: 'question_3', label: 'Why us?', answer: 'Because I like it', source: 'generated' },
];

export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** One `ready_to_apply` Greenhouse job with a draft and a real CV file. */
export function readyJob(opts: { db?: ReturnType<typeof testDb>; questions?: FormQuestion[]; answers?: DraftAnswer[]; now?: Date } = {}) {
  const db = opts.db ?? testDb();
  const dir = tmp('aa-stage-');
  const cv = join(dir, 'cv.pdf');
  writeFileSync(cv, '%PDF-1.4 test');
  const before = new Set(listJobsByStatus(db, ['discovered']).map((j) => j.id));
  insertJobs(db, [makeJob()]);
  const job = listJobsByStatus(db, ['discovered']).find((j) => !before.has(j.id))!;
  setResolved(db, job.id, `https://job-boards.greenhouse.io/acme/jobs/${job.id}`, 'greenhouse');
  insertDraft(db, {
    jobId: job.id, model: 'm', coverLetter: 'Dear team', answers: opts.answers ?? GH_ANSWERS, questions: opts.questions ?? GH_QUESTIONS,
    cvSelection: { skillsOrder: [], bulletIds: [] }, cvPdfPath: cv, flags: [],
  }, opts.now);
  setStatus(db, job.id, 'ready_to_apply', null, {}, opts.now);
  return { db, jobId: job.id, shotsDir: join(dir, 'shots') };
}

export class FakeProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  calls = 0;
  constructor(private readonly out: unknown) {}
  async generateStructured<T>(model: string, _q: StructuredRequest<T>) {
    this.calls++;
    return { data: this.out as T, usage: { provider: 'anthropic' as const, model, inputTokens: 100, outputTokens: 50 } };
  }
}
export const llmOut = (answers: { questionId: string; answer: string }[], claimedSkills: string[] = []) =>
  ({ coverLetter: 'Hi', answers, skillsOrder: [], bulletIds: ['e0-b0'], claimedSkills });
