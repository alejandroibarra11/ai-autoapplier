import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { greenhouseFiller } from '../src/submit/fillers/greenhouse';
import { leverFiller } from '../src/submit/fillers/lever';
import { ashbyFiller } from '../src/submit/fillers/ashby';
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

  it('multiselect verifies chips; unknown value fails', async () => {
    const page = await open('greenhouse-form.html');
    const r = await greenhouseFiller.fill(page, { missingRequired: [], manualReasons: [], entries: [e('question_6', 'A; C', 'multiselect')] });
    expect(r.filled).toContain('question_6');
    expect(await page.locator('.select__multi-value__label').allInnerTexts()).toEqual(['A', 'C']);
    const page2 = await open('greenhouse-form.html');
    const r2 = await greenhouseFiller.fill(page2, { missingRequired: [], manualReasons: [], entries: [e('question_6', 'A; Z', 'multiselect')] });
    expect(r2.failed).toContain('question_6');
    await page.close(); await page2.close();
  }, 60_000);

  it('a navigation during fill fails the current and remaining entries', async () => {
    posted.length = 0;
    const page = await open('greenhouse-form.html', '?norequired');
    const r = await greenhouseFiller.fill(page, { missingRequired: [], manualReasons: [], entries: [
      e('question_1', 'x'), e('question_7', 'Go', 'choice'), e('question_3', 'later', 'textarea'), e('identity:firstName', 'Jane'),
    ] });
    expect(r.filled).toEqual(['question_1']);
    expect(r.failed).toEqual(['question_7', 'question_3', 'identity:firstName']);
    expect(r.notFound).toEqual([]);
    expect(posted).toEqual([]);
    await page.close();
  }, 60_000);

  it('fillerFor maps kinds', () => {
    expect(fillerFor('greenhouse')).toBe(greenhouseFiller);
    expect(fillerFor('lever')).toBe(leverFiller);
    expect(fillerFor('ashby')).toBe(ashbyFiller);
    expect(fillerFor('other')).toBeNull();
  });
});

const P = (entries: FillPlan['entries']): FillPlan => ({ missingRequired: [], manualReasons: [], entries });
const allSorted = (r: { filled: string[]; notFound: string[]; failed: string[] }) => [...r.filled, ...r.notFound, ...r.failed].sort();

const leverPlan: FillPlan = P([
  e('identity:firstName', 'Jane'), e('identity:lastName', 'Doe'), e('identity:fullName', 'Jane Doe'), e('identity:email', 'jane@example.com'),
  e('identity:phone', '+52 000 000 0000'), e('identity:country', 'Mexico'), e('identity:location', 'Guadalajara, Mexico'),
  e('identity:currentCompany', 'Initech', 'text', false), e('identity:linkedin', 'https://linkedin.com/in/x', 'text', false),
  e('identity:github', 'https://github.com/x', 'text', false), e('identity:portfolio', 'https://x.dev', 'text', false),
  e('identity:resume', cv, 'file'), e('identity:coverLetter', 'Hello\nthere', 'textarea', false),
  e('cards[c1][field0]', 'About me\nline two', 'textarea', true, 'draft'),
  e('cards[c1][field1]', "Bachelor's degree", 'select', true, 'answers'),
  e('cards[c1][field2]', 'EU; US', 'multiselect', false, 'answers'),
  e('cards[c1][field3]', 'Yes', 'select', false, 'answers'),
]);

