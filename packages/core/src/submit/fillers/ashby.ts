/// <reference lib="dom" />
import type { Locator, Page } from 'playwright';
import type { AtsFiller, FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { chooseCombobox, fillText, oneLine, setFile } from '../dom';
import { URL_TITLES, byName, checkByLabel, cleanTitle, lastSegmentIs, norm, runFill, runSubmit, selectNativeVerified } from './common';

const SUBMIT = 'button.ashby-application-form-submit-button';
const ERROR_TEXT = /missing entry for required|form needs corrections|is required|there was an error|please (fix|correct|complete)|flagged as (possible )?spam|something went wrong/i;
const ERROR_SEL = '[role="alert"], [class*="error" i]';
const T = 5000;

/** The text input of the field entry whose (whole) title matches; returns its name-based selector. */
async function inputByTitle(page: Page, re: RegExp): Promise<string | null> {
  const entries = page.locator('[data-field-path]');
  const titles = await entries.evaluateAll((els) => els.map((el) => el.querySelector('label')?.textContent ?? ''));
  for (let i = 0; i < titles.length; i++) {
    if (!re.test(cleanTitle(titles[i]!))) continue;
    const input = entries.nth(i).locator('input[type="text"], input:not([type])').first();
    if (!(await input.count())) continue;
    const name = await input.getAttribute('name');
    if (name) return `input${byName(name)}`;
  }
  return null;
}

const planCountry = (plan: FillPlan): string => {
  const c = plan.entries.find((x) => x.fieldId === 'identity:country')?.value.trim();
  if (c) return c;
  const loc = plan.entries.find((x) => x.fieldId === 'identity:location')?.value ?? '';
  return loc.includes(',') ? loc.split(',').at(-1)!.trim() : '';
};

/**
 * Custom (non-system) place questions are unnamed widgets, so the scraped plan never holds them. Find the one entry whose title names a
 * location/country and whose only input is an unnamed combobox or select. `country`: the title or description mentions a country
 * (e.g. "Location — Country you're currently residing in"); `location`: a location title that does not. Returns its widget selector.
 */
async function customPlaceField(page: Page, kind: 'country' | 'location'): Promise<string | null> {
  const paths = await page.locator('[data-field-path]').evaluateAll((els, k) => els.filter((f) => {
    const path = f.getAttribute('data-field-path') ?? '';
    if (!path || path.startsWith('_systemfield_') || f.querySelector('input[name], select[name], textarea[name]')) return false;
    if (!f.querySelector('input[role="combobox"], select')) return false;
    const title = (f.querySelector('label')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const desc = (f.querySelector('[class*="description"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!/\b(location|country)\b/i.test(title)) return false;
    return /\bcountry\b/i.test(title + ' ' + desc) === (k === 'country');
  }).map((f) => f.getAttribute('data-field-path') ?? ''), kind);
  if (paths.length !== 1) return null;
  const box = `[data-field-path="${paths[0]!.replace(/["\\]/g, '\\$&')}"]`;
  return (await page.locator(`${box} input[role="combobox"]`).count()) ? `${box} input[role="combobox"]` : `${box} select`;
}

/** Country only, exact option (alias-aware read-back via lastSegmentIs); no option means failed, never a guess. */
async function chooseCountry(page: Page, sel: string, country: string): Promise<boolean> {
  if (!country) return false;
  if (sel.endsWith(' select')) {
    const labels = await page.locator(sel).first().evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => o.label)).catch(() => [] as string[]);
    const exact = labels.find((l) => norm(l) === norm(country));
    return exact ? selectNativeVerified(page, sel, exact) : false;
  }
  return chooseCombobox(page, sel, country, { accept: (t) => lastSegmentIs(t, country) });
}

async function fillLocation(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  let sel = '[data-field-path="_systemfield_location"] input[role="combobox"]';
  if (!(await page.locator(sel).count())) {
    const custom = await customPlaceField(page, 'location');
    if (!custom) return null;
    if (custom.endsWith(' select')) return chooseCountry(page, custom, planCountry(plan));
    sel = custom;
  }
  const city = oneLine(e.value.split(',')[0]!);
  const country = planCountry(plan);
  if (!city || !country) return false;
  if (await chooseCombobox(page, sel, city, { allowContains: true, accept: (t) => lastSegmentIs(t, country) })) return true;
  // some boards ask "What country are you based in?": the list holds countries only, so retry with the country (exact option match)
  return chooseCombobox(page, sel, country, { accept: (t) => lastSegmentIs(t, country) });
}

async function fillIdentity(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  if (!e.value.trim()) return null;
  switch (e.fieldId) {
    case 'identity:fullName': return (await page.locator('[name="_systemfield_name"]').count()) ? fillText(page, '[name="_systemfield_name"]', e.value) : null;
    case 'identity:email': return (await page.locator('[name="_systemfield_email"]').count()) ? fillText(page, '[name="_systemfield_email"]', e.value) : null;
    case 'identity:phone': {
      for (const s of ['[name="_systemfield_phone"]', 'input[type="tel"]']) if (await page.locator(s).count()) return fillText(page, s, e.value);
      return null;
    }
    case 'identity:location': return fillLocation(page, plan, e);
    case 'identity:country': {
      const sel = await customPlaceField(page, 'country');
      return sel ? chooseCountry(page, sel, oneLine(e.value)) : null;
    }
    case 'identity:resume': return (await page.locator('input#_systemfield_resume').count()) ? setFile(page, 'input#_systemfield_resume', e.value) : null;
    default: {
      const key = URL_TITLES[e.fieldId];
      const sel = key ? await inputByTitle(page, key) : null;
      return sel ? fillText(page, sel, e.value) : null; // no first/last name, country, company or cover letter fields on Ashby
    }
  }
}

/** Yes/No questions are two buttons next to a hidden checkbox named by the field id. Read aria-pressed back. */
async function clickYesNo(container: Locator, value: string): Promise<boolean> {
  try {
    const btns = container.locator('button');
    const texts = (await btns.allInnerTexts()).map(norm);
    const idx = texts.indexOf(norm(value));
    if (idx < 0) return false;
    await btns.nth(idx).click({ timeout: T });
    const pressed = await btns.evaluateAll((els) => els.map((el) => el.getAttribute('aria-pressed') === 'true' || /(^|\s|_)(selected|active|checked)(\s|_|$)/.test(el.className)));
    return pressed[idx] === true && pressed.filter(Boolean).length === 1;
  } catch { return false; }
}

/**
 * Radio/checkbox groups are named `<entryId>_<fieldPath>` and the entryId prefix is regenerated on every render, so a name scraped
 * at extraction time is stale on the next load. Resolve it through the field path: the one `[data-field-path]` entry the id ends with,
 * whose inputs all share one name ending in `_<fieldPath>`. Anything ambiguous resolves to nothing.
 */
async function currentName(page: Page, fieldId: string): Promise<string> {
  if (await page.locator(byName(fieldId)).count()) return fieldId;
  const resolved = await page.evaluate((id) => {
    const paths = Array.from(document.querySelectorAll('[data-field-path]')).map((el) => el.getAttribute('data-field-path') ?? '')
      .filter((p) => p && id.length > p.length + 1 && id.endsWith('_' + p));
    if (!paths.length) return null;
    const path = paths.sort((a, b) => b.length - a.length)[0]!;
    const boxes = Array.from(document.querySelectorAll('[data-field-path]')).filter((el) => el.getAttribute('data-field-path') === path);
    if (boxes.length !== 1) return null;
    const names = new Set(Array.from(boxes[0]!.querySelectorAll('input[type="radio"][name], input[type="checkbox"][name]'))
      .map((el) => el.getAttribute('name') ?? '').filter((n) => n.endsWith('_' + path)));
    return names.size === 1 ? [...names][0]! : null;
  }, fieldId).catch(() => null);
  return resolved ?? fieldId;
}

async function fillCustom(page: Page, e: FillEntry): Promise<boolean | null> {
  const name = await currentName(page, e.fieldId);
  const s = `${byName(name)}, input[type="file"][id="${e.fieldId.replace(/["\\]/g, '\\$&')}"]`;
  const first = page.locator(s).first();
  if (!(await page.locator(s).count())) return null;
  const { tag, type, hasButtons } = await first.evaluate((el) => ({
    tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase(),
    hasButtons: !!el.parentElement?.querySelector('button[aria-pressed], button[data-option]'),
  }));
  const sole = byName(name);
  if (tag === 'select') return selectNativeVerified(page, sole, e.value);
  if (type === 'file') return setFile(page, s, e.value);
  if (type === 'checkbox' && hasButtons) return clickYesNo(first.locator('xpath=..'), e.value);
  if (type === 'radio') return checkByLabel(page, page.locator(`input[type="radio"]${sole}`), [e.value.trim()]);
  if (type === 'checkbox') {
    const group = page.locator(`input[type="checkbox"]${sole}`);
    if ((await group.count()) > 1) {
      const whole = e.value.trim();
      const values = e.options?.some((o) => norm(o) === norm(whole)) ? [whole] : e.value.split(';').map((x) => x.trim()).filter(Boolean);
      return checkByLabel(page, group, values);
    }
    const on = /^(true|yes|1|on)$/i.test(e.value.trim());
    if (!on && !/^(false|no|0|off)$/i.test(e.value.trim())) return checkByLabel(page, group, [e.value.trim()]);
    try { await group.first().setChecked(on, { timeout: T }); return (await group.first().isChecked()) === on; } catch { return false; }
  }
  if (e.kind === 'choice') return clickYesNo(first.locator('xpath=..'), e.value);
  return fillText(page, sole, e.value);
}

/**
 * Visible field entries whose title carries Ashby's required marker but hold no value. Ashby marks many required questions only on the
 * label: Yes/No buttons (hidden checkbox), radio groups, unnamed autocomplete comboboxes. Entries with a required/aria-required input are
 * left to the generic check (no duplicates). Plain string: no __name from tsx.
 */
const REQUIRED_ENTRIES_JS = `(() => Array.from(document.querySelectorAll('[data-field-path]')).filter((f) => {
  const title = f.querySelector('label');
  if (!title || !/required/i.test(title.className)) return false;
  if (f.querySelector('input[required], textarea[required], select[required], [aria-required="true"]')) return false;
  const b = f.getBoundingClientRect(); const s = getComputedStyle(f);
  if (s.display === 'none' || s.visibility === 'hidden' || (b.width === 0 && b.height === 0)) return false;
  if (f.querySelector('button[aria-pressed="true"]')) return false;
  if ((f.querySelector('[class*="single-value"], [class*="singleValue"]')?.textContent ?? '').trim()) return false;
  return !Array.from(f.querySelectorAll('input, textarea, select')).some((i) => {
    const t = (i.getAttribute('type') ?? '').toLowerCase();
    if (t === 'hidden' || t === 'button' || t === 'submit') return false;
    if (t === 'radio' || t === 'checkbox') return i.checked;
    if (t === 'file') return (i.files?.length ?? 0) > 0;
    return !!(i.value ?? '').trim();
  });
}).map((f) => (f.querySelector('label')?.textContent ?? '').replace(/\\s+/g, ' ').replace(/[*✱]+\\s*$/, '').trim()))()`;

export const ashbyFiller: AtsFiller = {
  kind: 'ashby',
  formUrl: (t) => `https://jobs.ashbyhq.com/${t.atsToken}/${t.atsJobId}/application`,

  async fill(page: Page, plan: FillPlan): Promise<FilledReport> {
    return runFill(page, plan, plan.entries, (e) => (e.fieldId.startsWith('identity:') ? fillIdentity(page, plan, e) : fillCustom(page, e)),
      (p) => p.evaluate(REQUIRED_ENTRIES_JS) as Promise<string[]>);
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    return runSubmit(page, timeoutMs, { submitSelector: SUBMIT, errorText: ERROR_TEXT, errorSelector: ERROR_SEL });
  },
};
