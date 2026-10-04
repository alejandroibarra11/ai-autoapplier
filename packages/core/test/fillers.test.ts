import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { greenhouseFiller } from '../src/submit/fillers/greenhouse';
import { guardFill, chooseCombobox, fillText } from '../src/submit/dom';
import { fillerFor } from '../src/submit/fillers';
import { takeShot, pngSize } from '../src/submit/screenshot';
import type { FillPlan } from '../src/submit/types';

let browser: Browser;
const dir = mkdtempSync(join(tmpdir(), 'aa-fill-'));
const cv = join(dir, 'cv.pdf'); writeFileSync(cv, '%PDF-1.4 test');
const posted: string[] = [];

async function open(fixture: string, query = '', base = 'https://boards.test'): Promise<Page> {
  const page = await browser.newPage();
  await page.route(`${base}/**`, async (route) => {
    if (route.request().method() === 'POST') { posted.push(route.request().postData() ?? ''); return route.fulfill({ status: 200, body: '{}' }); }
    return route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(__dirname, 'fixtures', fixture), 'utf8') });
  });
  await page.goto(`${base}/acme/jobs/1${query}`);
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
    expect(await page.locator('.chip').innerText()).toBe('cv.pdf'); // the fixture swaps the input for a chip, like Greenhouse
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

  const settle = (page: Page) => page.waitForTimeout(600);
  const setOpts = (page: Page, sel: string, opts: string) => page.evaluate(([s, o]) => { (document.querySelector(s!) as HTMLElement).dataset.options = o; }, [sel, opts]);
  const locPlan = (loc: string): FillPlan => ({ missingRequired: [], manualReasons: [], entries: [e('identity:country', 'Mexico'), e('identity:location', loc)] });

  it('never submits through typed newlines (Enter)', async () => {
    posted.length = 0;
    const page = await open('greenhouse-form.html', '?norequired');
    expect(await chooseCombobox(page, '#question_2', 'Maybe\n')).toBe(false);
    await fillText(page, '#question_1', 'x\n');
    await settle(page);
    expect(posted).toEqual([]);
    expect(await page.inputValue('#question_1')).toBe('x');
    await page.close();
  }, 60_000);

  it('guardFill aborts form posts and navigations until unguarded', async () => {
    posted.length = 0;
    const page = await open('greenhouse-form.html', '?norequired');
    const un = await guardFill(page);
    await page.evaluate(() => (document.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle(page);
    expect(posted).toEqual([]);
    await un();
    await page.evaluate(() => (document.querySelector('form') as HTMLFormElement).requestSubmit());
    await settle(page);
    expect(posted.length).toBe(1);
    await page.close();
    // a plain (non-fetch) form navigation is aborted too
    posted.length = 0;
    const nav = await open('greenhouse-form.html', '?norequired');
    const un2 = await guardFill(nav);
    await nav.evaluate(() => (document.querySelector('form') as HTMLFormElement).submit()).catch(() => {});
    await settle(nav);
    expect(posted).toEqual([]);
    await un2();
    await nav.close();
  }, 60_000);

  it('reports a failed upload as failed', async () => {
    const page = await open('greenhouse-form.html', '?uploadfail');
    const r = await greenhouseFiller.fill(page, plan);
    expect(r.failed).toContain('identity:resume');
    await page.close();
  }, 60_000);

  it('does not click a partial match ("No" vs "Not sure")', async () => {
    const page = await open('greenhouse-form.html');
    await setOpts(page, '#question_2', 'Not sure|None of the above');
    expect(await chooseCombobox(page, '#question_2', 'No')).toBe(false);
    expect(['Not sure', 'None of the above']).not.toContain(await page.inputValue('#question_2'));
    await setOpts(page, '#question_2', 'Yes|No');
    expect(await chooseCombobox(page, '#question_2', 'no')).toBe(true);
    expect(await page.inputValue('#question_2')).toBe('No');
    await page.close();
  }, 60_000);

  it('scopes options to the input listbox (aria-controls)', async () => {
    const page = await open('greenhouse-form.html');
    await page.evaluate(() => {
      document.querySelector('#question_2')!.setAttribute('aria-controls', 'lb2');
      document.body.insertAdjacentHTML('afterbegin', '<div role="listbox" id="decoy"><div role="option" onclick="window.__decoy=1">No</div></div>');
    });
    expect(await chooseCombobox(page, '#question_2', 'No')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __decoy?: number }).__decoy)).toBeUndefined();
    await page.close();
  }, 60_000);

  it('submit ignores a pre-existing visible error element', async () => {
    const page = await open('greenhouse-form.html', '?errorboundary');
    await greenhouseFiller.fill(page, plan);
    expect((await greenhouseFiller.submit(page, 10_000)).kind).toBe('confirmed');
    await page.close();
  }, 60_000);

  it('location needs the right country as the last segment', async () => {
    const page = await open('greenhouse-form.html');
    await setOpts(page, '#candidate-location', 'Guadalajara, Spain|New Mexico, United States|Guadalajara, Jalisco, Mexico');
    const r = await greenhouseFiller.fill(page, locPlan('Guadalajara, Mexico'));
    expect(r.filled).toContain('identity:location');
    expect(await page.inputValue('#candidate-location')).toBe('Guadalajara, Jalisco, Mexico');
    const page2 = await open('greenhouse-form.html');
    await setOpts(page2, '#candidate-location', 'Guadalajara, Spain');
    const r2 = await greenhouseFiller.fill(page2, locPlan('Guadalajara, Mexico'));
    expect(r2.failed).toContain('identity:location');
    const page3 = await open('greenhouse-form.html');
    const r3 = await greenhouseFiller.fill(page3, { ...locPlan('Guadalajara'), entries: [e('identity:location', 'Guadalajara')] });
    expect(r3.failed).toContain('identity:location');
    await page.close(); await page2.close(); await page3.close();
  }, 60_000);

  it('empty multiselect fails; native select and choice buttons work', async () => {
    const page = await open('greenhouse-form.html');
    const r = await greenhouseFiller.fill(page, { missingRequired: [], manualReasons: [], entries: [
      e('question_2', '', 'multiselect'), e('question_4', 'Maybe', 'select'), e('question_5', 'No', 'choice'),
    ] });
    expect(r.failed).toContain('question_2');
    expect(r.filled).toEqual(expect.arrayContaining(['question_4', 'question_5']));
    expect(await page.inputValue('#question_4')).toBe('Maybe');
    expect(await page.getAttribute('#question_5', 'data-chosen')).toBe('No');
    await page.close();
  }, 60_000);

  it('fillerFor maps kinds', () => {
    expect(fillerFor('greenhouse')).toBe(greenhouseFiller);
    expect(fillerFor('other')).toBeNull();
  });
});