describe('leverFiller', () => {
  it('fills every field (resume first, location autocomplete, radios/checkboxes by label, native select)', async () => {
    posted.length = 0;
    const page = await open('lever-form.html');
    const r = await leverFiller.fill(page, leverPlan);
    expect(r.failed).toEqual([]);
    expect(r.requiredEmpty).toEqual([]);
    expect(r.notFound.sort()).toEqual(['identity:country', 'identity:firstName', 'identity:lastName']);
    expect(await page.inputValue('[name="name"]')).toBe('Jane Doe'); // not overwritten by the resume parser, which ran first
    expect(await page.inputValue('[name="email"]')).toBe('jane@example.com');
    expect(await page.inputValue('[name="org"]')).toBe('Initech');
    expect(await page.inputValue('[name="urls[LinkedIn Profile]"]')).toBe('https://linkedin.com/in/x');
    expect(await page.inputValue('[name="urls[Github]"]')).toBe('https://github.com/x');
    expect(await page.inputValue('[name="location"]')).toBe('Guadalajara, Jalisco, MEX');
    expect(await page.inputValue('[name="selectedLocation"]')).toContain('Guadalajara');
    expect(await page.locator('.filename').innerText()).toBe('cv.pdf');
    expect(await page.inputValue('[name="comments"]')).toBe('Hello\nthere');
    expect(await page.locator('[name="cards[c1][field1]"]:checked').getAttribute('value')).toBe("Bachelor's degree"); // not "Bachelor's degree or above"
    expect(await page.locator('[name="cards[c1][field2]"]:checked').evaluateAll((els) => els.map((x) => (x as HTMLInputElement).value))).toEqual(['EU', 'US']);
    expect(await page.inputValue('[name="cards[c1][field3]"]')).toBe('Yes');
    expect(allSorted(r)).toEqual(leverPlan.entries.map((x) => x.fieldId).sort());
    expect(posted).toEqual([]);
    await page.close();
  }, 60_000);

  it('reports a missing planned field and empty required fields', async () => {
    const page = await open('lever-form.html');
    const r = await leverFiller.fill(page, P([e('identity:email', 'jane@example.com'), e('cards[c1][field99]', 'x', 'text', true, 'draft')]));
    expect(r.notFound).toContain('cards[c1][field99]');
    expect(r.requiredEmpty).toEqual(expect.arrayContaining(['Full name', 'Education']));
    expect(r.requiredEmpty.filter((x) => /education/i.test(x)).length).toBe(1); // a radio group is reported once
    await page.close();
  }, 60_000);

  it('never submits through typed newlines; textareas keep them', async () => {
    posted.length = 0;
    const page = await open('lever-form.html', '?norequired');
    const r = await leverFiller.fill(page, P([e('identity:fullName', 'Jane\nDoe'), e('cards[c1][field0]', 'a\nb', 'textarea')]));
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);
    expect(r.filled).toEqual(['identity:fullName', 'cards[c1][field0]']);
    expect(await page.inputValue('[name="name"]')).toBe('Jane Doe');
    expect(await page.inputValue('[name="cards[c1][field0]"]')).toBe('a\nb');
    await page.close();
  }, 60_000);

  it('fill runs under guardFill (form post aborted mid-fill)', async () => {
    posted.length = 0;
    const page = await open('lever-form.html', '?norequired');
    await page.evaluate(() => { document.querySelector('[name="name"]')!.addEventListener('input', () => { (document.getElementById('application-form') as HTMLFormElement).requestSubmit(); (document.getElementById('application-form') as HTMLFormElement).submit(); }); });
    await leverFiller.fill(page, P([e('identity:fullName', 'Jane Doe')]));
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);
    await page.close();
  }, 60_000);

  it('choices need an exact option; location needs the right country; nothing is guessed', async () => {
    const page = await open('lever-form.html');
    const r = await leverFiller.fill(page, P([
      e('cards[c1][field1]', "Bachelor's", 'select'), e('cards[c1][field3]', 'Ye', 'select'), e('cards[c1][field3]', 'yes, MAYBE', 'select'),
      e('identity:location', 'Guadalajara, Spain'),
    ]));
    expect(r.failed).toEqual(['cards[c1][field1]', 'cards[c1][field3]', 'cards[c1][field3]']);
    expect(await page.locator('[name="cards[c1][field1]"]:checked').count()).toBe(0);
    expect(r.filled).toContain('identity:location'); // Spain is a real, exactly requested country here
    expect(await page.inputValue('[name="location"]')).toBe('Guadalajara, Castilla-La Mancha, ESP');
    const page2 = await open('lever-form.html');
    const r2 = await leverFiller.fill(page2, P([e('identity:location', 'Guadalajara, Peru')]));
    expect(r2.failed).toEqual(['identity:location']);
    expect(await page2.inputValue('[name="location"]')).toBe('');
    await page.close(); await page2.close();
  }, 60_000);

  it('a navigation during fill fails the current and remaining entries', async () => {
    posted.length = 0;
    const page = await open('lever-form.html', '?norequired');
    const r = await leverFiller.fill(page, P([e('identity:fullName', 'Jane'), e('cards[c1][nav]', 'go'), e('identity:email', 'a@b.co')]));
    expect(r.filled).toEqual(['identity:fullName']);
    expect(r.failed).toEqual(['cards[c1][nav]', 'identity:email']);
    expect(r.notFound).toEqual([]);
    await page.close();
  }, 60_000);

  it('submits and detects the confirmation with exactly one intercepted POST; ignores a pre-existing error', async () => {
    posted.length = 0;
    const page = await open('lever-form.html', '?errorboundary');
    await leverFiller.fill(page, leverPlan);
    const out = await leverFiller.submit(page, 10_000);
    expect(out.kind).toBe('confirmed');
    expect(posted.length).toBe(1);
    await page.close();
  }, 60_000);
});

const ashbyPlan: FillPlan = P([
  e('identity:firstName', 'Jane'), e('identity:fullName', 'Jane Doe'), e('identity:email', 'jane@example.com'), e('identity:phone', '+52 000 000 0000'),
  e('identity:country', 'Mexico'), e('identity:location', 'Guadalajara, Mexico'), e('identity:resume', cv, 'file'),
  e('identity:linkedin', 'https://linkedin.com/in/x', 'text', true), e('identity:github', 'https://github.com/x', 'text', false),
  e('84467dbc', 'Yes', 'choice', true, 'answers'), e('6c450ee8', 'No', 'choice', true, 'answers'),
  e('aa11', 'Because\nreasons', 'textarea', false, 'draft'), e('bb22', 'No', 'select', false, 'answers'),
  e('e1__systemfield_eeoc_gender', 'Decline to self-identify', 'select', true, 'decline'),
]);

