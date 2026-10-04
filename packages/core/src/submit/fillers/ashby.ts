/// <reference lib="dom" />
import type { Locator, Page } from 'playwright';
import type { AtsFiller, FillEntry, FillPlan, FilledReport, SubmitOutcome } from '../types';
import { chooseCombobox, fillText, oneLine, setFile } from '../dom';
import { byName, checkByLabel, lastSegmentIs, norm, runFill, runSubmit, selectNativeVerified } from './common';

const SUBMIT = 'button.ashby-application-form-submit-button';
const ERROR_TEXT = /missing entry for required|form needs corrections|is required|there was an error|please (fix|correct|complete)|flagged as (possible )?spam|something went wrong/i;
const ERROR_SEL = '[role="alert"], [class*="error" i]';
const T = 5000;

const LABEL_KEYS: Record<string, RegExp> = {
  'identity:linkedin': /linkedin/i, 'identity:github': /github/i, 'identity:portfolio': /portfolio|website/i,
};

/** The text input of the field entry whose title matches; returns its name-based selector. */
async function inputByTitle(page: Page, re: RegExp): Promise<string | null> {
  const entry = page.locator('[data-field-path]').filter({ has: page.locator('label', { hasText: re }) });
  const input = entry.locator('input[type="text"], input:not([type])').first();
  if (!(await input.count())) return null;
  const name = await input.getAttribute('name');
  return name ? `input${byName(name)}` : null;
}

async function fillLocation(page: Page, plan: FillPlan, e: FillEntry): Promise<boolean | null> {
  const sel = '[data-field-path="_systemfield_location"] input[role="combobox"]';
  if (!(await page.locator(sel).count())) return null;
  const city = oneLine(e.value.split(',')[0]!);
  const planCountry = plan.entries.find((x) => x.fieldId === 'identity:country')?.value.trim();
  const country = planCountry || (e.value.includes(',') ? e.value.split(',').at(-1)!.trim() : '');
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
    case 'identity:resume': return (await page.locator('input#_systemfield_resume').count()) ? setFile(page, 'input#_systemfield_resume', e.value) : null;
    default: {
      const key = LABEL_KEYS[e.fieldId];
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

async function fillCustom(page: Page, e: FillEntry): Promise<boolean | null> {
  const s = `${byName(e.fieldId)}, input[type="file"][id="${e.fieldId.replace(/["\\]/g, '\\$&')}"]`;
  const first = page.locator(s).first();
  if (!(await page.locator(s).count())) return null;
  const { tag, type, hasButtons } = await first.evaluate((el) => ({
    tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase(),
    hasButtons: !!el.parentElement?.querySelector('button[aria-pressed], button[data-option]'),
  }));
  const sole = byName(e.fieldId);
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

/** Required Yes/No questions with neither button pressed (their hidden checkbox carries no `required`). Plain string: no __name from tsx. */
const REQUIRED_YESNO_JS = `(() => Array.from(document.querySelectorAll('[data-field-path]')).filter((f) => f.querySelector('button[aria-pressed]') && f.querySelector('label[class*="required"]') && !f.querySelector('button[aria-pressed="true"]')).map((f) => (f.querySelector('label')?.textContent ?? '').replace(/\\s+/g, ' ').trim()))()`;

export const ashbyFiller: AtsFiller = {
  kind: 'ashby',
  formUrl: (t) => `https://jobs.ashbyhq.com/${t.atsToken}/${t.atsJobId}/application`,

  async fill(page: Page, plan: FillPlan): Promise<FilledReport> {
    return runFill(page, plan, plan.entries, (e) => (e.fieldId.startsWith('identity:') ? fillIdentity(page, plan, e) : fillCustom(page, e)),
      (p) => p.evaluate(REQUIRED_YESNO_JS) as Promise<string[]>);
  },

  async submit(page: Page, timeoutMs: number): Promise<SubmitOutcome> {
    return runSubmit(page, timeoutMs, { submitSelector: SUBMIT, errorText: ERROR_TEXT, errorSelector: ERROR_SEL });
  },
};
