import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { greenhouseFiller } from '../src/submit/fillers/greenhouse';
import { fillerFor } from '../src/submit/fillers';
import { takeShot, pngSize } from '../src/submit/screenshot';
import type { FillPlan } from '../src/submit/types';

let browser: Browser;
const dir = mkdtempSync(join(tmpdir(), 'aa-fill-'));
const cv = join(dir, 'cv.pdf'); writeFileSync(cv, '%PDF-1.4 test');
const posted: string[] = [];

async function open(fixture: string, base = 'https://boards.test'): Promise<Page> {
  const page = await browser.newPage();
  await page.route(`${base}/**`, async (route) => {
    if (route.request().method() === 'POST') { posted.push(route.request().postData() ?? ''); return route.fulfill({ status: 200, body: '{}' }); }
    return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(__dirname, 'fixtures', fixture), 'utf8') });
  });
  await page.goto(`${base}/acme/jobs/1`);
  return page;
}
const e = (fieldId: string, value: string, kind: FillPlan['entries'][number]['kind'] = 'text', required = true, source: FillPlan['entries'][number]['source'] = 'identity') =>
  ({ fieldId, label: fieldId, kind, value, source, required });

const plan: FillPlan = { missingRequired: [], manualReasons: [], entries: [
  e('identity:firstName', 'Jane'), e('identity:lastName', 'Doe'), e('identity:email', 'jane@example.com'), e('identity:phone', '+52 000 000 0000'),
  e('identity:country', 'Mexico'), e('identity:location', 'Mazatlán, Mexico'), e('identity:resume', cv, 'file'),
  e('identity:coverLetter', 'Hello', 'textarea', false), e('identity:github', 'https://github.com/x', 'text', false),
  e('question_1', 'https://linkedin.com/in/x', 'text', true, 'answers'), e('question_2', 'No', 'select', true, 'answers'),
  e('question_3', 'Because I like it', 'textarea', true, 'draft'),
] };

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe('greenhouseFiller', () => {
  it('fills every field including comboboxes and the resume', async () => {
    posted.length = 0;
    const page = await open('greenhouse-form.html');
    const r = await greenhouseFiller.fill(page, plan);
    expect(r.failed).toEqual([]);
    expect(r.requiredEmpty).toEqual([]);
    expect(await page.inputValue('#first_name')).toBe('Jane');
    expect(await page.inputValue('#country')).toBe('Mexico');
    expect(await page.inputValue('#candidate-location')).toBe('Mazatlán, Sinaloa, Mexico');
    expect(await page.inputValue('#question_2')).toBe('No');
    expect(await page.inputValue('#question_3')).toBe('Because I like it');
    expect(await page.$eval('#resume', (i) => (i as HTMLInputElement).files?.[0]?.name)).toBe('cv.pdf');
    expect(r.notFound).toContain('identity:github');
    expect(posted).toEqual([]); // fill never submits
    const all = [...r.filled, ...r.notFound, ...r.failed].sort();
    expect(all).toEqual(plan.entries.map((x) => x.fieldId).sort());
    const shot = await takeShot(page, join(dir, 'shots', 'a.png'));
    expect(pngSize(shot).width).toBeGreaterThan(100);
    await page.close();
  }, 60_000);

  it('reports a missing planned field and empty required fields', async () => {
    const page = await open('greenhouse-form.html');
    const r = await greenhouseFiller.fill(page, { ...plan, entries: plan.entries.filter((x) => x.fieldId !== 'question_3').concat(e('question_99', 'x', 'text', true, 'draft')) });
    expect(r.notFound).toContain('question_99');
    expect(r.requiredEmpty.length).toBeGreaterThan(0);
    await page.close();
  }, 60_000);

  it('submits and detects the confirmation; the POST is intercepted locally', async () => {
    posted.length = 0;
    const page = await open('greenhouse-form.html');
    await greenhouseFiller.fill(page, plan);
    const out = await greenhouseFiller.submit(page, 10_000);
    expect(out.kind).toBe('confirmed');
    expect(posted.length).toBe(1);
    await page.close();
  }, 60_000);

  it('fillerFor maps kinds', () => {
    expect(fillerFor('greenhouse')).toBe(greenhouseFiller);
    expect(fillerFor('other')).toBeNull();
  });
});