describe('ashbyFiller', () => {
  it('fills every field (yes/no buttons verified by aria-pressed, location, upload chip)', async () => {
    posted.length = 0;
    const page = await open('ashby-form.html');
    const r = await ashbyFiller.fill(page, ashbyPlan);
    expect(r.failed).toEqual([]);
    expect(r.requiredEmpty).toEqual([]);
    expect(r.notFound.sort()).toEqual(['identity:country', 'identity:firstName']);
    expect(await page.inputValue('[name="_systemfield_name"]')).toBe('Jane Doe');
    expect(await page.inputValue('[name="3a4f61e5"]')).toBe('+52 000 000 0000');
    expect(await page.inputValue('[name="f202d233"]')).toBe('https://linkedin.com/in/x');
    expect(await page.inputValue('[name="99fc6622"]')).toBe('https://github.com/x');
    expect(await page.inputValue('[role=combobox]')).toBe('Guadalajara, Jalisco, Mexico');
    expect(await page.locator('.file-chip').innerText()).toBe('cv.pdf');
    expect(await page.getAttribute('[name="84467dbc"] ~ button, [data-field-path="84467dbc"] button[data-option="yes"]', 'aria-pressed')).toBe('true');
    expect(await page.getAttribute('[data-field-path="84467dbc"] button[data-option="no"]', 'aria-pressed')).toBe('false');
    expect(await page.getAttribute('[data-field-path="6c450ee8"] button[data-option="no"]', 'aria-pressed')).toBe('true');
    expect(await page.inputValue('[name="aa11"]')).toBe('Because\nreasons');
    expect(await page.inputValue('[name="bb22"]')).toBe('No');
    expect(await page.isChecked('#g-1')).toBe(true);
    expect(allSorted(r)).toEqual(ashbyPlan.entries.map((x) => x.fieldId).sort());
    expect(posted).toEqual([]);
    await page.close();
  }, 60_000);

  it('reports a missing planned field and unanswered required yes/no', async () => {
    const page = await open('ashby-form.html');
    const r = await ashbyFiller.fill(page, P([e('identity:email', 'jane@example.com'), e('zz99', 'x', 'text', true, 'draft')]));
    expect(r.notFound).toContain('zz99');
    expect(r.requiredEmpty).toEqual(expect.arrayContaining(['Name', 'Able to work in our SF office?', 'Authorized to work in the US?']));
    await page.close();
  }, 60_000);

  it('never submits through typed newlines', async () => {
    posted.length = 0;
    const page = await open('ashby-form.html', '?norequired');
    await page.evaluate(() => { document.getElementById('app')!.setAttribute('onsubmit', 'fetch("/apply",{method:"POST"});return false'); });
    const r = await ashbyFiller.fill(page, P([e('identity:fullName', 'Jane\nDoe'), e('aa11', 'a\nb', 'textarea')]));
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);
    expect(r.filled.length).toBe(2);
    expect(await page.inputValue('[name="_systemfield_name"]')).toBe('Jane Doe');
    await page.close();
  }, 60_000);

  it('fill runs under guardFill', async () => {
    posted.length = 0;
    const page = await open('ashby-form.html', '?norequired');
    await page.evaluate(() => { document.querySelector('[name="_systemfield_name"]')!.addEventListener('input', () => { (document.getElementById('app') as HTMLFormElement).submit(); }); });
    await ashbyFiller.fill(page, P([e('identity:fullName', 'Jane Doe')]));
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);
    await page.close();
  }, 60_000);

  it('yes/no and select need an exact option; a failed upload fails; wrong-country location fails', async () => {
    const page = await open('ashby-form.html', '?uploadfail');
    const r = await ashbyFiller.fill(page, P([
      e('84467dbc', 'Y', 'choice'), e('6c450ee8', 'maybe', 'choice'), e('bb22', 'Yes,', 'select'), e('identity:resume', cv, 'file'), e('identity:location', 'Guadalajara, Peru'),
    ]));
    expect(r.failed).toEqual(['84467dbc', '6c450ee8', 'bb22', 'identity:resume', 'identity:location']);
    expect(await page.locator('button[aria-pressed="true"]').count()).toBe(0);
    await page.close();
  }, 60_000);

  it('submits and detects the confirmation with exactly one intercepted POST; ignores a pre-existing error', async () => {
    posted.length = 0;
    const page = await open('ashby-form.html', '?errorboundary');
    await ashbyFiller.fill(page, ashbyPlan);
    const out = await ashbyFiller.submit(page, 10_000);
    expect(out.kind).toBe('confirmed');
    expect(posted.length).toBe(1);
    await page.close();
  }, 60_000);
});
