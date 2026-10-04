// Live FILL-ONLY smoke on a real Greenhouse, Lever or Ashby posting. Never submits, never presses Enter.
// Usage: tsx scripts/fill-smoke.ts <job url | lever apply url | ashby application url> <out.png> [cv.pdf]
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnswers } from '../src/answers';
import { parseProfile } from '../src/profile';
import { buildFillPlan } from '../src/submit/plan';
import { fillerFor } from '../src/submit/fillers';
import { takeShot } from '../src/submit/screenshot';
import { openBrowser, makePageOpener } from '../src/browser';
import { normalizeFormFields } from '../src/apply/form-fields';
import type { FormQuestion } from '../src/apply/types';
import { fetchGreenhouseQuestions } from '../src/apply/greenhouse-questions';

const [url, out, cvArg] = process.argv.slice(2);
if (!url || !out) { console.error('usage: fill-smoke <url> <out.png> [cv.pdf]'); process.exit(1); }

const root = join(import.meta.dirname, '..', '..', '..', 'profile');
const answers = { ...parseAnswers(readFileSync(join(root, 'answers.example.yaml'), 'utf8')), location: 'Guadalajara, Mexico' }; // real city so the live autocomplete has a match
const profile = parseProfile(readFileSync(join(root, 'profile.example.yaml'), 'utf8'));
let cv = cvArg;
if (!cv) { cv = join(mkdtempSync(join(tmpdir(), 'aa-smoke-')), 'cv.pdf'); writeFileSync(cv, '%PDF-1.4 dummy'); }

const session = await openBrowser({ headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'aa-smoke-ud-')) });
try {
  const gh = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  const kind = gh ? 'greenhouse' : /jobs\.lever\.co\//.test(url) ? 'lever' : /jobs\.ashbyhq\.com\//.test(url) ? 'ashby' : null;
  if (!kind) throw new Error('not a greenhouse, lever or ashby job url');
  const filler = fillerFor(kind)!;
  let questions: FormQuestion[];
  if (gh) questions = await fetchGreenhouseQuestions(gh[1]!, gh[2]!);
  else questions = normalizeFormFields(await makePageOpener(session, 45_000).readForm(url)); // read-only visit of the blank form
  const draft = {
    cvPdfPath: cv, coverLetter: 'Example cover letter.',
    answers: questions.filter((q) => q.type !== 'identity' && q.type !== 'file').map((q) => ({
      questionId: q.id, label: q.label, source: 'generated' as const,
      answer: q.options?.[0] ?? (q.type === 'boolean' ? 'Yes' : q.type === 'textarea' ? 'Example answer.' : 'https://example.com'),
    })),
  };
  const plan = buildFillPlan({ questions, draft, answers, profile });
  const page = await session.context.newPage();
  const nonGet: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'OPTIONS') nonGet.push(`${r.method()} ${r.url().slice(0, 120)}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const report = await filler.fill(page, plan); // FILL ONLY
  await takeShot(page, out);
  console.log(JSON.stringify({ kind, nonGetRequestsDuringFill: nonGet, plan: { entries: plan.entries.length, missingRequired: plan.missingRequired, manualReasons: plan.manualReasons }, report }, null, 2));
  console.log('screenshot', out);
} finally {
  await session.close();
}
