// Live FILL-ONLY smoke on a real Greenhouse posting. Never submits, never presses Enter.
// Usage: tsx scripts/fill-smoke.ts <greenhouse job url> <out.png> [cv.pdf]
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnswers } from '../src/answers';
import { parseProfile } from '../src/profile';
import { buildFillPlan } from '../src/submit/plan';
import { greenhouseFiller } from '../src/submit/fillers/greenhouse';
import { takeShot } from '../src/submit/screenshot';
import { openBrowser } from '../src/browser';
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
  const m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (!m) throw new Error('not a greenhouse job url');
  const questions = await fetchGreenhouseQuestions(m[1]!, m[2]!);
  // Dummy answers for every non-identity, non-demographic question so the custom-field paths get exercised.
  const draft = {
    cvPdfPath: cv, coverLetter: 'Example cover letter.',
    answers: questions.filter((q) => q.type !== 'identity' && q.type !== 'file').map((q) => ({
      questionId: q.id, label: q.label, source: 'generated' as const,
      answer: q.options?.[0] ?? (q.type === 'textarea' ? 'Example answer.' : 'https://example.com'),
    })),
  };
  const plan = buildFillPlan({ questions, draft, answers, profile });
  const page = await session.context.newPage();
  const nonGet: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'OPTIONS') nonGet.push(`${r.method()} ${r.url().slice(0, 120)}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const report = await greenhouseFiller.fill(page, plan); // FILL ONLY
  await takeShot(page, out);
  console.log(JSON.stringify({ nonGetRequestsDuringFill: nonGet, plan: { entries: plan.entries.length, missingRequired: plan.missingRequired, manualReasons: plan.manualReasons }, report }, null, 2));
  console.log('screenshot', out);
} finally {
  await session.close();
}
